import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rateLimit.server";

/** A clock the test drives, so the window boundary is actually exercised. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("createRateLimiter", () => {
  it("allows up to the limit and refuses the next", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 10, now: clock.now });

    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("keeps one key's budget out of another's", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: clock.now });

    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("still refuses at the final millisecond of the window", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: clock.now });

    limiter.hit("a");
    clock.advance(999);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("frees the budget once the window has fully passed", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, now: clock.now });

    limiter.hit("a");
    clock.advance(1000);
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("forgets keys whose hits have aged out, rather than growing forever", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 100, now: clock.now });

    for (let i = 0; i < 50; i += 1) limiter.hit("key-" + i);
    expect(limiter.size()).toBe(50);

    clock.advance(1001);
    limiter.hit("fresh");
    expect(limiter.size()).toBe(1);
  });

  it("refuses NEW keys at capacity instead of evicting an existing one", () => {
    // THE ATTACK THIS PREVENTS: if capacity pressure evicted old keys, a
    // flood of fresh keys would reset the counter of the key doing the
    // abusing — handing out capacity exactly when under attack.
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: clock.now });

    limiter.hit("a");
    limiter.hit("b");
    expect(limiter.hit("c").allowed).toBe(false);
    // `a` keeps its remaining budget.
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });
});
