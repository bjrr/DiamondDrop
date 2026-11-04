/**
 * A fixed-size, in-memory sliding-window counter.
 *
 * ===========================================================================
 * DELIBERATELY NOT A SUBSYSTEM
 * ===========================================================================
 * No Redis, no table, no middleware. One Map, pruned as it is used. CaratForUs
 * runs a single Fly machine, so this is accurate today; if it ever runs two,
 * each machine enforces its own window and the effective limit doubles —
 * which still bounds abuse, and is the correct trade for a landing-page
 * endpoint that writes a phone number. Reach for shared state when there is a
 * real reason, not in anticipation of one.
 *
 * THE CLOCK IS INJECTED so the tests can advance time instead of sleeping. A
 * rate limiter tested with real `setTimeout` is a rate limiter whose window
 * boundary is never actually tested.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Hits recorded in the current window, including this one when allowed. */
  readonly count: number;
}

export interface RateLimiterOptions {
  /** Hits permitted per key per window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Hard cap on tracked keys. Reached only under a flood of distinct keys,
   * which is precisely when an unbounded Map becomes the vulnerability rather
   * than the defence.
   */
  readonly maxKeys: number;
  readonly now?: () => number;
}

export interface RateLimiter {
  /** Records a hit and says whether it is within the limit. */
  readonly hit: (key: string) => RateLimitDecision;
  /** Visible for tests and diagnostics. */
  readonly size: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const clock = options.now ?? Date.now;
  /** key -> timestamps of hits still inside the window. */
  const hits = new Map<string, number[]>();

  function prune(at: number): void {
    for (const [key, times] of hits) {
      const live = times.filter((t) => at - t < options.windowMs);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }

  return {
    hit(key: string): RateLimitDecision {
      const at = clock();
      prune(at);

      // AT CAPACITY, REFUSE RATHER THAN EVICT. Evicting to make room would let
      // a flood of fresh keys reset the counter of the key doing the abusing —
      // the limiter would hand out capacity exactly when it is under attack.
      const known = hits.get(key);
      if (!known && hits.size >= options.maxKeys) {
        return { allowed: false, count: options.limit + 1 };
      }

      const times = known ?? [];
      if (times.length >= options.limit) {
        return { allowed: false, count: times.length };
      }

      times.push(at);
      hits.set(key, times);
      return { allowed: true, count: times.length };
    },
    size(): number {
      return hits.size;
    },
  };
}
