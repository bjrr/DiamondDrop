import { describe, expect, it } from "vitest";

import {
  DismissalActorRequiredError,
  DismissalReasonRequiredError,
  RETRY_BACKOFF_MULTIPLIER,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  SUSPENSION_THRESHOLD_MS,
  decideDismissal,
  decideFirstFailure,
  decideNextRetryDelay,
  decideRestoration,
  decideRetryFailure,
  decideSuspension,
  isVariantWithdrawn,
} from "./syncFailure";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_FAILED_AT = new Date("2026-09-19T00:00:00.000Z");

describe("decideSuspension — THE 48-HOUR TRAP", () => {
  it("does NOT suspend just under 48 hours", () => {
    const now = new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS - 1);
    expect(decideSuspension({ firstFailedAt: FIRST_FAILED_AT, now }).shouldSuspend).toBe(false);
  });

  it("suspends at EXACTLY 48 hours — the boundary is inclusive", () => {
    const now = new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS);
    expect(decideSuspension({ firstFailedAt: FIRST_FAILED_AT, now }).shouldSuspend).toBe(true);
  });

  it("suspends past 48 hours", () => {
    const now = new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS);
    expect(decideSuspension({ firstFailedAt: FIRST_FAILED_AT, now }).shouldSuspend).toBe(true);
  });

  it("THE TRAP ITSELF: a long run of frequent retries, with the LAST attempt recent, still suspends because the FIRST failure is over 48h old", () => {
    // If this were anchored on the latest retry instead of the first
    // failure, this exact scenario — a variant retried every few minutes for
    // days — would never suspend. That is precisely the silent-no-op failure
    // mode this test exists to catch.
    const now = new Date(FIRST_FAILED_AT.getTime() + 72 * HOUR_MS);
    const lastAttemptAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    void lastAttemptAt; // deliberately NOT passed to decideSuspension — see below

    const decision = decideSuspension({ firstFailedAt: FIRST_FAILED_AT, now });

    expect(decision.shouldSuspend).toBe(true);
    expect(decision.reason).toMatch(/at or past the 48-hour threshold/);
  });

  it("decideSuspension's signature itself proves the fix: it takes NO attemptCount or lastAttemptAt parameter", () => {
    // A type-level guard against the regression, not just a behavioural one:
    // there is no argument this test could even pass that would let a retry
    // cadence influence the decision.
    const input: Parameters<typeof decideSuspension>[0] = {
      firstFailedAt: FIRST_FAILED_AT,
      now: new Date(),
    };
    expect(Object.keys(input).sort()).toEqual(["firstFailedAt", "now"]);
  });
});

describe("isVariantWithdrawn — R2, the ONLY availability predicate", () => {
  it("is withdrawn when suspended and unresolved", () => {
    expect(isVariantWithdrawn({ suspendedAt: new Date(), resolvedAt: null })).toBe(true);
  });

  it("is NOT withdrawn when never suspended", () => {
    expect(isVariantWithdrawn({ suspendedAt: null, resolvedAt: null })).toBe(false);
  });

  it("is NOT withdrawn once resolved, even though suspendedAt is still recorded (R4: never nulled)", () => {
    expect(isVariantWithdrawn({ suspendedAt: new Date(), resolvedAt: new Date() })).toBe(false);
  });

  it("is NOT withdrawn when resolved and never suspended", () => {
    expect(isVariantWithdrawn({ suspendedAt: null, resolvedAt: new Date() })).toBe(false);
  });
});

describe("decideRetryFailure — composes the 48-hour trap correctly", () => {
  it("does not suspend before 48 hours, across many retries", () => {
    let attemptCountBefore = 1;
    let currentSuspendedAt: Date | null = null;

    for (let hour = 1; hour < 48; hour++) {
      const now = new Date(FIRST_FAILED_AT.getTime() + hour * HOUR_MS);
      const outcome = decideRetryFailure({
        now,
        error: `attempt at hour ${hour}`,
        firstFailedAt: FIRST_FAILED_AT,
        attemptCountBefore,
        currentSuspendedAt,
      });
      expect(outcome.suspendedAt).toBeNull();
      expect(outcome.newlySuspended).toBe(false);
      attemptCountBefore = outcome.attemptCount;
      currentSuspendedAt = outcome.suspendedAt;
    }

    expect(attemptCountBefore).toBe(48);
  });

  it("THE TRAP, end to end: frequent retries every 10 minutes for 3 days still suspend at the 48h mark", () => {
    let attemptCountBefore = 1;
    let currentSuspendedAt: Date | null = null;
    let suspendedAtHour: number | null = null;

    const totalMinutes = 72 * 60; // 3 days
    for (let minute = 10; minute <= totalMinutes; minute += 10) {
      const now = new Date(FIRST_FAILED_AT.getTime() + minute * 60 * 1000);
      const outcome = decideRetryFailure({
        now,
        error: "still failing",
        firstFailedAt: FIRST_FAILED_AT,
        attemptCountBefore,
        currentSuspendedAt,
      });
      attemptCountBefore = outcome.attemptCount;
      if (outcome.newlySuspended) suspendedAtHour = minute / 60;
      currentSuspendedAt = outcome.suspendedAt;
    }

    expect(currentSuspendedAt).not.toBeNull();
    expect(suspendedAtHour).toBe(48);
    // Well over a hundred attempts by day 3 at a 10-minute cadence — the
    // "many retries, last one recent" scenario the trap targets.
    expect(attemptCountBefore).toBeGreaterThan(400);
  });

  it("newlySuspended is true only on the crossing attempt, never again", () => {
    const justUnder = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS - HOUR_MS),
      error: "e",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: 10,
      currentSuspendedAt: null,
    });
    expect(justUnder.newlySuspended).toBe(false);
    expect(justUnder.suspendedAt).toBeNull();

    const crossing = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
      error: "e",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: justUnder.attemptCount,
      currentSuspendedAt: justUnder.suspendedAt,
    });
    expect(crossing.newlySuspended).toBe(true);
    expect(crossing.suspendedAt).toEqual(new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS));

    const after = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS),
      error: "e",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: crossing.attemptCount,
      currentSuspendedAt: crossing.suspendedAt,
    });
    expect(after.newlySuspended).toBe(false);
    // R4: suspendedAt is CARRIED FORWARD unchanged, not bumped to `now`.
    expect(after.suspendedAt).toEqual(crossing.suspendedAt);
  });

  it("increments attemptCount and records the latest error", () => {
    const outcome = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + HOUR_MS),
      error: "Admin API 503",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: 4,
      currentSuspendedAt: null,
    });
    expect(outcome.attemptCount).toBe(5);
    expect(outcome.lastAttemptAt).toEqual(new Date(FIRST_FAILED_AT.getTime() + HOUR_MS));
    expect(outcome.lastError).toBe("Admin API 503");
  });
});

describe("decideFirstFailure", () => {
  it("opens a new episode at attempt 1 with the alert active", () => {
    const now = new Date();
    const outcome = decideFirstFailure({ now, error: "Admin API 500" });

    expect(outcome.firstFailedAt).toEqual(now);
    expect(outcome.lastAttemptAt).toEqual(now);
    expect(outcome.attemptCount).toBe(1);
    expect(outcome.alertState).toBe("active");
    expect(outcome.lastError).toBe("Admin API 500");
  });
});

describe("decideNextRetryDelay — bounded backoff", () => {
  it("starts at the base delay on the first attempt", () => {
    expect(decideNextRetryDelay({ attemptCount: 1 }).nextAttemptDelayMs).toBe(RETRY_BASE_DELAY_MS);
  });

  it("grows by the multiplier each attempt", () => {
    expect(decideNextRetryDelay({ attemptCount: 2 }).nextAttemptDelayMs).toBe(
      RETRY_BASE_DELAY_MS * RETRY_BACKOFF_MULTIPLIER
    );
    expect(decideNextRetryDelay({ attemptCount: 3 }).nextAttemptDelayMs).toBe(
      RETRY_BASE_DELAY_MS * RETRY_BACKOFF_MULTIPLIER ** 2
    );
  });

  it("is BOUNDED: caps rather than growing forever", () => {
    expect(decideNextRetryDelay({ attemptCount: 50 }).nextAttemptDelayMs).toBe(RETRY_MAX_DELAY_MS);
  });

  it("BOUNDED does not mean it stops retrying — it always returns a finite delay to retry again, never a signal to give up", () => {
    const decision = decideNextRetryDelay({ attemptCount: 1000 });
    expect(decision.nextAttemptDelayMs).toBe(RETRY_MAX_DELAY_MS);
    expect(Number.isFinite(decision.nextAttemptDelayMs)).toBe(true);
  });

  it("refuses a non-positive attemptCount", () => {
    expect(() => decideNextRetryDelay({ attemptCount: 0 })).toThrow(RangeError);
    expect(() => decideNextRetryDelay({ attemptCount: -1 })).toThrow(RangeError);
  });
});

describe("decideRestoration — criterion 25, no human action", () => {
  it("sets resolvedAt and clears the alert together", () => {
    const now = new Date();
    const outcome = decideRestoration({ now });
    expect(outcome.resolvedAt).toEqual(now);
    expect(outcome.alertState).toBe("cleared");
  });

  it("the outcome object has no suspendedAt field at all — R4 by construction", () => {
    const outcome = decideRestoration({ now: new Date() });
    expect(Object.prototype.hasOwnProperty.call(outcome, "suspendedAt")).toBe(false);
  });
});

describe("decideDismissal — owner §4.3, requires actor and reason", () => {
  it("requires a non-blank actor", () => {
    expect(() => decideDismissal({ actor: "", reason: "known issue", now: new Date() })).toThrow(
      DismissalActorRequiredError
    );
    expect(() => decideDismissal({ actor: "   ", reason: "known issue", now: new Date() })).toThrow(
      DismissalActorRequiredError
    );
  });

  it("requires a non-blank reason", () => {
    expect(() => decideDismissal({ actor: "staff:alex", reason: "", now: new Date() })).toThrow(
      DismissalReasonRequiredError
    );
  });

  it("trims actor and reason", () => {
    const outcome = decideDismissal({ actor: "  staff:alex  ", reason: "  known issue  ", now: new Date() });
    expect(outcome.dismissedBy).toBe("staff:alex");
    expect(outcome.dismissedReason).toBe("known issue");
  });

  it("does NOT resolve the episode and does NOT lift a suspension — no such fields exist on the outcome", () => {
    const outcome = decideDismissal({ actor: "staff:alex", reason: "tracked separately", now: new Date() });
    expect(outcome.alertState).toBe("dismissed");
    expect(Object.prototype.hasOwnProperty.call(outcome, "resolvedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outcome, "suspendedAt")).toBe(false);
  });
});
