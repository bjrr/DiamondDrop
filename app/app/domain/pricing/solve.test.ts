import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import {
  enforceFloors,
  evaluateFloors,
  solveExactBankPaymentPrice,
} from "./solve";
import { MarginFloorUnreachableError } from "./errors";
import type { FloorInput, SolveInput } from "./solve";
import type { PricingProfileInputs } from "./types";

/**
 * CRITERION 16, 17, 18 and CRITERION 35 — Price solve and floors (spec §5.3, §5.5).
 * `evaluateFloors` tested as a pure predicate without `enforceFloors` (criterion 35).
 */

/**
 * A minimal pricing profile for solve tests. `solveExactBankPaymentPrice` takes the
 * profile WHOLE — that is what keeps its signature stable as margin models are
 * added — so the tests build one here and override the one field under test.
 */
function profile(overrides: Partial<PricingProfileInputs> = {}): PricingProfileInputs {
  return {
    code: "buy_now",
    version: 1,
    marginModel: "TARGET_GROSS_MARGIN_V1",
    targetGrossMarginRate: "0.42",
    minGrossMarginRate: "0.35",
    minDollarProfit: { amountMinorUnits: "15000", currency: "USD" },
    roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
    priceEndingRuleId: "NONE_V1",
    autoApplyToleranceBps: null,
    regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
    fixedCardUpliftRate: "0.050000",
    isPlaceholder: false,
    ...overrides,
  };
}

describe("solveExactBankPaymentPrice (spec §5.3)", () => {
  const baseInput: SolveInput = {
    profile: profile(),
    landedCostMinorUnits: new MoneyDecimal("75365.25"),
    revenueRate: new MoneyDecimal("0.029"),
    revenueFixedMinorUnits: new MoneyDecimal("30"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("solves for margin-constrained price", () => {
    const result = solveExactBankPaymentPrice(baseInput);
    // P_margin = (75365.25 + 30) / (1 - 0.42 - 0.029)
    //          = 75395.25 / 0.551
    //          ≈ 136833.48...
    expect(result.binding).toBe("margin");
    expect(result.exactBankPayment.toString().startsWith("136833.4845735027223")).toBe(true);
  });

  it("uses min-profit when it exceeds margin (criterion 17)", () => {
    const highMinProfit: SolveInput = {
      ...baseInput,
      profile: profile({
        minDollarProfit: { amountMinorUnits: "200000", currency: "USD" }, // Very high
      }),
    };
    const result = solveExactBankPaymentPrice(highMinProfit);
    expect(result.binding).toBe("min_profit");
    // BANK PAYMENT BASIS (owner-locked 2026-09-18): bank − cost >= minProfit, so
    //   P_minProfit = 75365.25 + 200000 = 275365.25
    //
    // Formerly (75365.25 + 30 + 200000) / (1 − 0.029) = 283620.23..., which
    // solved for a profit NET of payment expense while the floor that checks it
    // is measured GROSS of it. The two disagreed by $82.55 on this variant.
    expect(result.exactBankPayment.greaterThan(solveExactBankPaymentPrice(baseInput).exactBankPayment)).toBe(true);
    expect(result.exactBankPayment.toString()).toBe("275365.25");
  });

  it("solves the min-profit price WITHOUT payment-processing expense", () => {
    // The point of the rule, isolated: the revenue-side rate and fixed fee must
    // make no difference to the minimum-profit price. Two solves that differ
    // only in those inputs must return the identical number.
    //
    // A single assertion on one value could pass against an implementation that
    // still divided by (1 − r) if r happened to be zero; comparing a fee-laden
    // solve against a fee-free one cannot.
    const withFees = solveExactBankPaymentPrice({
      ...baseInput,
      profile: profile({
        marginModel: "MARKUP_ON_COST_V1",
        targetMarkupRate: "0.40",
        minDollarProfit: { amountMinorUnits: "200000", currency: "USD" },
      }),
      revenueRate: new MoneyDecimal("0.029"),
      revenueFixedMinorUnits: new MoneyDecimal("30"),
    });
    const withoutFees = solveExactBankPaymentPrice({
      ...baseInput,
      profile: profile({
        marginModel: "MARKUP_ON_COST_V1",
        targetMarkupRate: "0.40",
        minDollarProfit: { amountMinorUnits: "200000", currency: "USD" },
      }),
      revenueRate: new MoneyDecimal("0"),
      revenueFixedMinorUnits: new MoneyDecimal("0"),
    });

    expect(withFees.binding).toBe("min_profit");
    expect(withFees.exactBankPayment.toString()).toBe(withoutFees.exactBankPayment.toString());
    expect(withFees.exactBankPayment.toString()).toBe("275365.25");
  });

  it("MARKUP_ON_COST_V1 ignores revenue-side inputs entirely", () => {
    // The MVP1 model. Cost x 1.40 and nothing else: a 40% markup on cost is a
    // statement about cost, and payment expense is not cost.
    const markup = (revenueRate: string, revenueFixed: string) =>
      solveExactBankPaymentPrice({
        ...baseInput,
        profile: profile({
          marginModel: "MARKUP_ON_COST_V1",
          targetMarkupRate: "0.40",
          minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
        }),
        landedCostMinorUnits: new MoneyDecimal("100000"),
        revenueRate: new MoneyDecimal(revenueRate),
        revenueFixedMinorUnits: new MoneyDecimal(revenueFixed),
      }).exactBankPayment.toString();

    expect(markup("0", "0")).toBe("140000");
    expect(markup("0.029", "30")).toBe("140000");
    expect(markup("0.5", "99999")).toBe("140000");
  });

  it("uses variant floor when it exceeds both constraints (criterion 17)", () => {
    const withFloor: SolveInput = {
      ...baseInput,
      variantFloorMinorUnits: new MoneyDecimal("999999"),
    };
    const result = solveExactBankPaymentPrice(withFloor);
    expect(result.binding).toBe("variant_floor");
    expect(result.exactBankPayment.toString()).toBe("999999");
  });

  it("throws UnreachableMarginError when 1 - m - r ≤ 0 (criterion 16)", () => {
    const unreachable: SolveInput = {
      ...baseInput,
      profile: profile({ targetGrossMarginRate: "0.97" }),
      revenueRate: new MoneyDecimal("0.05"),
      // 1 - 0.97 - 0.05 = -0.02 ≤ 0
    };
    expect(() => solveExactBankPaymentPrice(unreachable)).toThrow(/UnreachableMarginError|denominator/);
  });

  it("a revenue rate above 1 no longer breaks the MIN-PROFIT path", () => {
    // There used to be a guard here against dividing by (1 − r) when r >= 1.
    // The min-profit price no longer divides by anything, so an absurd revenue
    // rate cannot make it unsolvable — it is simply not consulted.
    //
    // The MARGIN model is a separate question: TARGET_GROSS_MARGIN_V1 still
    // puts r in a denominator and still refuses an impossible one. Asserted on
    // MARKUP_ON_COST_V1 so this test is about the min-profit path alone.
    const result = solveExactBankPaymentPrice({
      ...baseInput,
      profile: profile({
        marginModel: "MARKUP_ON_COST_V1",
        targetMarkupRate: "0.40",
        minDollarProfit: { amountMinorUnits: "200000", currency: "USD" },
      }),
      revenueRate: new MoneyDecimal("1.05"),
    });
    expect(result.binding).toBe("min_profit");
    expect(result.exactBankPayment.toString()).toBe("275365.25");
  });

  it("cost-side vs revenue-side yield different prices (criterion 16)", () => {
    // Test: same nominal rate (2%) as cost_side vs revenue_side
    // Cost-side: adds directly to C
    // Revenue-side: goes into denominator

    // Revenue-side case (base): rate 0.02 revenue-side
    const revenueSide = solveExactBankPaymentPrice({
      profile: profile({
        targetGrossMarginRate: "0.40",
        minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
      }),
      landedCostMinorUnits: new MoneyDecimal("100000"),
      revenueRate: new MoneyDecimal("0.02"),
      revenueFixedMinorUnits: new MoneyDecimal("0"),
      variantFloorMinorUnits: new MoneyDecimal("0"),
    });

    // Cost-side case: add 2% of base to cost
    const costSide = solveExactBankPaymentPrice({
      profile: profile({
        targetGrossMarginRate: "0.40",
        minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
      }),
      landedCostMinorUnits: new MoneyDecimal("102000"), // 100000 + (100000 * 0.02)
      revenueRate: new MoneyDecimal("0"),
      revenueFixedMinorUnits: new MoneyDecimal("0"),
      variantFloorMinorUnits: new MoneyDecimal("0"),
    });

    // Asserted individually, per criterion 16 — "different" alone would pass
    // against an implementation that got both wrong.
    //
    // revenue_side: the rate enters the DENOMINATOR.
    //   100000 / (1 - 0.40 - 0.02) = 100000 / 0.58 = 172413.793103...
    // cost_side: the same nominal rate is added to COST first.
    //   (100000 + 2000) / (1 - 0.40) = 102000 / 0.60 = 170000
    //
    // Revenue-side is the HIGHER of the two: 2% of the selling price is more
    // money than 2% of the cost that price is derived from. That asymmetry is
    // the entire reason §4.4 classifies components by basis.
    expect(costSide.exactBankPayment.toString()).toBe("170000");
    expect(revenueSide.exactBankPayment.toString().startsWith("172413.7931034482758620689655172413793")).toBe(true);
    expect(revenueSide.exactBankPayment.greaterThan(costSide.exactBankPayment)).toBe(true);
  });
});

describe("evaluateFloors (criterion 35 — predicate only, without loop)", () => {
  const baseInput: FloorInput = {
    bankPaymentPriceMinorUnits: 136833n,
    landedCostMinorUnits: new MoneyDecimal("75365.25"),
    minGrossMarginRate: new MoneyDecimal("0.35"),
    minDollarProfitMinorUnits: new MoneyDecimal("15000"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("measures contribution and margin on the BANK PAYMENT price, gross of fees", () => {
    const evaluation = evaluateFloors(baseInput);
    // Owner-locked 2026-09-18, at a bank payment price of $1,368.33:
    //   contribution = 136833 − 75365.25 = 61467.75   (= $614.68)
    //   gross margin = 61467.75 / 136833 = 0.449217...
    //
    // The former, fee-deducting definition gave 57469.593 and 0.419998 — about
    // three points lower on the same variant. Both numbers are asserted here
    // because the DIFFERENCE is the business decision; a test that only checked
    // `satisfied` would pass under either rule.
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.failing).toHaveLength(0);
    expect(evaluation.bankPaymentContributionMinorUnits).toBe("61467.75");
    expect(evaluation.bankPaymentGrossMarginRate.startsWith("0.4492")).toBe(true);
    expect(evaluation.basisId).toBe("BANK_PAYMENT_PRICE_GROSS_OF_PAYMENT_EXPENSE_V1");
  });

  it("gives the same answer whatever the payment-processing cost happens to be", () => {
    // The floors cannot see revenue-side inputs — FloorInput has no field for
    // them. This asserts the consequence at the only level a test can: the
    // margin on a given bank price and cost is a fixed number, so it is stated
    // exactly rather than compared against a second call that would be
    // identical by construction.
    //
    // Guarding the guard: if someone re-adds a fee deduction, this fails with a
    // lower margin rather than passing quietly.
    const evaluation = evaluateFloors({
      ...baseInput,
      bankPaymentPriceMinorUnits: 100000n,
      landedCostMinorUnits: new MoneyDecimal("75000"),
      minGrossMarginRate: new MoneyDecimal("0.25"),
      minDollarProfitMinorUnits: new MoneyDecimal("0"),
    });
    // 25000 / 100000 = exactly 0.25 — precisely AT the floor, which must pass.
    expect(evaluation.bankPaymentGrossMarginRate).toBe("0.25");
    expect(evaluation.satisfied).toBe(true);
  });

  it("clears the 20% floor on a 10% Group Buy tier over a 40% markup", () => {
    // The arithmetic the owner corrected, stated as a test rather than a
    // comment. Cost $1,000 -> bank base $1,400 -> 10% off = $1,260.
    //
    //   margin = (1260 − 1000) / 1260 = 20.63%
    //
    // Under the old fee-deducting rule this measured 17.8% and a campaign at
    // this tier could not be published.
    const evaluation = evaluateFloors({
      bankPaymentPriceMinorUnits: 126000n,
      landedCostMinorUnits: new MoneyDecimal("100000"),
      minGrossMarginRate: new MoneyDecimal("0.20"),
      minDollarProfitMinorUnits: new MoneyDecimal("10000"),
      variantFloorMinorUnits: new MoneyDecimal("0"),
    });
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.failing).toHaveLength(0);
    expect(evaluation.bankPaymentGrossMarginRate.startsWith("0.2063")).toBe(true);
  });

  it("detects when gross margin falls below minimum (criterion 18)", () => {
    const tooLowPrice: FloorInput = {
      ...baseInput,
      bankPaymentPriceMinorUnits: 100000n, // Too low
    };
    const evaluation = evaluateFloors(tooLowPrice);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.failing).toContain("min_gross_margin");
  });

  it("detects when dollar profit falls below minimum", () => {
    const tooLowPrice: FloorInput = {
      ...baseInput,
      minDollarProfitMinorUnits: new MoneyDecimal("100000"), // Require $1000 profit
      bankPaymentPriceMinorUnits: 100000n,
    };
    const evaluation = evaluateFloors(tooLowPrice);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.failing).toContain("min_dollar_profit");
  });

  it("detects when price below variant floor", () => {
    const belowFloor: FloorInput = {
      ...baseInput,
      variantFloorMinorUnits: new MoneyDecimal("200000"),
      bankPaymentPriceMinorUnits: 150000n,
    };
    const evaluation = evaluateFloors(belowFloor);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.failing).toContain("variant_floor");
  });

  it("distinguishes target from floor (criterion 18 inverse)", () => {
    // A price that clears the FLOOR while sitting below the TARGET must not be
    // bumped. Comparing against the target instead would nudge nearly every
    // price upward and look like it was working.
    const baseFloorInput: FloorInput = {
      bankPaymentPriceMinorUnits: 136833n,
      landedCostMinorUnits: new MoneyDecimal("75365.25"),
      minGrossMarginRate: new MoneyDecimal("0.35"), // floor
      minDollarProfitMinorUnits: new MoneyDecimal("15000"),
      variantFloorMinorUnits: new MoneyDecimal("0"),
    };
    const evaluation = evaluateFloors(baseFloorInput);
    expect(evaluation.satisfied).toBe(true);
    const grossMargin = new MoneyDecimal(evaluation.bankPaymentGrossMarginRate);
    // 0.4492 on this basis: above the 0.35 floor, below a 0.46 target.
    expect(grossMargin.greaterThanOrEqualTo("0.35")).toBe(true);
    expect(grossMargin.lessThan("0.46")).toBe(true);
  });

  it("returns unrounded contribution and margin as decimal strings", () => {
    const evaluation = evaluateFloors(baseInput);
    expect(typeof evaluation.bankPaymentContributionMinorUnits).toBe("string");
    expect(typeof evaluation.bankPaymentGrossMarginRate).toBe("string");
    // Should not be integers
    expect(evaluation.bankPaymentContributionMinorUnits).toMatch(/\./);
  });
});

describe("enforceFloors (spec §5.5 loop)", () => {
  const baseInput: FloorInput = {
    bankPaymentPriceMinorUnits: 136000n,
    landedCostMinorUnits: new MoneyDecimal("75365.25"),
    minGrossMarginRate: new MoneyDecimal("0.35"),
    minDollarProfitMinorUnits: new MoneyDecimal("15000"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("bumps price one minor unit at a time until floors pass (criterion 18)", () => {
    // A price a few minor units below the MIN GROSS MARGIN floor, on the bank
    // payment basis:
    //   (P − 75365.25) / P >= 0.35  =>  0.65P >= 75365.25  =>  P >= 115946.53...
    //
    // So 115943 falls four minor units short. The price must be only slightly
    // short: one far below the floor would exhaust the 100-iteration bound,
    // which is a different test (below).
    const violating: FloorInput = { ...baseInput, bankPaymentPriceMinorUnits: 115943n };
    expect(evaluateFloors(violating).satisfied).toBe(false);
    const result = enforceFloors(violating);
    expect(result.bumps).toBeGreaterThan(0);
    expect(result.bumps).toBeLessThanOrEqual(100);
    // Final price should satisfy all floors
    const finalEval = evaluateFloors({
      ...baseInput,
      bankPaymentPriceMinorUnits: result.bankPaymentPriceMinorUnits,
    });
    expect(finalEval.satisfied).toBe(true);
  });

  it("does not bump when floors already satisfied", () => {
    const highPrice: FloorInput = {
      ...baseInput,
      bankPaymentPriceMinorUnits: 200000n, // High enough
    };
    const result = enforceFloors(highPrice);
    expect(result.bumps).toBe(0);
    expect(result.bankPaymentPriceMinorUnits).toBe(200000n);
  });

  it("throws MarginFloorUnreachableError when bound exceeded (criterion 18)", () => {
    const impossible: FloorInput = {
      ...baseInput,
      minDollarProfitMinorUnits: new MoneyDecimal("999999999"), // Impossible
      minGrossMarginRate: new MoneyDecimal("0.99"), // Impossible
    };
    expect(() => enforceFloors(impossible, 100)).toThrow(MarginFloorUnreachableError);
  });

  it("respects custom maxBumps parameter", () => {
    const result = enforceFloors(baseInput, 5);
    expect(result.bumps).toBeLessThanOrEqual(5);
  });

  it("returns the final floor evaluation", () => {
    const result = enforceFloors(baseInput);
    expect(result.final.satisfied).toBe(true);
    expect(result.final.bankPaymentContributionMinorUnits).toBeDefined();
  });

  it("target margin does not trigger bumps (criterion 18 inverse)", () => {
    // Construct a case where price is below target but above floor
    const targetOnlyInput: FloorInput = {
      bankPaymentPriceMinorUnits: 136833n,
      landedCostMinorUnits: new MoneyDecimal("75365.25"),
      minGrossMarginRate: new MoneyDecimal("0.35"), // Low floor
      minDollarProfitMinorUnits: new MoneyDecimal("10000"), // Achievable
      variantFloorMinorUnits: new MoneyDecimal("0"),
    };
    const result = enforceFloors(targetOnlyInput);
    // §5.8: margin 0.419998 > floor 0.35 and profit $574.70 > $150
    // Price should pass without bumping
    expect(result.bumps).toBe(0);
  });
});
