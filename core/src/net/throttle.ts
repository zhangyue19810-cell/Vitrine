import { sleep } from "../util/async";

/** Shared byte-rate limiter. A rate of 0 means unlimited. */
export class RateLimiter {
  private tokens = 0;
  private last = Date.now();
  constructor(private rateProvider: () => number) {}

  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    const rate = this.rateProvider();
    if (!rate || rate <= 0) {
      this.tokens = 0;
      this.last = Date.now();
      return;
    }
    const now = Date.now();
    // Allow a short burst (a quarter second) so small files are not slowed by pacing.
    this.tokens = Math.min(rate / 4, this.tokens + ((now - this.last) / 1000) * rate);
    this.last = now;
    this.tokens -= bytes;
    if (this.tokens < 0) await sleep((-this.tokens / rate) * 1000, signal);
  }
}
