// In-memory sliding-window rate limiter (single-process deployment). Purpose:
// slow down credential brute-force on /v1/auth/*; NOT a general DoS defense.
// Deterministic clock injection keeps it unit-testable.
export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterMs: number;
  failures: number;
}

interface Bucket {
  failures: number[];
  lockedUntil?: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private windowMs: number,
    private maxFailures: number,
    private lockoutMs: number,
    private now: () => number = Date.now,
  ) {}

  /**
   * Record a failure for `key` and report whether the next attempt is allowed.
   * Callers MUST check `allowed` BEFORE attempting verification and record
   * failures only after a failed verification.
   */
  fail(key: string): RateLimitVerdict {
    const t = this.now();
    this.sweep(t);
    const b = this.buckets.get(key) ?? { failures: [] };
    b.failures.push(t);
    this.buckets.set(key, b);
    if (b.failures.length >= this.maxFailures) {
      b.lockedUntil = t + this.lockoutMs;
      return { allowed: false, retryAfterMs: this.lockoutMs, failures: b.failures.length };
    }
    return { allowed: true, retryAfterMs: 0, failures: b.failures.length };
  }

  /** Whether `key` is currently locked out (does not record anything). */
  check(key: string): RateLimitVerdict {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b) return { allowed: true, retryAfterMs: 0, failures: 0 };
    if (b.lockedUntil !== undefined && b.lockedUntil > t) {
      return { allowed: false, retryAfterMs: b.lockedUntil - t, failures: b.failures.length };
    }
    if (b.lockedUntil !== undefined && b.lockedUntil <= t) {
      // lockout served in full: start a clean window
      this.buckets.delete(key);
      return { allowed: true, retryAfterMs: 0, failures: 0 };
    }
    const recent = b.failures.filter((f) => t - f < this.windowMs).length;
    if (recent >= this.maxFailures) {
      const oldest = b.failures.find((f) => t - f < this.windowMs)!;
      return { allowed: false, retryAfterMs: oldest + this.windowMs - t, failures: recent };
    }
    return { allowed: true, retryAfterMs: 0, failures: recent };
  }

  /** Success clears the bucket (a legitimate login must not inherit failure debt). */
  reset(key: string) {
    this.buckets.delete(key);
  }

  private sweep(t: number) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) {
      const stale =
        (b.lockedUntil ?? 0) < t &&
        b.failures.every((f) => t - f >= this.windowMs);
      if (stale) this.buckets.delete(k);
    }
  }
}
