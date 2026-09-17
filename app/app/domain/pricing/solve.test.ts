import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import {
  enforceFloors,
  evaluateFloors,
  solveExactPrice,
} from "./solve";
import { MarginFloorUnreachableError } from "./errors";
import type { FloorInput, SolveInput } from "./solve";

/**
 * CRITERION 16, 17, 18 and CRITERION 35 — Price solve and floors (spec §5.3, §5.5).
 * `evaluateFloors` tested as a pure predicate without `enforceFloors` (criterion 35).
 */

describe("solveExactPrice (spec §5.3)", () => {
  const baseInput: SolveInput = {
    marginModel: "TARGET_GROSS_MARGIN_V1",
    landedCostMinorUnits: new MoneyDecimal("75365.25"),
    targetGrossMarginRate: new MoneyDecimal("0.42"),
    revenueRate: new MoneyDecimal("0.029"),
    revenueFixedMinorUnits: new MoneyDecimal("30"),
    minDollarProfitMinorUnits: new MoneyDecimal("15000"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("solves for margin-constrained price", () => {
    const result = solveExactPrice(baseInput);
    // P_margin = (75365.25 + 30) / (1 - 0.42 - 0.029)
    //          = 75395.25 / 0.551
    //          ≈ 136833.48...
    expect(result.binding).toBe("margin");
    expect(result.exact.toString().startsWith("136833.4845735027223")).toBe(true);
  });

  it("uses min-profit when it exceeds margin (criterion 17)", () => {
    const highMinProfit: SolveInput = {
      ...baseInput,
      minDollarProfitMinorUnits: new MoneyDecimal("200000"), // Very high
    };
    const result = solveExactPrice(highMinProfit);
    expect(result.binding).toBe("min_profit");
    // P_minProfit = (75365.25 + 30 + 200000) / (1 - 0.029)
    //             = 275395.25 / 0.971
    expect(result.exact.greaterThan(solveExactPrice(baseInput).exact)).toBe(true);
    // (75365.25 + 30 + 200000) / 0.971 = 283620.236869207003...
    expect(result.exact.toString().startsWith("283620.2368692070")).toBe(true);
  });

  it("uses variant floor when it exceeds both constraints (criterion 17)", () => {
    const withFloor: SolveInput = {
      ...baseInput,
      variantFloorMinorUnits: new MoneyDecimal("999999"),
    };
    const result = solveExactPrice(withFloor);
    expect(result.binding).toBe("variant_floor");
    expect(result.exact.toString()).toBe("999999");
  });

  it("throws UnreachableMarginError when 1 - m - r ≤ 0 (criterion 16)", () => {
    const unreachable: SolveInput = {
      ...baseInput,
      targetGrossMarginRate: new MoneyDecimal("0.97"),
      revenueRate: new MoneyDecimal("0.05"),
      // 1 - 0.97 - 0.05 = -0.02 ≤ 0
    };
    expect(() => solveExactPrice(unreachable)).toThrow(/UnreachableMarginError|denominator/);
  });

  it("throws UnreachableMarginError when 1 - r ≤ 0", () => {
    const unreachable: SolveInput = {
      ...baseInput,
      revenueRate: new MoneyDecimal("1.05"),
      // 1 - 1.05 = -0.05 ≤ 0
    };
    expect(() => solveExactPrice(unreachable)).toThrow(/UnreachableMarginError|denominator/);
  });

  it("cost-side vs revenue-side yield different prices (criterion 16)", () => {
    // Test: same nominal rate (2%) as cost_side vs revenue_side
    // Cost-side: adds directly to C
    // Revenue-side: goes into denominator

    // Revenue-side case (base): rate 0.02 revenue-side
    const revenueSide = solveExactPrice({
      marginModel: "TARGET_GROSS_MARGIN_V1",
      landedCostMinorUnits: new MoneyDecimal("100000"),
      targetGrossMarginRate: new MoneyDecimal("0.40"),
      revenueRate: new MoneyDecimal("0.02"),
      revenueFixedMinorUnits: new MoneyDecimal("0"),
      minDollarProfitMinorUnits: new MoneyDecimal("0"),
      variantFloorMinorUnits: new MoneyDecimal("0"),
    });

    // Cost-side case: add 2% of base to cost
    const costSide = solveExactPrice({
      marginModel: "TARGET_GROSS_MARGIN_V1",
      landedCostMinorUnits: new MoneyDecimal("102000"), // 100000 + (100000 * 0.02)
      targetGrossMarginRate: new MoneyDecimal("0.40"),
      revenueRate: new MoneyDecimal("0"),
      revenueFixedMinorUnits: new MoneyDecimal("0"),
      minDollarProfitMinorUnits: new MoneyDecimal("0"),
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
    expect(costSide.exact.toString()).toBe("170000");
    expect(revenueSide.exact.toString().startsWith("172413.7931034482758620689655172413793")).toBe(true);
    expect(revenueSide.exact.greaterThan(costSide.exact)).toBe(true);
  });
});

describe("evaluateFloors (criterion 35 — predicate only, without loop)", () => {
  const baseInput: FloorInput = {
    priceMinorUnits: 136833n,
    landedCostMinorUnits: new MoneyDecimal("75365.25"),
    revenueRate: new MoneyDecimal("0.029"),
    revenueFixedMinorUnits: new MoneyDecimal("30"),
    minGrossMarginRate: new MoneyDecimal("0.35"),
    minDollarProfitMinorUnits: new MoneyDecimal("15000"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("evaluates all floors without bumping (criterion 18)", () => {
    const evaluation = evaluateFloors(baseInput);
    // §5.8 worked example at price $1,368.33:
    // deductions = 0.029 * 136833 + 30 = 3998.157
    // contribution = 136833 - 3998.157 - 75365.25 = 57469.593 (= $574.70)
    // gross margin = 57469.593 / 136833 ≈ 0.419998...
    // Satisfies min_gross_margin 0.35 and min_dollar_profit $150.00
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.failing).toHaveLength(0);
    expect(evaluation.contribution).toBe("57469.593");
  });

  it("detects when gross margin falls below minimum (criterion 18)", () => {
    const tooLowPrice: FloorInput = {
      ...baseInput,
      priceMinorUnits: 100000n, // Too low
    };
    const evaluation = evaluateFloors(tooLowPrice);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.failing).toContain("min_gross_margin");
  });

  it("detects when dollar profit falls below minimum", () => {
    const tooLowPrice: FloorInput = {
      ...baseInput,
      minDollarProfitMinorUnits: new MoneyDecimal("100000"), // Require $1000 profit
      priceMinorUnits: 100000n,
    };
    const evaluation = evaluateFloors(tooLowPrice);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.failing).toContain("min_dollar_profit");
  });

  it("detects when price below variant floor", () => {
    const belowFloor: FloorInput = {
      ...baseInput,
      variantFloorMinorUnits: new MoneyDecimal("200000"),
      priceMinorUnits: 150000n,
    };
    const evaluation = evaluateFloors(belowFloor);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.failing).toContain("variant_floor");
  });

  it("distinguishes target from floor (criterion 18 inverse)", () => {
    // §5.8 worked example: rounded price $1,368.33, margin 0.419998... vs target 0.42
    // Must NOT be bumped merely for landing below the target margin
    const baseFloorInput: FloorInput = {
      priceMinorUnits: 136833n,
      landedCostMinorUnits: new MoneyDecimal("75365.25"),
      revenueRate: new MoneyDecimal("0.029"),
      revenueFixedMinorUnits: new MoneyDecimal("30"),
      minGrossMarginRate: new MoneyDecimal("0.35"), // Floor is 0.35
      minDollarProfitMinorUnits: new MoneyDecimal("15000"),
      variantFloorMinorUnits: new MoneyDecimal("0"),
    };
    const evaluation = evaluateFloors(baseFloorInput);
    // Price satisfies the FLOOR (0.35), even though it's below the target (0.42)
    expect(evaluation.satisfied).toBe(true);
    const grossMargin = new MoneyDecimal(evaluation.grossMargin);
    expect(grossMargin.greaterThanOrEqualTo("0.35")).toBe(true);
    expect(grossMargin.lessThan("0.42")).toBe(true);
  });

  it("returns unrounded contribution and margin as decimal strings", () => {
    const evaluation = evaluateFloors(baseInput);
    expect(typeof evaluation.contribution).toBe("string");
    expect(typeof evaluation.grossMargin).toBe("string");
    // Should not be integers
    expect(evaluation.contribution).toMatch(/\./);
  });
});

describe("enforceFloors (spec §5.5 loop)", () => {
  const baseInput: FloorInput = {
    priceMinorUnits: 136000n, // Just below what we need
    landedCostMinorUnits: new MoneyDecimal("75365.25"),
    revenueRate: new MoneyDecimal("0.029"),
    revenueFixedMinorUnits: new MoneyDecimal("30"),
    minGrossMarginRate: new MoneyDecimal("0.35"),
    minDollarProfitMinorUnits: new MoneyDecimal("15000"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("bumps price one minor unit at a time until floors pass (criterion 18)", () => {
    // A price a few minor units below the MIN GROSS MARGIN floor.
    // margin = (0.971P - 75395.25) / P >= 0.35  =>  0.621P >= 75395.25
    //                                          =>  P >= 121409.42...
    // So 121405 falls just short and needs a handful of one-unit bumps. The
    // price must be only slightly short: a price far below the floor would
    // exhaust the 100-iteration bound, which is a different test (below).
    const violating: FloorInput = { ...baseInput, priceMinorUnits: 121405n };
    expect(evaluateFloors(violating).satisfied).toBe(false);
    const result = enforceFloors(violating);
    expect(result.bumps).toBeGreaterThan(0);
    expect(result.bumps).toBeLessThanOrEqual(100);
    // Final price should satisfy all floors
    const finalEval = evaluateFloors({
      ...baseInput,
      priceMinorUnits: result.priceMinorUnits,
    });
    expect(finalEval.satisfied).toBe(true);
  });

  it("does not bump when floors already satisfied", () => {
    const highPrice: FloorInput = {
      ...baseInput,
      priceMinorUnits: 200000n, // High enough
    };
    const result = enforceFloors(highPrice);
    expect(result.bumps).toBe(0);
    expect(result.priceMinorUnits).toBe(200000n);
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
    expect(result.final.contribution).toBeDefined();
  });

  it("target margin does not trigger bumps (criterion 18 inverse)", () => {
    // Construct a case where price is below target but above floor
    const targetOnlyInput: FloorInput = {
      priceMinorUnits: 136833n,
      landedCostMinorUnits: new MoneyDecimal("75365.25"),
      revenueRate: new MoneyDecimal("0.029"),
      revenueFixedMinorUnits: new MoneyDecimal("30"),
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
