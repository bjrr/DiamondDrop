import { describe, expect, it } from "vitest";

import {
  ResolutionTriggerRequiredError,
  SUSPENSION_THRESHOLD_MS,
  classifyCalculationFailureType,
  decideFirstFailure,
  decideRestoration,
  decideRetryFailure,
  decideSuspension,
  isVariantWithdrawn,
  timeRemainingBeforeSuspensionMs,
} from "./calculationFailure";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_FAILED_AT = new Date("2026-09-19T00:00:00.000Z");

describe("classifyCalculationFailureType — the cause taxonomy", () => {
  it("maps every named engine/resolution error to a specific cause", () => {
    expect(classifyCalculationFailureType("InvalidBandError")).toBe("unresolved_band");
    expect(classifyCalculationFailureType("BandResolutionError")).toBe("unresolved_band");
    expect(classifyCalculationFailureType("InvalidSizeError")).toBe("invalid_size");
    expect(classifyCalculationFailureType("InvalidWeightError")).toBe("invalid_weight");
    expect(classifyCalculationFailureType("MissingCostInputError")).toBe("missing_cost_input");
    expect(classifyCalculationFailureType("AmbiguousCostInputError")).toBe("ambiguous_cost_input");
    expect(classifyCalculationFailureType("PricingCurrencyMismatchError")).toBe("currency_mismatch");
    expect(classifyCalculationFailureType("UnreachableMarginError")).toBe("margin_unreachable");
    expect(classifyCalculationFailureType("MarginFloorUnreachableError")).toBe("margin_unreachable");
  });

  it("falls back to 'unknown' for an unrecognised error name rather than guessing", () => {
    expect(classifyCalculationFailureType("SomeFutureError")).toBe("unknown");
    expect(classifyCalculationFailureType("")).toBe("unknown");
  });
});

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
    const now = new Date(FIRST_FAILED_AT.getTime() + 72 * HOUR_MS);
    const lastAttemptAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    void lastAttemptAt; // deliberately NOT passed to decideSuspension — see below

    const decision = decideSuspension({ firstFailedAt: FIRST_FAILED_AT, now });

    expect(decision.shouldSuspend).toBe(true);
    expect(decision.reason).toMatch(/at or past the 48-hour threshold/);
  });

  it("decideSuspension's signature itself proves the fix: it takes NO attemptCount or lastAttemptAt parameter", () => {
    const input: Parameters<typeof decideSuspension>[0] = {
      firstFailedAt: FIRST_FAILED_AT,
      now: new Date(),
    };
    expect(Object.keys(input).sort()).toEqual(["firstFailedAt", "now"]);
  });
});

describe("timeRemainingBeforeSuspensionMs — admin visibility's countdown", () => {
  it("is the full window right after the first failure", () => {
    expect(
      timeRemainingBeforeSuspensionMs({ firstFailedAt: FIRST_FAILED_AT, now: FIRST_FAILED_AT })
    ).toBe(SUSPENSION_THRESHOLD_MS);
  });

  it("counts down as time passes", () => {
    const now = new Date(FIRST_FAILED_AT.getTime() + 10 * HOUR_MS);
    expect(timeRemainingBeforeSuspensionMs({ firstFailedAt: FIRST_FAILED_AT, now })).toBe(
      SUSPENSION_THRESHOLD_MS - 10 * HOUR_MS
    );
  });

  it("is zero at the boundary, never negative once past it", () => {
    const atBoundary = new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS);
    expect(timeRemainingBeforeSuspensionMs({ firstFailedAt: FIRST_FAILED_AT, now: atBoundary })).toBe(0);

    const wellPast = new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + 72 * HOUR_MS);
    expect(timeRemainingBeforeSuspensionMs({ firstFailedAt: FIRST_FAILED_AT, now: wellPast })).toBe(0);
  });
});

describe("isVariantWithdrawn — the ONLY availability predicate for this failure mode", () => {
  it("is withdrawn when suspended and unresolved", () => {
    expect(isVariantWithdrawn({ suspendedAt: new Date(), resolvedAt: null })).toBe(true);
  });

  it("is NOT withdrawn when never suspended", () => {
    expect(isVariantWithdrawn({ suspendedAt: null, resolvedAt: null })).toBe(false);
  });

  it("is NOT withdrawn once resolved, even though suspendedAt is still recorded (never nulled)", () => {
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
        errorName: "MissingCostInputError",
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
        errorName: "MissingCostInputError",
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
    expect(attemptCountBefore).toBeGreaterThan(400);
  });

  it("newlySuspended is true only on the crossing attempt, never again", () => {
    const justUnder = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS - HOUR_MS),
      errorName: "MissingCostInputError",
      error: "e",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: 10,
      currentSuspendedAt: null,
    });
    expect(justUnder.newlySuspended).toBe(false);
    expect(justUnder.suspendedAt).toBeNull();

    const crossing = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
      errorName: "MissingCostInputError",
      error: "e",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: justUnder.attemptCount,
      currentSuspendedAt: justUnder.suspendedAt,
    });
    expect(crossing.newlySuspended).toBe(true);
    expect(crossing.suspendedAt).toEqual(new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS));

    const after = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS),
      errorName: "MissingCostInputError",
      error: "e",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: crossing.attemptCount,
      currentSuspendedAt: crossing.suspendedAt,
    });
    expect(after.newlySuspended).toBe(false);
    // suspendedAt is CARRIED FORWARD unchanged, not bumped to `now`.
    expect(after.suspendedAt).toEqual(crossing.suspendedAt);
  });

  it("increments attemptCount and records the latest error and its reclassified cause", () => {
    const outcome = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + HOUR_MS),
      errorName: "InvalidWeightError",
      error: "Computed weight -1.2 g at size 7 is not positive.",
      firstFailedAt: FIRST_FAILED_AT,
      attemptCountBefore: 4,
      currentSuspendedAt: null,
    });
    expect(outcome.attemptCount).toBe(5);
    expect(outcome.lastAttemptAt).toEqual(new Date(FIRST_FAILED_AT.getTime() + HOUR_MS));
    expect(outcome.lastError).toBe("Computed weight -1.2 g at size 7 is not positive.");
    expect(outcome.failureType).toBe("invalid_weight");
  });

  it("reclassifies the cause when a LATER retry hits a different unresolved input than the first attempt", () => {
    const first = decideFirstFailure({
      now: FIRST_FAILED_AT,
      errorName: "MissingCostInputError",
      error: "No applicable cost_component.setting row effective",
    });
    expect(first.failureType).toBe("missing_cost_input");

    // Labour rate got fixed; the next attempt now trips on the band instead.
    const retry = decideRetryFailure({
      now: new Date(FIRST_FAILED_AT.getTime() + HOUR_MS),
      errorName: "BandResolutionError",
      error: "master_variant references bandId which is not a band of its product",
      firstFailedAt: first.firstFailedAt,
      attemptCountBefore: first.attemptCount,
      currentSuspendedAt: null,
    });
    expect(retry.failureType).toBe("unresolved_band");
    // The episode's 48-hour clock is untouched by the cause changing.
    expect(retry.suspendedAt).toBeNull();
  });
});

describe("decideFirstFailure", () => {
  it("opens a new episode at attempt 1, classified from the error name", () => {
    const now = new Date();
    const outcome = decideFirstFailure({
      now,
      errorName: "PricingCurrencyMismatchError",
      error: "Currency mismatch in stone cost: expected USD, got EUR.",
    });

    expect(outcome.firstFailedAt).toEqual(now);
    expect(outcome.lastAttemptAt).toEqual(now);
    expect(outcome.attemptCount).toBe(1);
    expect(outcome.failureType).toBe("currency_mismatch");
    expect(outcome.lastError).toBe("Currency mismatch in stone cost: expected USD, got EUR.");
  });
});

describe("decideRestoration — owner §7 recovery, requires a trigger/actor", () => {
  it("sets resolvedAt and resolvedTrigger together", () => {
    const now = new Date();
    const outcome = decideRestoration({ now, trigger: "scheduled" });
    expect(outcome.resolvedAt).toEqual(now);
    expect(outcome.resolvedTrigger).toBe("scheduled");
  });

  it("accepts a staff actor as the trigger", () => {
    const outcome = decideRestoration({ now: new Date(), trigger: "staff:alex" });
    expect(outcome.resolvedTrigger).toBe("staff:alex");
  });

  it("trims the trigger", () => {
    const outcome = decideRestoration({ now: new Date(), trigger: "  scheduled  " });
    expect(outcome.resolvedTrigger).toBe("scheduled");
  });

  it("refuses a blank trigger — owner §7 requires naming what triggered the fix", () => {
    expect(() => decideRestoration({ now: new Date(), trigger: "" })).toThrow(
      ResolutionTriggerRequiredError
    );
    expect(() => decideRestoration({ now: new Date(), trigger: "   " })).toThrow(
      ResolutionTriggerRequiredError
    );
  });

  it("the outcome object has no suspendedAt field at all", () => {
    const outcome = decideRestoration({ now: new Date(), trigger: "scheduled" });
    expect(Object.prototype.hasOwnProperty.call(outcome, "suspendedAt")).toBe(false);
  });
});
