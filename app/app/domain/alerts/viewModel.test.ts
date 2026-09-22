import { describe, expect, it } from "vitest";

import {
  SUSPENSION_THRESHOLD_MS,
  buildAlertViewModel,
  buildBankPaymentGuaranteeAlertViewModel,
  type AlertEpisodeInput,
  type BankPaymentGuaranteeAlertInput,
} from "./viewModel";

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

describe("buildBankPaymentGuaranteeAlertViewModel — the dedicated sibling, not buildAlertViewModel", () => {
  const EPISODE_FIRST_FAILED_AT = new Date("2026-09-20T00:00:00.000Z");

  function baseGuaranteeInput(
    overrides: Partial<BankPaymentGuaranteeAlertInput> = {}
  ): BankPaymentGuaranteeAlertInput {
    return {
      sourceId: "episode-99", // a failure episode id, never a bank_payment_order id
      masterVariantId: "variant-99",
      product: "Solitaire Ring",
      variant: "14k Gold, US 6.5",
      reason: "at least one line's price changed via a human-approved publication (D22)",
      flaggedSince: EPISODE_FIRST_FAILED_AT,
      now: EPISODE_FIRST_FAILED_AT,
      resolved: false,
      ...overrides,
    };
  }

  it("carries sourceKind, sourceId (the EPISODE id) and every passthrough field", () => {
    const vm = buildBankPaymentGuaranteeAlertViewModel(baseGuaranteeInput());
    expect(vm.sourceKind).toBe("bank_payment_guarantee");
    expect(vm.sourceId).toBe("episode-99");
    expect(vm.masterVariantId).toBe("variant-99");
    expect(vm.product).toBe("Solitaire Ring");
    expect(vm.variant).toBe("14k Gold, US 6.5");
    expect(vm.reason).toBe("at least one line's price changed via a human-approved publication (D22)");
    expect(vm.firstFailedAt).toEqual(EPISODE_FIRST_FAILED_AT);
    expect(vm.failureType).toBe("guarantee_price_unresolvable");
  });

  it("status is 'open' when not resolved, 'resolved' when it is — never 'suspended'", () => {
    expect(buildBankPaymentGuaranteeAlertViewModel(baseGuaranteeInput({ resolved: false })).status).toBe("open");
    expect(buildBankPaymentGuaranteeAlertViewModel(baseGuaranteeInput({ resolved: true })).status).toBe("resolved");
  });

  it("timeRemainingBeforeSuspensionMs is ALWAYS zero — no automatic 48h transition applies to this kind", () => {
    const vm = buildBankPaymentGuaranteeAlertViewModel(
      baseGuaranteeInput({ now: new Date(EPISODE_FIRST_FAILED_AT.getTime() + HOUR_MS) })
    );
    expect(vm.timeRemainingBeforeSuspensionMs).toBe(0);
  });

  it("ageMs is elapsed time since flaggedSince, floored at zero", () => {
    const vm = buildBankPaymentGuaranteeAlertViewModel(
      baseGuaranteeInput({ now: new Date(EPISODE_FIRST_FAILED_AT.getTime() + 3 * HOUR_MS) })
    );
    expect(vm.ageMs).toBe(3 * HOUR_MS);
  });

  it("latestRetry reports 'succeeded' once resolved, 'failed' while open", () => {
    const open = buildBankPaymentGuaranteeAlertViewModel(baseGuaranteeInput({ resolved: false }));
    expect(open.latestRetry.outcome).toBe("failed");
    const resolved = buildBankPaymentGuaranteeAlertViewModel(baseGuaranteeInput({ resolved: true }));
    expect(resolved.latestRetry.outcome).toBe("succeeded");
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
