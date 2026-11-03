import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

export interface MockStats {
  requests: number;
  active: number;
  maxActive: number;
  log: { method: string; path: string; range?: string }[];
}

export interface MockServer {
  url: string;
  port: number;
  stats: MockStats;
  close(): Promise<void>;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, stats: MockStats) => void | Promise<void>;

export async function startMock(handler: Handler): Promise<MockServer> {
  const stats: MockStats = { requests: 0, active: 0, maxActive: 0, log: [] };
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    stats.requests++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    stats.log.push({ method: req.method ?? "GET", path: req.url ?? "", range: req.headers.range });
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        stats.active--;
      }
    };
    res.on("close", finish);
    Promise.resolve(handler(req, res, stats)).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface ServeOptions {
  ranges?: boolean;
  delayMs?: number;
  /** Destroy the connection after this many body bytes (simulates a dropped connection). */
  dropAfter?: number;
  /** Throttle the body to roughly this many bytes per second. */
  bytesPerSecond?: number;
  chunk?: number;
}

/** Serve a buffer with optional Range support, latency, throttling and mid-body disconnects. */
export async function serveBytes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  data: Buffer,
  options: ServeOptions = {},
): Promise<void> {
  const supportsRanges = options.ranges !== false;
  if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  let start = 0;
  let end = data.length - 1;
  let status = 200;
  const header = req.headers.range;
  const headers: Record<string, string | number> = { "content-type": "application/octet-stream" };
  if (supportsRanges) headers["accept-ranges"] = "bytes";
  if (supportsRanges && header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (match) {
      if (match[1] === "" && match[2] !== "") {
        start = Math.max(0, data.length - Number(match[2]));
      } else {
        start = Number(match[1]);
        if (match[2] !== "") end = Math.min(end, Number(match[2]));
      }
      if (start >= data.length) {
        res.writeHead(416, { "content-range": `bytes */${data.length}` });
        res.end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
    }
  }
  const body = data.subarray(start, end + 1);
  headers["content-length"] = body.length;
  if (req.method === "HEAD") {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, headers);
  const chunk = options.chunk ?? 64 * 1024;
  let sent = 0;
  while (sent < body.length) {
    if (options.dropAfter !== undefined && sent >= options.dropAfter) {
      res.destroy();
      return;
    }
    let size = Math.min(chunk, body.length - sent);
    if (options.dropAfter !== undefined) size = Math.min(size, options.dropAfter - sent);
    const piece = body.subarray(sent, sent + size);
    if (!res.write(piece)) await new Promise((resolve) => res.once("drain", resolve));
    sent += size;
    if (options.bytesPerSecond) await new Promise((resolve) => setTimeout(resolve, (size / options.bytesPerSecond!) * 1000));
  }
  res.end();
}

export function sha1(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Deterministic pseudo-random bytes so tests are reproducible. */
export function bytes(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}
