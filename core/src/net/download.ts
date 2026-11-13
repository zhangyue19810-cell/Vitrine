import { createHash, type Hash } from "node:crypto";
import { chmod, open, rm, stat, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { basename, dirname } from "node:path";
import { HttpClient, HttpError, NetworkError, parseRetryAfter, type HttpResponse } from "./http";
import { RateLimiter } from "./throttle";
import { AbortError, anySignal, isAbort, sleep, throwIfAborted } from "../util/async";
import { ensureDir, fileSize, hashFile, replaceFile, type HashAlgorithm } from "../util/fsx";

export interface HashSpec {
  sha1?: string;
  sha256?: string;
  sha512?: string;
  md5?: string;
}

export interface DownloadItem {
  /** Candidate URLs in priority order (official/mirror already arranged by the SourceRouter). */
  urls: string[];
  dest: string;
  size?: number;
  hash?: HashSpec;
  /** Short name shown in the UI. Defaults to the file name. */
  label?: string;
  group?: string;
  /** Unix mode applied after download (executables from Mojang's Java runtime). */
  mode?: number;
  /** Preferred number of range connections for this file (overrides the global segment setting). */
  segments?: number;
  /** How an existing file is judged valid: "size" (default, fast) or "hash" (reads the file). */
  verify?: "size" | "hash";
  /** A failure of an optional item is reported but does not fail the run. */
  optional?: boolean;
}

export type LaneStateName = "idle" | "connecting" | "downloading" | "verifying" | "retrying";

export interface LaneState {
  lane: number;
  state: LaneStateName;
  label: string;
  host: string;
  received: number;
  total: number;
  /** Parallel connections used for this file (segmented download). */
  parts: number;
  attempt: number;
}

export interface Progress {
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  failedFiles: number;
  bytesTotal: number;
  bytesDone: number;
  /** Smoothed bytes per second. */
  speed: number;
  /** Seconds remaining, if it can be estimated. */
  eta: number | null;
  elapsedMs: number;
  lanes: LaneState[];
}

export interface FileEvent {
  item: DownloadItem;
  status: "done" | "skipped" | "failed";
  error?: string;
}

export interface RunOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  progressIntervalMs?: number;
  onFile?: (event: FileEvent) => void;
  /** Abort the whole run on the first non-optional failure. */
  failFast?: boolean;
}

export interface RunResult {
  ok: boolean;
  cancelled: boolean;
  downloaded: number;
  skipped: number;
  failed: { item: DownloadItem; error: string }[];
  bytes: number;
  elapsedMs: number;
}

export interface EngineSettings {
  concurrency: number;
  /** Parallel connections for one large file. */
  segments: number;
  segmentMinSize: number;
  retries: number;
  /** Bytes per second; 0 for unlimited. */
  speedLimit: number;
  requestTimeoutMs: number;
  /** Abort an attempt when its socket stops delivering bytes for this long. */
  stallTimeoutMs: number;
  backoffBaseMs: number;
}

export const DEFAULT_ENGINE: EngineSettings = {
  concurrency: 64,
  segments: 8,
  segmentMinSize: 1 * 1024 * 1024,
  retries: 3,
  speedLimit: 0,
  requestTimeoutMs: 30_000,
  stallTimeoutMs: 15_000,
  backoffBaseMs: 400,
};

class VerifyError extends Error {
  readonly name = "VerifyError";
}
class RetryableError extends Error {
  readonly name = "RetryableError";
}

const HASH_ORDER: HashAlgorithm[] = ["sha512", "sha256", "sha1", "md5"];

function pickHash(spec?: HashSpec): [HashAlgorithm, string] | undefined {
  if (!spec) return undefined;
  for (const algorithm of HASH_ORDER) {
    const value = spec[algorithm];
    if (value) return [algorithm, value.toLowerCase()];
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Remembers failed hosts and the measured throughput of healthy ones. */
class HostHealth {
  private fails = new Map<string, { count: number; until: number }>();
  private speeds = new Map<string, number>();
  private turns = new Map<string, number>();

  order(urls: string[]): string[] {
    if (urls.length < 2) return urls;
    const now = Date.now();
    const healthy: string[] = [];
    const tripped: string[] = [];
    for (const url of urls) {
      const entry = this.fails.get(hostOf(url));
      (entry && entry.until > now ? tripped : healthy).push(url);
    }
    const ranked = [...healthy].sort((a, b) => (this.speeds.get(hostOf(b)) ?? 0) - (this.speeds.get(hostOf(a)) ?? 0));
    // Keep sampling the alternative source even after the first host is measured. This lets the
    // mirror win on a fast link and the official CDN win where the mirror is slow.
    const key = ranked.map(hostOf).join("|");
    const turn = this.turns.get(key) ?? 0;
    this.turns.set(key, turn + 1);
    if (ranked.length > 1 && turn % 6 === 5) [ranked[0], ranked[1]] = [ranked[1], ranked[0]];
    return [...ranked, ...tripped];
  }

  ok(url: string) {
    this.fails.delete(hostOf(url));
  }

  record(url: string, bytes: number, elapsedMs: number) {
    if (bytes <= 0 || elapsedMs < 250) return;
    const host = hostOf(url);
    const speed = bytes / (elapsedMs / 1000);
    const previous = this.speeds.get(host);
    this.speeds.set(host, previous === undefined ? speed : previous * 0.6 + speed * 0.4);
  }

  fail(url: string) {
    const host = hostOf(url);
    const entry = this.fails.get(host) ?? { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= 4) entry.until = Date.now() + 30_000;
    this.fails.set(host, entry);
  }
}

interface Counted {
  bytes: number;
  discovered: number;
}

interface RunContext {
  cfg: EngineSettings;
  signal: AbortSignal;
  bytesTotal: number;
  bytesDone: number;
  addBytes(n: number): void;
  discover(n: number): void;
}

const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 410, 451]);

function isFatalForUrl(error: unknown): boolean {
  return error instanceof HttpError && FATAL_STATUS.has(error.status);
}

export class DownloadEngine {
  private readonly limiter: RateLimiter;
  private readonly health = new HostHealth();

  constructor(
    readonly http: HttpClient,
    private readonly settings: () => EngineSettings = () => DEFAULT_ENGINE,
  ) {
    this.limiter = new RateLimiter(() => this.settings().speedLimit);
  }

  /** Download everything with N parallel lanes. Never throws for per-file failures. */
  async run(input: DownloadItem[], options: RunOptions = {}): Promise<RunResult> {
    const cfg = { ...DEFAULT_ENGINE, ...this.settings() };
    const started = Date.now();
    const seen = new Map<string, DownloadItem>();
    for (const item of input) {
      const existing = seen.get(item.dest);
      if (existing) {
        for (const url of item.urls) if (!existing.urls.includes(url)) existing.urls.push(url);
      } else seen.set(item.dest, { ...item, urls: [...item.urls] });
    }
    const items = [...seen.values()];
    const internal = new AbortController();
    const signal = anySignal(options.signal, internal.signal);

    const progress: Progress = {
      totalFiles: items.length,
      doneFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      bytesTotal: items.reduce((sum, item) => sum + (item.size ?? 0), 0),
      bytesDone: 0,
      speed: 0,
      eta: null,
      elapsedMs: 0,
      lanes: [],
    };
    const ctx: RunContext = {
      cfg,
      signal,
      get bytesTotal() {
        return progress.bytesTotal;
      },
      get bytesDone() {
        return progress.bytesDone;
      },
      addBytes: (n) => {
        progress.bytesDone += n;
      },
      discover: (n) => {
        progress.bytesTotal += n;
      },
    } as RunContext;

    const result: RunResult = { ok: true, cancelled: false, downloaded: 0, skipped: 0, failed: [], bytes: 0, elapsedMs: 0 };
    const laneCount = Math.max(1, Math.min(options.concurrency ?? cfg.concurrency, items.length || 1));
    const lanes: LaneState[] = Array.from({ length: laneCount }, (_, lane) => ({
      lane,
      state: "idle",
      label: "",
      host: "",
      received: 0,
      total: 0,
      parts: 1,
      attempt: 0,
    }));

    let lastBytes = 0;
    let lastTick = performance.now();
    const emit = () => {
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      if (dt >= 0.2) {
        const instant = Math.max(0, (progress.bytesDone - lastBytes) / dt);
        progress.speed = progress.speed === 0 ? instant : progress.speed * 0.6 + instant * 0.4;
        lastBytes = progress.bytesDone;
        lastTick = now;
      }
      progress.elapsedMs = Date.now() - started;
      progress.eta =
        progress.speed > 1 && progress.bytesTotal > progress.bytesDone
          ? (progress.bytesTotal - progress.bytesDone) / progress.speed
          : null;
      progress.lanes = lanes.map((lane) => ({ ...lane }));
      options.onProgress?.({ ...progress });
    };
    const ticker = options.onProgress ? setInterval(emit, options.progressIntervalMs ?? 100) : undefined;
    ticker?.unref?.();

    let cursor = 0;
    const worker = async (lane: LaneState) => {
      while (!signal.aborted) {
        const index = cursor++;
        if (index >= items.length) break;
        const item = items[index];
        lane.label = item.label ?? basename(item.dest);
        lane.received = 0;
        lane.total = item.size ?? 0;
        lane.parts = 1;
        lane.attempt = 0;
        try {
          const outcome = await this.downloadOne(item, lane, ctx);
          if (outcome === "skipped") {
            progress.skippedFiles++;
            result.skipped++;
            if (item.size) progress.bytesDone += item.size;
          } else {
            progress.doneFiles++;
            result.downloaded++;
          }
          options.onFile?.({ item, status: outcome });
        } catch (error) {
          if (isAbort(error) || signal.aborted) break;
          const message = error instanceof Error ? error.message : String(error);
          result.failed.push({ item, error: message });
          progress.failedFiles++;
          // The bytes of a failed file never arrive; keep the bar honest.
          if (item.size) progress.bytesTotal -= item.size;
          options.onFile?.({ item, status: "failed", error: message });
          if (options.failFast && !item.optional) internal.abort();
        } finally {
          lane.state = "idle";
        }
      }
    };

    try {
      await Promise.all(lanes.map((lane) => worker(lane)));
    } finally {
      if (ticker) clearInterval(ticker);
    }
    result.cancelled = Boolean(options.signal?.aborted);
    result.bytes = progress.bytesDone;
    result.elapsedMs = Date.now() - started;
    result.ok = !result.cancelled && result.failed.every((failure) => failure.item.optional) && !(internal.signal.aborted && result.failed.length > 0);
    lanes.forEach((lane) => (lane.state = "idle"));
    emit();
    return result;
  }

  /** Like run() but throws if the run was cancelled or any required file failed. */
  async runOrThrow(items: DownloadItem[], options: RunOptions = {}): Promise<RunResult> {
    const result = await this.run(items, options);
    if (result.cancelled) throw new AbortError();
    const required = result.failed.filter((failure) => !failure.item.optional);
    if (required.length) {
      const first = required[0];
      throw new Error(
        `${required.length} file(s) failed to download; first: ${first.item.label ?? basename(first.item.dest)} — ${first.error}`,
      );
    }
    return result;
  }

  /** Which of these files are missing or damaged? Used by "verify and repair". */
  async findInvalid(
    items: DownloadItem[],
    mode: "size" | "hash" = "size",
    options: { concurrency?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<DownloadItem[]> {
    const invalid: DownloadItem[] = [];
    let done = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(options.concurrency ?? 16, items.length || 1) }, async () => {
      while (true) {
        throwIfAborted(options.signal);
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index];
        if (!(await this.isValid({ ...item, verify: mode }))) invalid.push(item);
        options.onProgress?.(++done, items.length);
      }
    });
    await Promise.all(workers);
    return invalid;
  }

  private async isValid(item: DownloadItem): Promise<boolean> {
    const size = await fileSize(item.dest);
    if (size === undefined) return false;
    if (item.size !== undefined && size !== item.size) return false;
    const hash = pickHash(item.hash);
    if (hash && (item.verify === "hash" || item.size === undefined)) {
      return (await hashFile(item.dest, hash[0])).toLowerCase() === hash[1];
    }
    return true;
  }

  private async downloadOne(item: DownloadItem, lane: LaneState, ctx: RunContext): Promise<"done" | "skipped"> {
    if (!item.urls.length) throw new Error(`No download URL for ${item.dest}`);
    if (await this.isValid(item)) return "skipped";
    await ensureDir(dirname(item.dest));
    const cfg = ctx.cfg;
    let lastError: unknown;
    const urls = this.health.order(item.urls);
    const canSegment = item.size !== undefined && item.size >= cfg.segmentMinSize && (item.segments ?? cfg.segments) > 1;
    // Level 1 is multi-range. If that cannot finish, the same source gets one plain-stream
    // Level 2 chance before Level 3 switches to the next mirror.
    const phases: ("segmented" | "single")[] = canSegment ? ["segmented", "single"] : ["single"];
    for (let u = 0; u < urls.length; u++) {
      const url = urls[u];
      const tmp = `${item.dest}.vtmp`;
      const urlStarted = Date.now();
      if (u > 0) await rm(tmp, { force: true }); // never resume across different servers
      phaseLoop: for (const phase of phases) {
        for (let attempt = 1; attempt <= cfg.retries; attempt++) {
          throwIfAborted(ctx.signal);
          lane.state = attempt > 1 ? "retrying" : "connecting";
          lane.attempt = attempt;
          lane.host = hostOf(url);
          lane.received = 0;
          lane.parts = 1;
          const counted: Counted = { bytes: 0, discovered: 0 };
          const stall = new AbortController();
          const attemptSignal = anySignal(ctx.signal, stall.signal);
          let lastReceived = 0;
          let lastProgressAt = Date.now();
          // Tiny files already finish quickly; only spend a timer on large or unknown-size downloads.
          const watchdog = item.size === undefined || item.size >= cfg.segmentMinSize
            ? setInterval(() => {
                if (lane.received > lastReceived) {
                  lastReceived = lane.received;
                  lastProgressAt = Date.now();
                } else if (Date.now() - lastProgressAt >= cfg.stallTimeoutMs && !stall.signal.aborted) {
                  stall.abort();
                }
              }, Math.max(250, Math.min(1000, Math.floor(cfg.stallTimeoutMs / 3))))
            : undefined;
          watchdog?.unref?.();
          try {
            const hashes = await this.fetchToFile(url, tmp, item, lane, ctx, counted, attemptSignal, phase === "segmented");
            lane.state = "verifying";
            await this.verifyFile(tmp, item, hashes);
            await this.finalize(tmp, item);
            this.health.ok(url);
            this.health.record(url, lane.received || counted.bytes, Date.now() - urlStarted);
            return "done";
          } catch (caught) {
            const error = stall.signal.aborted && !ctx.signal.aborted
              ? new NetworkError(`download made no progress for ${Math.round(cfg.stallTimeoutMs / 1000)}s`, "ERR_STALLED", url)
              : caught;
            ctx.addBytes(-counted.bytes);
            ctx.discover(-counted.discovered);
            if (isAbort(error) || ctx.signal.aborted) throw error;
            lastError = error;
            if (!isFatalForUrl(error)) this.health.fail(url);
            if (error instanceof VerifyError || error instanceof RetryableError) await rm(tmp, { force: true });
            // A missing URL will be missing on this host in single-stream mode too: go straight to Level 3.
            if (isFatalForUrl(error)) break phaseLoop;
            const rangeProblem = phase === "segmented" && (error instanceof RetryableError || error instanceof VerifyError || (error instanceof NetworkError && error.code === "ERR_STALLED"));
            // Range rejected/stalled/corrupt or all range retries exhausted: Level 2 on this URL.
            if (rangeProblem || attempt >= cfg.retries) break;
            const hint = error instanceof HttpError ? error.retryAfterMs : undefined;
            const backoff = Math.min(8000, cfg.backoffBaseMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
            await sleep(Math.max(backoff, Math.min(hint ?? 0, 10_000)), ctx.signal);
          } finally {
            if (watchdog) clearInterval(watchdog);
          }
        }
      }
    }
    await rm(`${item.dest}.vtmp`, { force: true }).catch(() => {});
    throw lastError ?? new Error("download failed");
  }

  private async verifyFile(path: string, item: DownloadItem, precomputed?: Partial<Record<HashAlgorithm, string>>) {
    const info = await stat(path);
    if (item.size !== undefined && info.size !== item.size) {
      throw new VerifyError(`size mismatch (expected ${item.size}, got ${info.size})`);
    }
    const hash = pickHash(item.hash);
    if (hash) {
      const actual = (precomputed?.[hash[0]] ?? (await hashFile(path, hash[0]))).toLowerCase();
      if (actual !== hash[1]) throw new VerifyError(`${hash[0]} mismatch (expected ${hash[1]}, got ${actual})`);
    }
  }

  private async finalize(tmp: string, item: DownloadItem) {
    let lastError: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        await replaceFile(tmp, item.dest);
        if (item.mode !== undefined && process.platform !== "win32") await chmod(item.dest, item.mode);
        return;
      } catch (error) {
        lastError = error;
        await sleep(60 * (i + 1)); // antivirus scanners briefly lock fresh files on Windows
      }
    }
    throw lastError;
  }

  private async fetchToFile(
    url: string,
    tmp: string,
    item: DownloadItem,
    lane: LaneState,
    ctx: RunContext,
    counted: Counted,
    signal: AbortSignal,
    allowSegments = true,
  ): Promise<Partial<Record<HashAlgorithm, string>> | undefined> {
    const { cfg } = ctx;
    const known = item.size;
    let start = 0;
    const existing = await fileSize(tmp);
    if (existing !== undefined) {
      if (known !== undefined && existing > 0 && existing <= known) start = existing;
      else await rm(tmp, { force: true });
    }
    if (known !== undefined && start === known) {
      // A previous run wrote every byte but was interrupted before the rename.
      lane.received = known;
      lane.total = known;
      ctx.addBytes(known);
      counted.bytes += known;
      return undefined;
    }
    if (allowSegments && known !== undefined && start === 0 && known >= cfg.segmentMinSize && cfg.segments > 1) {
      await this.fetchSegmented(url, item, lane, ctx, counted, signal);
      return undefined;
    }

    const headers: Record<string, string> = start > 0 ? { range: `bytes=${start}-` } : {};
    const response = await this.http.request(url, { headers, signal, timeoutMs: cfg.requestTimeoutMs, decompress: false });
    if (response.status === 416 && start > 0) {
      response.body.destroy();
      await rm(tmp, { force: true });
      throw new RetryableError("range not satisfiable, restarting from scratch");
    }
    if (response.status !== 200 && response.status !== 206) throw await this.httpError(response, url);
    let offset = start;
    if (response.status === 200) offset = 0;
    else {
      const range = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(String(response.headers["content-range"] ?? ""));
      if (!range || Number(range[1]) !== start) {
        response.body.destroy();
        await rm(tmp, { force: true });
        throw new RetryableError("unexpected Content-Range, restarting from scratch");
      }
    }
    const contentLength = Number(response.headers["content-length"]);
    const expectedBody = Number.isFinite(contentLength) ? contentLength : undefined;
    const remaining = known !== undefined ? known - offset : undefined;
    if (remaining !== undefined && remaining < 0) {
      response.body.destroy();
      await rm(tmp, { force: true });
      throw new VerifyError("existing partial download is larger than the expected file");
    }
    if (remaining !== undefined && expectedBody !== undefined && expectedBody > remaining) {
      response.body.destroy();
      await rm(tmp, { force: true });
      throw new VerifyError(`server announced ${expectedBody} bytes, but only ${remaining} are expected`);
    }
    const total = expectedBody !== undefined ? offset + expectedBody : (known ?? 0);
    lane.total = total;
    if (known === undefined && total > 0) {
      ctx.discover(total);
      counted.discovered += total;
    }
    if (offset > 0) {
      ctx.addBytes(offset);
      counted.bytes += offset;
    }
    lane.received = offset;
    const hashSpec = pickHash(item.hash);
    const hasher: Hash | undefined = offset === 0 && hashSpec ? createHash(hashSpec[0]) : undefined;
    const handle = await open(tmp, offset === 0 ? "w" : "r+");
    try {
      await this.pump(response.body, handle, offset, lane, ctx, counted, hasher, expectedBody, signal, remaining);
    } finally {
      await handle.close();
    }
    return hasher && hashSpec ? { [hashSpec[0]]: hasher.digest("hex") } : undefined;
  }

  private async pump(
    body: Readable,
    handle: FileHandle,
    offset: number,
    lane: LaneState,
    ctx: RunContext,
    counted: Counted,
    hasher: Hash | undefined,
    expected: number | undefined,
    signal: AbortSignal,
    limit?: number,
  ) {
    let position = offset;
    let received = 0;
    lane.state = "downloading";
    for await (const chunk of body) {
      const buffer = chunk as Buffer;
      if (limit !== undefined && received + buffer.length > limit) {
        body.destroy();
        throw new VerifyError(`response is larger than the expected ${limit} bytes`);
      }
      await this.limiter.take(buffer.length, signal);
      await handle.write(buffer, 0, buffer.length, position);
      hasher?.update(buffer);
      position += buffer.length;
      received += buffer.length;
      lane.received = position;
      ctx.addBytes(buffer.length);
      counted.bytes += buffer.length;
    }
    if (expected !== undefined && received !== expected) {
      throw new NetworkError(`Connection closed early (${received}/${expected} bytes)`, "ECONNRESET");
    }
  }

  private async fetchSegmented(url: string, item: DownloadItem, lane: LaneState, ctx: RunContext, counted: Counted, outerSignal: AbortSignal) {
    const { cfg } = ctx;
    const size = item.size!;
    const segments = Math.max(2, Math.min(item.segments ?? cfg.segments, Math.ceil(size / (1 << 20))));
    const partSize = Math.ceil(size / segments);
    const ranges = Array.from({ length: segments }, (_, i) => [i * partSize, Math.min(size, (i + 1) * partSize) - 1] as [number, number]);
    const part = `${item.dest}.vseg`;
    await rm(part, { force: true });
    lane.parts = segments;
    lane.total = size;
    const failure = new AbortController();
    const signal = anySignal(outerSignal, failure.signal);
    const first = await this.http.request(url, {
      headers: { range: `bytes=${ranges[0][0]}-${ranges[0][1]}` },
      signal,
      timeoutMs: cfg.requestTimeoutMs,
      decompress: false,
    });
    const handle = await open(part, "w");
    try {
      if (first.status === 200) {
        // The server does not do ranges: stream the body as one piece.
        lane.parts = 1;
        const length = Number(first.headers["content-length"]);
        await this.pump(first.body, handle, 0, lane, ctx, counted, undefined, Number.isFinite(length) ? length : undefined, signal);
      } else if (first.status === 206) {
        const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(String(first.headers["content-range"] ?? ""));
        if (!range || Number(range[3]) !== size) {
          first.body.destroy();
          throw new RetryableError(`server reports a different file size than expected (${range?.[3] ?? "?"} vs ${size})`);
        }
        await handle.truncate(size);
        await Promise.all(
          ranges.map((r, i) =>
            this.fetchPart(url, handle, r, i === 0 ? first : undefined, lane, ctx, counted, signal).catch((error) => {
              failure.abort();
              throw error;
            }),
          ),
        );
      } else throw await this.httpError(first, url);
      await handle.close();
      await replaceFile(part, `${item.dest}.vtmp`);
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(part, { force: true });
      throw error;
    }
  }

  private async fetchPart(
    url: string,
    handle: FileHandle,
    range: [number, number],
    preopened: HttpResponse | undefined,
    lane: LaneState,
    ctx: RunContext,
    counted: Counted,
    signal: AbortSignal,
  ) {
    const [from, to] = range;
    const length = to - from + 1;
    let received = 0;
    let response = preopened;
    for (let attempt = 1; ; attempt++) {
      try {
        if (!response) {
          response = await this.http.request(url, {
            headers: { range: `bytes=${from + received}-${to}` },
            signal,
            timeoutMs: ctx.cfg.requestTimeoutMs,
            decompress: false,
          });
          if (response.status !== 206) throw await this.httpError(response, url);
        }
        lane.state = "downloading";
        let position = from + received;
        for await (const chunk of response.body) {
          let buffer = chunk as Buffer;
          if (received + buffer.length > length) buffer = buffer.subarray(0, length - received);
          if (!buffer.length) break;
          await this.limiter.take(buffer.length, signal);
          await handle.write(buffer, 0, buffer.length, position);
          position += buffer.length;
          received += buffer.length;
          lane.received += buffer.length;
          ctx.addBytes(buffer.length);
          counted.bytes += buffer.length;
        }
        if (received !== length) throw new NetworkError(`Part closed early (${received}/${length})`, "ECONNRESET");
        return;
      } catch (error) {
        response?.body.destroy();
        response = undefined;
        if (isAbort(error) || signal.aborted || isFatalForUrl(error) || attempt >= ctx.cfg.retries) throw error;
        await sleep(ctx.cfg.backoffBaseMs * attempt, signal);
      }
    }
  }

  private async httpError(response: HttpResponse, url: string): Promise<HttpError> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        chunks.push(chunk as Buffer);
        size += (chunk as Buffer).length;
        if (size > 512) break;
      }
    } catch {
      /* the preview is best effort */
    }
    response.body.destroy();
    return new HttpError(response.status, url, Buffer.concat(chunks).toString("utf8", 0, 200), parseRetryAfter(response.headers["retry-after"]));
  }
}
