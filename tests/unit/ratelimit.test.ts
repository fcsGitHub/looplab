// Unit: sliding-window login brake. Deterministic clock, no DB.
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../apps/control/src/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to maxFailures-1, locks at maxFailures, and unlocks after the lockout", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(60_000, 3, 30_000, () => now);
    expect(rl.check("k").allowed).toBe(true);
    rl.fail("k");
    rl.fail("k");
    expect(rl.check("k").allowed).toBe(true); // 2 < 3
    rl.fail("k"); // 3rd failure -> lockout
    const v = rl.check("k");
    expect(v.allowed).toBe(false);
    expect(v.retryAfterMs).toBe(30_000);
    now += 29_999;
    expect(rl.check("k").allowed).toBe(false);
    now += 2;
    expect(rl.check("k").allowed).toBe(true); // lockout served -> clean slate
    expect(rl.fail("k").failures).toBe(1);
  });

  it("windows out old failures without locking", () => {
    let now = 2_000_000;
    const rl = new RateLimiter(10_000, 3, 60_000, () => now);
    rl.fail("w");
    rl.fail("w");
    now += 10_001; // both failures age out of the window
    expect(rl.check("w").allowed).toBe(true);
    expect(rl.check("w").failures).toBe(0);
  });

  it("keys are independent (per ip+username)", () => {
    const rl = new RateLimiter(60_000, 2, 60_000, () => 5_000_000);
    rl.fail("a"); rl.fail("a");
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(true);
  });

  it("reset() clears failure debt on success", () => {
    const rl = new RateLimiter(60_000, 2, 60_000, () => 7_000_000);
    rl.fail("r");
    rl.reset("r");
    expect(rl.check("r").allowed).toBe(true);
    rl.fail("r");
    expect(rl.check("r").allowed).toBe(true);
  });
});
