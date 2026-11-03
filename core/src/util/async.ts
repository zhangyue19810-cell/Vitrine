/** Small async helpers shared by the whole core. */

export class AbortError extends Error {
  readonly name = "AbortError";
  constructor(message = "Operation cancelled") {
    super(message);
  }
}

export function isAbort(error: unknown): boolean {
  return (
    error instanceof AbortError ||
    (error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR"))
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

/** Sleep that rejects with AbortError as soon as the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run `fn` over `items` with at most `limit` in flight; preserves result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Combine several signals; the result aborts when any input aborts. */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** Throttle a callback so it fires at most once per `ms`, always delivering the last value. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = () => {
    timer = undefined;
    last = Date.now();
    const args = pending!;
    pending = undefined;
    fn(...args);
  };
  const throttled = (...args: A) => {
    pending = args;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      if (timer) clearTimeout(timer);
      run();
    } else if (!timer) timer = setTimeout(run, wait);
  };
  throttled.flush = () => {
    if (timer) clearTimeout(timer);
    if (pending) run();
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return throttled;
}

export class Semaphore {
  private waiters: (() => void)[] = [];
  private used = 0;
  constructor(public limit: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.used < this.limit) {
      this.used++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new AbortError());
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.used++;
    return () => this.release();
  }
  private release() {
    this.used--;
    this.waiters.shift()?.();
  }
}
