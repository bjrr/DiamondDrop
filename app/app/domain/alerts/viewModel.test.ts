import { describe, expect, it } from "vitest";

import { SUSPENSION_THRESHOLD_MS, buildAlertViewModel, type AlertEpisodeInput } from "./viewModel";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_FAILED_AT = new Date("2026-09-19T00:00:00.000Z");

function baseInput(overrides: Partial<AlertEpisodeInput> = {}): AlertEpisodeInput {
  return {
    sourceId: "episode-1",
    masterVariantId: "variant-1",
    product: "Solitaire Ring",
    variant: "14k Gold, US 6.5",
    firstFailedAt: FIRST_FAILED_AT,
    lastAttemptAt: FIRST_FAILED_AT,
    attemptCount: 1,
    lastError: "No applicable cost_component.setting row effective",
    suspendedAt: null,
    resolvedAt: null,
    now: FIRST_FAILED_AT,
    detail: { sourceKind: "calculation_failure", failureType: "missing_cost_input" },
    ...overrides,
  };
}

describe("buildAlertViewModel — status", () => {
  it("is 'open' when neither suspended nor resolved", () => {
    const vm = buildAlertViewModel(baseInput({ now: new Date(FIRST_FAILED_AT.getTime() + HOUR_MS) }));
    expect(vm.status).toBe("open");
  });

  it("is 'suspended' when suspendedAt is set and resolvedAt is not (R2's predicate)", () => {
    const vm = buildAlertViewModel(
      baseInput({
        suspendedAt: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS),
      })
    );
    expect(vm.status).toBe("suspended");
  });

  it("is 'resolved' whenever resolvedAt is set, even if suspendedAt is also set", () => {
    const vm = buildAlertViewModel(
      baseInput({
        suspendedAt: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
        resolvedAt: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + 2 * HOUR_MS),
      })
    );
    expect(vm.status).toBe("resolved");
  });
});

describe("buildAlertViewModel — age and time remaining", () => {
  it("computes age as elapsed ms since firstFailedAt", () => {
    const vm = buildAlertViewModel(baseInput({ now: new Date(FIRST_FAILED_AT.getTime() + 5 * HOUR_MS) }));
    expect(vm.ageMs).toBe(5 * HOUR_MS);
  });

  it("computes time remaining as the 48h threshold minus age while open", () => {
    const vm = buildAlertViewModel(baseInput({ now: new Date(FIRST_FAILED_AT.getTime() + 10 * HOUR_MS) }));
    expect(vm.timeRemainingBeforeSuspensionMs).toBe(SUSPENSION_THRESHOLD_MS - 10 * HOUR_MS);
  });

  it("is floored at zero, never negative, once past the threshold while still open", () => {
    // Not yet marked suspended in the DB row, but time has moved past 48h —
    // e.g. the view is built between the failure and the next job run that
    // would flip suspendedAt. Must not show a negative countdown.
    const vm = buildAlertViewModel(
      baseInput({ now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS) })
    );
    expect(vm.timeRemainingBeforeSuspensionMs).toBe(0);
  });

  it("is zero once suspended", () => {
    const vm = buildAlertViewModel(
      baseInput({
        suspendedAt: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS),
      })
    );
    expect(vm.timeRemainingBeforeSuspensionMs).toBe(0);
  });

  it("is zero once resolved", () => {
    const vm = buildAlertViewModel(
      baseInput({
        resolvedAt: new Date(FIRST_FAILED_AT.getTime() + HOUR_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + 2 * HOUR_MS),
      })
    );
    expect(vm.timeRemainingBeforeSuspensionMs).toBe(0);
  });
});

describe("buildAlertViewModel — latest retry", () => {
  it("reports the latest attempt as 'failed' while the episode is open", () => {
    const vm = buildAlertViewModel(
      baseInput({
        attemptCount: 4,
        lastAttemptAt: new Date(FIRST_FAILED_AT.getTime() + 3 * HOUR_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + 3 * HOUR_MS),
      })
    );
    expect(vm.latestRetry).toEqual({
      attemptCount: 4,
      attemptedAt: new Date(FIRST_FAILED_AT.getTime() + 3 * HOUR_MS),
      outcome: "failed",
    });
  });

  it("reports 'succeeded' at resolvedAt once resolved", () => {
    const resolvedAt = new Date(FIRST_FAILED_AT.getTime() + 5 * HOUR_MS);
    const vm = buildAlertViewModel(
      baseInput({ attemptCount: 3, resolvedAt, now: new Date(resolvedAt.getTime() + HOUR_MS) })
    );
    expect(vm.latestRetry).toEqual({ attemptCount: 3, attemptedAt: resolvedAt, outcome: "succeeded" });
  });
});

describe("buildAlertViewModel — source-kind distinctness", () => {
  it("carries the calculation-failure taxonomy value through as failureType", () => {
    const vm = buildAlertViewModel(
      baseInput({ detail: { sourceKind: "calculation_failure", failureType: "unresolved_band" } })
    );
    expect(vm.sourceKind).toBe("calculation_failure");
    expect(vm.failureType).toBe("unresolved_band");
  });

  it("uses the fixed 'sync_rejected' label for a sync failure — never the calculation taxonomy", () => {
    const vm = buildAlertViewModel(baseInput({ detail: { sourceKind: "sync_failure" } }));
    expect(vm.sourceKind).toBe("sync_failure");
    expect(vm.failureType).toBe("sync_rejected");
  });
});

describe("buildAlertViewModel — passthrough fields", () => {
  it("carries product, variant, sourceId, masterVariantId and reason through unchanged", () => {
    const vm = buildAlertViewModel(
      baseInput({
        sourceId: "episode-42",
        masterVariantId: "variant-42",
        product: "Eternity Band",
        variant: "Platinum, US 7",
        lastError: "Shopify variant price update rejected: INVALID",
      })
    );
    expect(vm.sourceId).toBe("episode-42");
    expect(vm.masterVariantId).toBe("variant-42");
    expect(vm.product).toBe("Eternity Band");
    expect(vm.variant).toBe("Platinum, US 7");
    expect(vm.reason).toBe("Shopify variant price update rejected: INVALID");
    expect(vm.firstFailedAt).toEqual(FIRST_FAILED_AT);
  });
});
