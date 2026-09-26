import { describe, expect, it } from "vitest";
import { DEFAULT_ROUNDING_RULE_ID } from "../money/rounding";
import {
  assertRmaRemedyTransition,
  computeRmaRemedy,
  InvalidRmaRemedyTransitionError,
  isRmaRemedyTerminal,
  RmaRemedyComputationError,
  type RmaRemedyStatus,
} from "./remedy";

const CURRENCY = "USD";
const ROUNDING = DEFAULT_ROUNDING_RULE_ID;

describe("computeRmaRemedy — standard window (criterion 186)", () => {
  it("is always a 100% refund to the original payment method, no fee", () => {
    const result = computeRmaRemedy({
      windowKind: "standard",
      requestedRemedyKind: null,
      eligibleMerchandiseAmountMinorUnits: 12345n,
      currency: CURRENCY,
      roundingRuleId: ROUNDING,
    });
    expect(result).toEqual({
      remedyKind: "refund_original_payment",
      merchandiseAmountMinorUnits: 12345n,
      restockingFeeMinorUnits: 0n,
      currency: CURRENCY,
    });
  });

  it("refuses a remedy choice in the standard window", () => {
    expect(() =>
      computeRmaRemedy({
        windowKind: "standard",
        requestedRemedyKind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: 10000n,
        currency: CURRENCY,
        roundingRuleId: ROUNDING,
      })
    ).toThrow(RmaRemedyComputationError);
  });
});

describe("computeRmaRemedy — late window (criteria 187, 189-191)", () => {
  it("100% merchandise credit carries no restocking fee", () => {
    const result = computeRmaRemedy({
      windowKind: "late",
      requestedRemedyKind: "merchandise_credit",
      eligibleMerchandiseAmountMinorUnits: 10000n,
      currency: CURRENCY,
      roundingRuleId: ROUNDING,
    });
    expect(result).toEqual({
      remedyKind: "merchandise_credit",
      merchandiseAmountMinorUnits: 10000n,
      restockingFeeMinorUnits: 0n,
      currency: CURRENCY,
    });
  });

  it("50% restocking-fee refund halves an even amount exactly", () => {
    const result = computeRmaRemedy({
      windowKind: "late",
      requestedRemedyKind: "refund_original_payment",
      eligibleMerchandiseAmountMinorUnits: 10000n,
      currency: CURRENCY,
      roundingRuleId: ROUNDING,
    });
    expect(result.remedyKind).toBe("refund_original_payment");
    expect(result.restockingFeeMinorUnits).toBe(5000n);
    expect(result.merchandiseAmountMinorUnits).toBe(5000n);
  });

  it("50% restocking-fee refund on an odd amount rounds half up, and still reconstructs exactly", () => {
    // 10001 * 0.5 = 5000.5 -> HALF_UP -> 5001.
    const result = computeRmaRemedy({
      windowKind: "late",
      requestedRemedyKind: "refund_original_payment",
      eligibleMerchandiseAmountMinorUnits: 10001n,
      currency: CURRENCY,
      roundingRuleId: ROUNDING,
    });
    expect(result.restockingFeeMinorUnits).toBe(5001n);
    expect(result.merchandiseAmountMinorUnits).toBe(5000n);
    // Criterion 191: no invented or lost minor unit.
    expect(result.merchandiseAmountMinorUnits + result.restockingFeeMinorUnits).toBe(10001n);
  });

  it("requires a customer-chosen remedy in the late window", () => {
    expect(() =>
      computeRmaRemedy({
        windowKind: "late",
        requestedRemedyKind: null,
        eligibleMerchandiseAmountMinorUnits: 10000n,
        currency: CURRENCY,
        roundingRuleId: ROUNDING,
      })
    ).toThrow(RmaRemedyComputationError);
  });

  it("refuses a negative eligible amount", () => {
    expect(() =>
      computeRmaRemedy({
        windowKind: "late",
        requestedRemedyKind: "merchandise_credit",
        eligibleMerchandiseAmountMinorUnits: -1n,
        currency: CURRENCY,
        roundingRuleId: ROUNDING,
      })
    ).toThrow(RmaRemedyComputationError);
  });

  it("a zero eligible amount produces a zero remedy with no fee, for either choice", () => {
    const credit = computeRmaRemedy({
      windowKind: "late",
      requestedRemedyKind: "merchandise_credit",
      eligibleMerchandiseAmountMinorUnits: 0n,
      currency: CURRENCY,
      roundingRuleId: ROUNDING,
    });
    expect(credit.merchandiseAmountMinorUnits).toBe(0n);

    const refund = computeRmaRemedy({
      windowKind: "late",
      requestedRemedyKind: "refund_original_payment",
      eligibleMerchandiseAmountMinorUnits: 0n,
      currency: CURRENCY,
      roundingRuleId: ROUNDING,
    });
    expect(refund.merchandiseAmountMinorUnits).toBe(0n);
    expect(refund.restockingFeeMinorUnits).toBe(0n);
  });
});

describe("RmaRemedy status lifecycle — criteria 194, 196, 204", () => {
  it("pending -> processing is legal", () => {
    expect(() => assertRmaRemedyTransition("pending", "processing")).not.toThrow();
  });

  it.each<RmaRemedyStatus>(["issued", "failed", "staff_review_required"])(
    "processing -> %s is legal",
    (to) => {
      expect(() => assertRmaRemedyTransition("processing", to)).not.toThrow();
    }
  );

  it("failed -> processing is legal (a retry follows the same path as the first attempt)", () => {
    expect(() => assertRmaRemedyTransition("failed", "processing")).not.toThrow();
  });

  it("staff_review_required -> processing is legal (D7: a human resolves it, then the same path retries)", () => {
    expect(() => assertRmaRemedyTransition("staff_review_required", "processing")).not.toThrow();
  });

  it("staff_review_required cannot jump straight to issued, bypassing the validated path", () => {
    expect(() => assertRmaRemedyTransition("staff_review_required", "issued")).toThrow(
      InvalidRmaRemedyTransitionError
    );
  });

  it("pending cannot jump straight to issued", () => {
    expect(() => assertRmaRemedyTransition("pending", "issued")).toThrow(InvalidRmaRemedyTransitionError);
  });

  it("issued is terminal — nothing may follow it", () => {
    expect(() => assertRmaRemedyTransition("issued", "processing")).toThrow(InvalidRmaRemedyTransitionError);
    expect(() => assertRmaRemedyTransition("issued", "failed")).toThrow(InvalidRmaRemedyTransitionError);
    expect(isRmaRemedyTerminal("issued")).toBe(true);
  });

  it("no other status is terminal", () => {
    expect(isRmaRemedyTerminal("pending")).toBe(false);
    expect(isRmaRemedyTerminal("processing")).toBe(false);
    expect(isRmaRemedyTerminal("failed")).toBe(false);
    expect(isRmaRemedyTerminal("staff_review_required")).toBe(false);
  });
});
