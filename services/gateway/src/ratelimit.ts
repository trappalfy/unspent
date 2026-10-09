// Rate limits per key and per wallet summed over its keys (brief 8.3, Q15): requests per minute and concurrency.
// In-memory: the gateway runs as one instance. A Redis-backed limiter can implement the same interface.

import { RATE_LIMITS } from "@unspent/shared";

export type Acquired =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSec: number; reason: "rate" | "concurrency" };

export interface RateLimiter {
  acquire(keyId: string, wallet: string): Acquired;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();

  constructor(
    private readonly perMinute: number = RATE_LIMITS.requestsPerMinute,
    private readonly concurrent: number = RATE_LIMITS.concurrent,
    private readonly now: () => number = Date.now,
  ) {}

  private window(id: string, t: number): number[] {
    const w = (this.hits.get(id) ?? []).filter((x) => t - x < 60_000);
    this.hits.set(id, w);
    return w;
  }

  acquire(keyId: string, wallet: string): Acquired {
    const t = this.now();
    const ids = [`k:${keyId}`, `w:${wallet}`];
    for (const id of ids) {
      const w = this.window(id, t);
      if (w.length >= this.perMinute) {
        return {
          ok: false,
          reason: "rate",
          retryAfterSec: Math.max(1, Math.ceil((60_000 - (t - w[0]!)) / 1000)),
        };
      }
    }
    for (const id of ids) {
      if ((this.inFlight.get(id) ?? 0) >= this.concurrent)
        return { ok: false, reason: "concurrency", retryAfterSec: 1 };
    }
    for (const id of ids) {
      this.hits.get(id)!.push(t);
      this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    }
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        for (const id of ids) this.inFlight.set(id, Math.max(0, (this.inFlight.get(id) ?? 1) - 1));
      },
    };
  }
}
