import { describe, expect, it } from "vitest";

import {
  decideGuaranteeOutcome,
  type GuaranteeDecisionInput,
  type GuaranteeDecisionLine,
  type VariantPriceFacts,
} from "./guaranteeDecision";

/**
 * Table tests for the pure guarantee decision (spec §13/D22, criteria
 * 78-82, 96). Every case is phrased as the fact pattern a repository could
 * plausibly hand this function, not as an implementation detail of how the
 * facts were gathered — that half lives in `guaranteeFacts.server.ts`'s own
 * (integration-tested) territory.
 */

const QUOTED_AT = new Date("2026-09-20T12:00:00.000Z");
const GUARANTEE_EXPIRES_AT = new Date("2026-09-21T12:00:00.000Z"); // quotedAt + 24h
const BEFORE_EXPIRY = new Date("2026-09-21T11:59:59.999Z");
const AT_EXPIRY = new Date(GUARANTEE_EXPIRES_AT); // exactly 24h — the named boundary case
const AFTER_EXPIRY = new Date("2026-09-21T12:00:00.001Z");

const VARIANT_A = "11111111-1111-1111-1111-111111111111";
const VARIANT_B = "22222222-2222-2222-2222-222222222222";

const UNCHANGED_FACTS: VariantPriceFacts = {
  publishedBankPaymentPriceMinorUnits: 100_000n,
  unresolvableEpisodeId: null,
  unresolvableEpisodeFirstFailedAt: null,
  humanApprovedPublicationSinceQuote: false,
  humanDrivenOverrideSinceQuote: false,
};

function line(overrides: Partial<GuaranteeDecisionLine> = {}): GuaranteeDecisionLine {
  return {
    masterVariantId: VARIANT_A,
    quotedBankPaymentPriceMinorUnits: 100_000n,
    facts: { ...UNCHANGED_FACTS },
    ...overrides,
  };
}

function baseInput(overrides: Partial<GuaranteeDecisionInput> = {}): GuaranteeDecisionInput {
  return {
    status: "open",
    paymentVerified: false,
    quotedAt: QUOTED_AT,
    guaranteeExpiresAt: GUARANTEE_EXPIRES_AT,
    now: AFTER_EXPIRY,
    lines: [line()],
    ...overrides,
  };
}

describe("step 1 — already settled orders are never touched", () => {
  it.each(["cancelled", "completed"] as const)(
    "keeps a %s order regardless of price facts",
    (status) => {
      const decision = decideGuaranteeOutcome(
        baseInput({
          status,
          lines: [
            line({
              facts: {
                publishedBankPaymentPriceMinorUnits: 999_999n,
                unresolvableEpisodeId: null,
                unresolvableEpisodeFirstFailedAt: null,
                humanApprovedPublicationSinceQuote: true,
                humanDrivenOverrideSinceQuote: false,
              },
            }),
          ],
        }),
      );
      expect(decision.action).toBe("keep");
    },
  );

  it("keeps an order whose payment is already verified, even though status still reads open", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        paymentVerified: true,
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 999_999n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("keep");
    expect(decision.reason).toMatch(/verified/i);
  });
});

describe("step 2 — the 24-hour guarantee boundary", () => {
  it("keeps an order strictly before expiry, whatever the price facts", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        now: BEFORE_EXPIRY,
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 200_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("keep");
  });

  it("NAMED BOUNDARY CASE — exactly 24h is already past-guarantee, not still-within", () => {
    // At the exact instant of expiry, a human-approved change must already
    // be eligible to cancel. A `<=` boundary bug would instead read this as
    // "keep" for one more instant than the 24-hour promise allows.
    const decision = decideGuaranteeOutcome(
      baseInput({
        now: AT_EXPIRY,
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 200_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
  });

  it("one millisecond after expiry is past-guarantee", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        now: AFTER_EXPIRY,
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 200_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
  });
});

describe("step 3 — an unresolvable price flags rather than cancels (D21, criterion 82)", () => {
  it("flags when the only line is unresolvable", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: null,
              unresolvableEpisodeId: "episode-1",
              unresolvableEpisodeFirstFailedAt: new Date(
                "2026-09-20T00:00:00.000Z",
              ),
              humanApprovedPublicationSinceQuote: false,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("flag");
    expect(decision.cancellingLines).toBeUndefined();
  });

  it("flags — NEVER cancels — even when a SECOND line shows a clear human-approved change", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            masterVariantId: VARIANT_A,
            facts: {
              publishedBankPaymentPriceMinorUnits: null,
              unresolvableEpisodeId: "episode-1",
              unresolvableEpisodeFirstFailedAt: new Date(
                "2026-09-20T00:00:00.000Z",
              ),
              humanApprovedPublicationSinceQuote: false,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
          line({
            masterVariantId: VARIANT_B,
            quotedBankPaymentPriceMinorUnits: 50_000n,
            facts: {
              publishedBankPaymentPriceMinorUnits: 50_001n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("flag");
  });
});

describe("step 4 — cancellation requires BOTH a price change AND a human-driven publication", () => {
  it("keeps an order with only AUTOMATIC publications, even though the price moved", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 100_100n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null, // 1 cent-scale automatic drift
              humanApprovedPublicationSinceQuote: false,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("keep");
    expect(decision.reason).toMatch(/automatic/i);
  });

  it("keeps an order where a human republished but the price landed on the SAME value", () => {
    // A human can re-approve/republish onto an identical price (e.g.
    // re-confirming after a review delay). No price difference means no
    // customer was actually charged more or less — cancelling here would
    // punish them for nothing.
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 100_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null, // identical to quoted
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("keep");
  });

  it("cancels on a ONE-CENT human-approved change — no tolerance band", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 100_001n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
    expect(decision.cancellingLines).toEqual([
      {
        masterVariantId: VARIANT_A,
        quotedPriceMinorUnits: 100_000n,
        publishedPriceMinorUnits: 100_001n,
      },
    ]);
  });

  it("cancels on a human OVERRIDE published since the quote, independent of sync-intent approval", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            facts: {
              publishedBankPaymentPriceMinorUnits: 90_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: false,
              humanDrivenOverrideSinceQuote: true,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
  });

  /**
   * THE ORDERING A CURRENT-STATE CHECK GETS WRONG (D22 §13, the case the
   * team lead named explicitly). A human approves a 6% rise; overnight, an
   * automatic publication lands ON TOP of it. The CURRENT published
   * calculation is now the automatic one — a naive "was the latest
   * publication automatic" check would say "keep". The correct, historical
   * check still sees the human approval that happened between the quote and
   * now, and cancels.
   */
  it("HUMAN-APPROVAL-THEN-AUTO-PUBLISH: cancels even though the LATEST publication was automatic", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            facts: {
              // The final published price reflects the auto-publish that
              // landed on top of the human-approved one — but the
              // historical fact of the human approval is what the caller
              // is responsible for having still recorded as true.
              publishedBankPaymentPriceMinorUnits: 106_300n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
  });

  it("cancels when ANY line qualifies, even if another line did not change at all", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({ masterVariantId: VARIANT_A }), // unchanged
          line({
            masterVariantId: VARIANT_B,
            quotedBankPaymentPriceMinorUnits: 50_000n,
            facts: {
              publishedBankPaymentPriceMinorUnits: 55_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
    expect(decision.cancellingLines).toEqual([
      {
        masterVariantId: VARIANT_B,
        quotedPriceMinorUnits: 50_000n,
        publishedPriceMinorUnits: 55_000n,
      },
    ]);
  });

  it("names EVERY qualifying line, not just the first", () => {
    const decision = decideGuaranteeOutcome(
      baseInput({
        lines: [
          line({
            masterVariantId: VARIANT_A,
            facts: {
              publishedBankPaymentPriceMinorUnits: 100_001n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: true,
              humanDrivenOverrideSinceQuote: false,
            },
          }),
          line({
            masterVariantId: VARIANT_B,
            quotedBankPaymentPriceMinorUnits: 50_000n,
            facts: {
              publishedBankPaymentPriceMinorUnits: 49_000n,
              unresolvableEpisodeId: null,
              unresolvableEpisodeFirstFailedAt: null,
              humanApprovedPublicationSinceQuote: false,
              humanDrivenOverrideSinceQuote: true,
            },
          }),
        ],
      }),
    );
    expect(decision.action).toBe("cancel");
    expect(decision.cancellingLines).toHaveLength(2);
  });
});

describe("step 5 — no changes at all since the quote", () => {
  it("keeps an order where nothing published since the quote differs from what was charged", () => {
    const decision = decideGuaranteeOutcome(baseInput());
    expect(decision.action).toBe("keep");
  });
});
