import type { HttpClient } from "../net/http";
import { HttpError } from "../net/http";
import type { SourceRouter } from "../net/sources";
import { isAbort, sleep } from "../util/async";
import { nullLog, type ScopedLog } from "../util/log";

export interface ApiDeps {
  http: HttpClient;
  router: SourceRouter;
  log?: ScopedLog;
}

export interface ApiRequest {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Only send these headers to the official host (API keys must not leak to mirrors). */
  officialHeaders?: Record<string, string>;
  /** When false the official host is skipped (e.g. CurseForge without an API key). */
  officialUsable?: boolean;
}

/**
 * JSON API call with source failover: tries the official API and its mirror in the order the user's content
 * policy asks for, moving on after network errors, 5xx and 429 responses, but not after 4xx answers.
 */
export async function apiJson<T>(deps: ApiDeps, url: string, request: ApiRequest = {}): Promise<T> {
  const log = deps.log ?? nullLog;
  const official = new URL(url).host;
  let candidates = deps.router.contentCandidates(url);
  if (request.officialUsable === false) {
    const mirrors = candidates.filter((candidate) => new URL(candidate).host !== official);
    if (!mirrors.length) throw new Error("No usable source for this request (an API key is required for the official service)");
    candidates = mirrors;
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    const isOfficial = new URL(candidate).host === official;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const options = {
          signal: request.signal,
          timeoutMs: 20_000,
          headers: { ...(request.headers ?? {}), ...(isOfficial ? (request.officialHeaders ?? {}) : {}) },
        };
        if (request.method === "POST" || request.body !== undefined) return await deps.http.postJson<T>(candidate, request.body, options);
        return await deps.http.getJson<T>(candidate, options);
      } catch (error) {
        if (isAbort(error)) throw error;
        lastError = error;
        if (error instanceof HttpError) {
          if (error.status === 429 && attempt === 1) {
            await sleep(Math.min(error.retryAfterMs ?? 1500, 5000), request.signal);
            continue;
          }
          if (error.status >= 400 && error.status < 500 && error.status !== 429 && error.status !== 408) throw error; // a real answer
        }
        log.warn(`${candidate} failed: ${(error as Error).message}`);
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}
