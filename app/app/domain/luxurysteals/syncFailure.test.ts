import { describe, expect, it } from "vitest";

import {
  LuxuryStealSyncResolutionTriggerRequiredError,
  decideFirstFailure,
  decideRestoration,
  decideRetryFailure,
} from "./syncFailure";

const NOW = new Date("2026-09-24T00:00:00.000Z");

describe("decideFirstFailure — the row a brand-new episode opens with", () => {
  it("seeds firstFailedAt/lastAttemptAt to the same instant, attemptCount 1", () => {
    const outcome = decideFirstFailure({ now: NOW, error: "Shopify Admin API metafieldsSet failed" });

    expect(outcome).toEqual({
      firstFailedAt: NOW,
      lastAttemptAt: NOW,
      attemptCount: 1,
      lastError: "Shopify Admin API metafieldsSet failed",
    });
  });

  it("carries no suspendedAt or any purchasability-affecting field — criterion 152's whole point", () => {
    const outcome = decideFirstFailure({ now: NOW, error: "boom" });
    expect(Object.keys(outcome).sort()).toEqual(["attemptCount", "firstFailedAt", "lastAttemptAt", "lastError"]);
  });
});

describe("decideRetryFailure — a subsequent attempt on an already-open episode", () => {
  it("increments attemptCount and records the latest error/time", () => {
    const outcome = decideRetryFailure({ now: NOW, error: "still failing", attemptCountBefore: 1 });
    expect(outcome).toEqual({ lastAttemptAt: NOW, attemptCount: 2, lastError: "still failing" });
  });

  it("accumulates across many retries with no ceiling and no suspension decision", () => {
    const outcome = decideRetryFailure({ now: NOW, error: "still failing", attemptCountBefore: 47 });
    expect(outcome.attemptCount).toBe(48);
  });

  it("takes NO firstFailedAt parameter at all — there is no 48-hour trap to guard against here (unlike the pricing sibling modules)", () => {
    const input: Parameters<typeof decideRetryFailure>[0] = {
      now: NOW,
      error: "x",
      attemptCountBefore: 1,
    };
    expect(Object.keys(input).sort()).toEqual(["attemptCountBefore", "error", "now"]);
  });
});

describe("decideRestoration — a genuinely successful sync closes the episode", () => {
  it("sets resolvedAt and trims/records the trigger", () => {
    const outcome = decideRestoration({ now: NOW, trigger: " automatic-retry " });
    expect(outcome).toEqual({ resolvedAt: NOW, resolvedTrigger: "automatic-retry" });
  });

  it("accepts a staff-attributed trigger for a manual admin retry", () => {
    const outcome = decideRestoration({ now: NOW, trigger: "staff:123456" });
    expect(outcome.resolvedTrigger).toBe("staff:123456");
  });

  it("throws LuxuryStealSyncResolutionTriggerRequiredError for a missing trigger", () => {
    expect(() => decideRestoration({ now: NOW, trigger: "" })).toThrow(
      LuxuryStealSyncResolutionTriggerRequiredError
    );
  });

  it("throws for a whitespace-only trigger", () => {
    expect(() => decideRestoration({ now: NOW, trigger: "   " })).toThrow(
      LuxuryStealSyncResolutionTriggerRequiredError
    );
  });

  it("the outcome carries no suspendedAt field for a caller to accidentally null out — there is nothing here that ever affected purchasability", () => {
    const outcome = decideRestoration({ now: NOW, trigger: "automatic-retry" });
    expect(Object.keys(outcome).sort()).toEqual(["resolvedAt", "resolvedTrigger"]);
  });
});
