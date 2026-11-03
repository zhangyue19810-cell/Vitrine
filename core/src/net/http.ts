import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import { AbortError } from "../util/async";

export class HttpError extends Error {
  readonly name = "HttpError";
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodyPreview = "",
    readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} for ${url}${bodyPreview ? `: ${bodyPreview.slice(0, 160)}` : ""}`);
  }
}

export class NetworkError extends Error {
  readonly name = "NetworkError";
  constructor(
    message: string,
    readonly code?: string,
    readonly url?: string,
  ) {
    super(message);
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Time allowed until response headers arrive (connect + request + first byte). */
  timeoutMs?: number;
  method?: string;
  body?: string | Buffer;
  maxRedirects?: number;
  /** Decode gzip/deflate/br bodies. Defaults to true. Downloads of binaries never ask for compression. */
  decompress?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  url: string;
  body: Readable;
}

export interface HttpClientOptions {
  userAgent: string;
  /** Return a proxy URL (e.g. "http://127.0.0.1:7890") for this request, or nothing for a direct connection. */
  getProxy?: (url: string) => string | null | undefined;
  /** Idle socket timeout while the body is streaming. */
  idleTimeoutMs?: number;
  headersTimeoutMs?: number;
  maxSockets?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export class HttpClient {
  private readonly httpsAgent: https.Agent;
  private readonly httpAgent: http.Agent;
  private readonly proxyAgents = new Map<string, https.Agent>();
  readonly userAgent: string;

  constructor(private readonly options: HttpClientOptions) {
    this.userAgent = options.userAgent;
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets: options.maxSockets ?? 256,
      maxFreeSockets: 64,
      scheduling: "lifo" as const,
    };
    this.httpsAgent = new https.Agent(agentOptions);
    this.httpAgent = new http.Agent(agentOptions);
  }

  destroy() {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
    for (const agent of this.proxyAgents.values()) agent.destroy();
  }

  private agentFor(url: URL): http.Agent | https.Agent {
    if (url.protocol === "http:") return this.httpAgent;
    const proxy = this.options.getProxy?.(url.toString());
    if (!proxy) return this.httpsAgent;
    let agent = this.proxyAgents.get(proxy);
    if (!agent) {
      agent = new HttpsProxyAgent(proxy, { keepAlive: true, maxSockets: 128 });
      this.proxyAgents.set(proxy, agent);
    }
    return agent;
  }

  /** Perform a request and follow redirects. 4xx/5xx statuses are returned, not thrown. */
  async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
    const maxRedirects = options.maxRedirects ?? 8;
    let current = url;
    let method = options.method ?? "GET";
    let body = options.body;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = value;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const response = await this.once(current, method, headers, body, options);
      const location = response.headers.location;
      if (REDIRECTS.has(response.status) && location) {
        response.body.destroy();
        const next = new URL(location, current).toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          delete headers["content-type"];
          delete headers["content-length"];
        }
        if (new URL(next).origin !== new URL(current).origin) {
          delete headers["authorization"];
          delete headers["x-api-key"];
        }
        current = next;
        continue;
      }
      return response;
    }
    throw new NetworkError(`Too many redirects for ${url}`, "ERR_TOO_MANY_REDIRECTS", url);
  }

  private once(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    options: HttpOptions,
  ): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      if (options.signal?.aborted) return reject(new AbortError());
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return reject(new NetworkError(`Invalid URL: ${url}`, "ERR_INVALID_URL", url));
      }
      const transport = target.protocol === "http:" ? http : https;
      const requestHeaders: Record<string, string> = {
        "user-agent": this.userAgent,
        accept: "*/*",
        ...headers,
      };
      if (body !== undefined) requestHeaders["content-length"] = String(Buffer.byteLength(body));
      const request = transport.request(
        target,
        { method, headers: requestHeaders, agent: this.agentFor(target) },
        (res) => {
          clearTimeout(headerTimer);
          request.setTimeout(this.options.idleTimeoutMs ?? 30_000);
          let stream: Readable = res;
          const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
          if (options.decompress !== false && encoding && encoding !== "identity") {
            const decoder =
              encoding === "gzip" || encoding === "x-gzip"
                ? zlib.createGunzip()
                : encoding === "deflate"
                  ? zlib.createInflate()
                  : encoding === "br"
                    ? zlib.createBrotliDecompress()
                    : undefined;
            if (decoder) {
              res.on("error", (error) => decoder.destroy(error));
              decoder.on("close", () => res.destroy());
              stream = res.pipe(decoder);
              delete res.headers["content-length"];
            }
          }
          options.signal?.removeEventListener("abort", onAbort);
          const onBodyAbort = () => stream.destroy(new AbortError());
          options.signal?.addEventListener("abort", onBodyAbort, { once: true });
          stream.once("close", () => options.signal?.removeEventListener("abort", onBodyAbort));
          resolve({ status: res.statusCode ?? 0, headers: res.headers, url, body: stream });
        },
      );
      const headerTimer = setTimeout(() => {
        request.destroy(new NetworkError(`Timed out waiting for ${target.host}`, "ETIMEDOUT", url));
      }, options.timeoutMs ?? this.options.headersTimeoutMs ?? 30_000);
      const onAbort = () => request.destroy(new AbortError());
      options.signal?.addEventListener("abort", onAbort, { once: true });
      request.on("timeout", () => request.destroy(new NetworkError(`Connection to ${target.host} went idle`, "ETIMEDOUT", url)));
      request.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(headerTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error instanceof AbortError || error instanceof NetworkError) return reject(error);
        reject(new NetworkError(error.message, error.code, url));
      });
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  async getBuffer(url: string, options: HttpOptions = {}): Promise<Buffer> {
    const response = await this.request(url, options);
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(response.status, url, data.toString("utf8", 0, 200), parseRetryAfter(response.headers["retry-after"]));
    }
    return data;
  }

  async getText(url: string, options: HttpOptions = {}): Promise<string> {
    const data = await this.getBuffer(url, {
      ...options,
      headers: { "accept-encoding": "gzip", ...options.headers },
    });
    return data.toString("utf8").replace(/^﻿/, "");
  }

  async getJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
    const text = await this.getText(url, { ...options, headers: { accept: "application/json", ...options.headers } });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NetworkError(`Invalid JSON from ${url}`, "ERR_BAD_JSON", url);
    }
  }

  async postJson<T = unknown>(url: string, payload: unknown, options: HttpOptions = {}): Promise<T> {
    const text = await this.getText(url, {
      ...options,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { accept: "application/json", "content-type": "application/json", ...options.headers },
    });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async postForm<T = unknown>(url: string, form: Record<string, string>, options: HttpOptions = {}): Promise<T> {
    const text = await this.getText(url, {
      ...options,
      method: "POST",
      body: new URLSearchParams(form).toString(),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...options.headers },
    });
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export { parseRetryAfter };
