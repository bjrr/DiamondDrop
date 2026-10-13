import { describe, expect, it } from "vitest";

import { renderAlertEmail } from "./emailContent";
import {
  buildAlertViewModel,
  buildBankPaymentGuaranteeAlertViewModel,
  SUSPENSION_THRESHOLD_MS,
  type AlertEpisodeInput,
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

describe("renderAlertEmail — subject distinguishes source kind and event", () => {
  it("names the calculation-failure kind and the 'opened' event", () => {
    const vm = buildAlertViewModel(baseInput());
    const email = renderAlertEmail(vm, "opened");
    expect(email.subject).toContain("Pricing calculation failure");
    expect(email.subject).toContain("New");
    expect(email.subject).toContain("Solitaire Ring");
    expect(email.subject).toContain("14k Gold, US 6.5");
  });

  it("names the sync-failure kind distinctly from a calculation failure", () => {
    const vm = buildAlertViewModel(baseInput({ detail: { sourceKind: "sync_failure" } }));
    const email = renderAlertEmail(vm, "opened");
    expect(email.subject).toContain("Shopify price sync failure");
    expect(email.subject).not.toContain("Pricing calculation failure");
  });

  it("names the suspended event distinctly", () => {
    const vm = buildAlertViewModel(
      baseInput({
        suspendedAt: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
      })
    );
    const email = renderAlertEmail(vm, "suspended");
    expect(email.subject).toContain("Variant unavailable (48h unresolved)");
  });

  it("names the resolved event distinctly", () => {
    const resolvedAt = new Date(FIRST_FAILED_AT.getTime() + HOUR_MS);
    const vm = buildAlertViewModel(baseInput({ resolvedAt, now: resolvedAt }));
    const email = renderAlertEmail(vm, "resolved");
    expect(email.subject).toContain("Resolved");
  });
});

describe("renderAlertEmail — body content", () => {
  it("includes product, variant, failure type, reason, timing and status, and no cost/margin wording", () => {
    const vm = buildAlertViewModel(baseInput({ now: new Date(FIRST_FAILED_AT.getTime() + 3 * HOUR_MS) }));
    const email = renderAlertEmail(vm, "opened");

    expect(email.text).toContain("Product: Solitaire Ring");
    expect(email.text).toContain("Variant: 14k Gold, US 6.5");
    expect(email.text).toContain("Failure type: missing_cost_input");
    expect(email.text).toContain("Reason: No applicable cost_component.setting row effective");
    expect(email.text).toContain("First failed at: 2026-09-19T00:00:00.000Z");
    expect(email.text).toContain("Age: 3h 0m");
    expect(email.text).toContain("Time remaining before 48h cutoff: 45h 0m");
    expect(email.text).toContain("Latest retry: attempt #1");
    expect(email.text).toContain("Status: open");

    // The one thing this email must never carry (team-lead directive).
    expect(email.text.toLowerCase()).not.toMatch(/margin|landed cost|uplift|supplier/);
  });

  it("shows 'n/a — variant already unavailable' once suspended, not a stale countdown", () => {
    const vm = buildAlertViewModel(
      baseInput({
        suspendedAt: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS),
        now: new Date(FIRST_FAILED_AT.getTime() + SUSPENSION_THRESHOLD_MS + HOUR_MS),
      })
    );
    const email = renderAlertEmail(vm, "suspended");
    expect(email.text).toContain("Time remaining before 48h cutoff: n/a — variant already unavailable");
  });

  it("shows 'n/a — resolved' and the succeeded retry outcome once resolved", () => {
    const resolvedAt = new Date(FIRST_FAILED_AT.getTime() + 2 * HOUR_MS);
    const vm = buildAlertViewModel(baseInput({ resolvedAt, now: resolvedAt }));
    const email = renderAlertEmail(vm, "resolved");
    expect(email.text).toContain("Time remaining before 48h cutoff: n/a — resolved");
    expect(email.text).toContain("succeeded");
  });
});

/**
 * The `bank_payment_guarantee` branch has its OWN body (spec §13/§14
 * criterion 102; D22 review). Pinned separately from the shared body above
 * because it fixes a real regression: `sourceId` for this kind is a failure
 * EPISODE id, never a `bank_payment_order.id` (see the `AdminAlertSourceKind`
 * enum's own doc comment) — an earlier version of this branch printed
 * "Bank payment order: <episode id>", which is simply false. These tests
 * pin the corrected label and guard the shared body's kind-generic line
 * never creeping back in here.
 */
describe("renderAlertEmail — bank_payment_guarantee gets its own body", () => {
  const FLAGGED_SINCE = new Date("2026-09-20T00:00:00.000Z");

  it("labels sourceId as the unresolvable pricing EPISODE, never a bank payment order", () => {
    const vm = buildBankPaymentGuaranteeAlertViewModel({
      sourceId: "episode-77",
      masterVariantId: "variant-77",
      product: "Solitaire Ring",
      variant: "14k Gold, US 6.5",
      reason: "at least one line's price changed via a human-approved publication (D22). Blocking 2 open bank payment order(s): order-a, order-b.",
      flaggedSince: FLAGGED_SINCE,
      now: FLAGGED_SINCE,
      resolved: false,
    });
    const email = renderAlertEmail(vm, "opened");

    expect(email.text).toContain("Unresolvable pricing episode: episode-77");
    expect(email.text).not.toContain("Bank payment order:");
    // The affected orders travel inside Reason, not a separate field.
    expect(email.text).toContain("Reason: at least one line's price changed via a human-approved publication (D22). Blocking 2 open bank payment order(s): order-a, order-b.");
  });

  it("never prints a 48h-cutoff countdown — no automatic suspension applies to this kind", () => {
    const vm = buildBankPaymentGuaranteeAlertViewModel({
      sourceId: "episode-77",
      masterVariantId: "variant-77",
      product: "Solitaire Ring",
      variant: "14k Gold, US 6.5",
      reason: "unresolvable",
      flaggedSince: FLAGGED_SINCE,
      now: new Date(FLAGGED_SINCE.getTime() + HOUR_MS),
      resolved: false,
    });
    const email = renderAlertEmail(vm, "opened");
    expect(email.text).not.toContain("Time remaining before 48h cutoff");
  });

  it("distinguishes 'opened' from 'resolved' in the subject and status line", () => {
    const opened = buildBankPaymentGuaranteeAlertViewModel({
      sourceId: "episode-77",
      masterVariantId: "variant-77",
      product: "Solitaire Ring",
      variant: "14k Gold, US 6.5",
      reason: "unresolvable",
      flaggedSince: FLAGGED_SINCE,
      now: FLAGGED_SINCE,
      resolved: false,
    });
    const resolved = buildBankPaymentGuaranteeAlertViewModel({
      sourceId: "episode-77",
      masterVariantId: "variant-77",
      product: "Solitaire Ring",
      variant: "14k Gold, US 6.5",
      reason: "the variant's published price is resolvable again",
      flaggedSince: FLAGGED_SINCE,
      now: new Date(FLAGGED_SINCE.getTime() + HOUR_MS),
      resolved: true,
    });

    const openedEmail = renderAlertEmail(opened, "opened");
    const resolvedEmail = renderAlertEmail(resolved, "resolved");

    expect(openedEmail.subject).toContain("New");
    expect(openedEmail.text).toContain("Status: open");
    expect(resolvedEmail.subject).toContain("Resolved");
    expect(resolvedEmail.text).toContain("Status: resolved");
  });
});
