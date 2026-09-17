import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";

import {
  applyCostSideComponents,
  calculateLandedCost,
  calculateMetalCost,
  calculateStoneCost,
  orderCostSideComponents,
  partitionRevenueSide,
} from "./cost";
import type {
  ResolvedCostComponent,
  ResolvedStonePosition,
} from "./types";

/**
 * CRITERION 14, 15 and CRITERION 35 — Cost calculations and component ordering (spec §5.2).
 * Pure unit tests. `orderCostSideComponents` tested in its own right (criterion 35).
 */

describe("calculateMetalCost", () => {
  it("multiplies price per gram by weight", () => {
    // 14K at $48.25/g, weight 3.5g → 48.25 * 3.5 = 168.875
    // In minor units: 4825 * 3.5 = 16887.5
    const result = calculateMetalCost({
      pricePerGramMinorUnits: "4825.000000",
      weightGrams: "3.5",
      metalLossRate: "0",
    });
    expect(result.toString()).toBe("16887.5");
  });

  it("applies metal loss rate", () => {
    // Base 10000, loss 2% → 10000 + (10000 * 0.02) = 10200
    const result = calculateMetalCost({
      pricePerGramMinorUnits: "10000",
      weightGrams: "1",
      metalLossRate: "0.02",
    });
    expect(result.toString()).toBe("10200");
  });

  it("handles zero metal loss", () => {
    const result = calculateMetalCost({
      pricePerGramMinorUnits: "4825",
      weightGrams: "3.5",
      metalLossRate: "0",
    });
    expect(result.toString()).toBe("16887.5");
  });

  it("handles high-precision decimals", () => {
    const result = calculateMetalCost({
      pricePerGramMinorUnits: "4825.000000",
      weightGrams: "3.5000",
      metalLossRate: "0.001500",
    });
    // 16887.5 x 0.0015 = 25.33125, so the total is exactly 16912.83125.
    // Compared as an exact decimal: converting to a float would defeat the
    // point of a money test, and the money-safety scan bans that conversion.
    expect(result.toString()).toBe("16912.83125");
  });
});

describe("calculateStoneCost", () => {
  it("sums fixed unitCost across positions", () => {
    const stones: ResolvedStonePosition[] = [
      {
        position: 1,
        quantity: 1,
        unitCost: Money.fromMinorUnits(42000n, "USD").toJSON(),
      },
      {
        position: 2,
        quantity: 12,
        unitCost: Money.fromMinorUnits(325n, "USD").toJSON(),
      },
    ];
    const { totalMinorUnits, stoneCount } = calculateStoneCost(stones);
    // 42000 + (325 * 12) = 42000 + 3900 = 45900
    expect(totalMinorUnits.toString()).toBe("45900");
    expect(stoneCount).toBe(13);
  });

  it("handles per-carat pricing", () => {
    const stones: ResolvedStonePosition[] = [
      {
        position: 1,
        quantity: 2,
        perCaratCost: "420.00", // $4.20/carat in minor units
        carat: "1.5",
      },
    ];
    const { totalMinorUnits, stoneCount } = calculateStoneCost(stones);
    // 420 * 1.5 * 2 = 1260
    expect(totalMinorUnits.toString()).toBe("1260");
    expect(stoneCount).toBe(2);
  });

  it("handles mixed fixed and per-carat", () => {
    const stones: ResolvedStonePosition[] = [
      {
        position: 1,
        quantity: 1,
        unitCost: Money.fromMinorUnits(100000n, "USD").toJSON(),
      },
      {
        position: 2,
        quantity: 1,
        perCaratCost: "500.00",
        carat: "2",
      },
    ];
    const { totalMinorUnits } = calculateStoneCost(stones);
    // 100000 + (500 * 2) = 101000
    expect(totalMinorUnits.toString()).toBe("101000");
  });

  it("returns zero stones and zero cost for empty array", () => {
    const { totalMinorUnits, stoneCount } = calculateStoneCost([]);
    expect(totalMinorUnits.toString()).toBe("0");
    expect(stoneCount).toBe(0);
  });
});

describe("orderCostSideComponents (criterion 35)", () => {
  it("sorts labour before overhead", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "warranty_reserve", basis: "cost_side", valueKind: "percentage" },
      { componentType: "casting", basis: "cost_side", valueKind: "fixed" },
      { componentType: "polishing", basis: "cost_side", valueKind: "fixed" },
    ];
    const sorted = orderCostSideComponents(components);
    const types = sorted.map((c) => c.componentType);
    expect(types).toEqual(["casting", "polishing", "warranty_reserve"]);
  });

  it("maintains the fixed §5.2 step-5 order for overhead", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "supplier_fee", basis: "cost_side", valueKind: "fixed" },
      { componentType: "packaging", basis: "cost_side", valueKind: "fixed" },
      { componentType: "shipping", basis: "cost_side", valueKind: "fixed" },
      { componentType: "insurance", basis: "cost_side", valueKind: "fixed" },
      { componentType: "warranty_reserve", basis: "cost_side", valueKind: "fixed" },
      { componentType: "other", basis: "cost_side", valueKind: "fixed" },
    ];
    const sorted = orderCostSideComponents(components);
    const types = sorted.map((c) => c.componentType);
    // Expected order per §5.2 step 5 overhead section
    expect(types).toEqual([
      "packaging",
      "shipping",
      "insurance",
      "warranty_reserve",
      "supplier_fee",
      "other",
    ]);
  });

  it("preserves labour order within labour section", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "qc", basis: "cost_side", valueKind: "fixed" },
      { componentType: "cad", basis: "cost_side", valueKind: "fixed" },
      { componentType: "polishing", basis: "cost_side", valueKind: "fixed" },
      { componentType: "casting", basis: "cost_side", valueKind: "fixed" },
    ];
    const sorted = orderCostSideComponents(components);
    const types = sorted.map((c) => c.componentType);
    expect(types).toEqual(["cad", "casting", "polishing", "qc"]);
  });

  it("filters out revenue-side components", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "percentage" },
      { componentType: "casting", basis: "cost_side", valueKind: "fixed" },
    ];
    const sorted = orderCostSideComponents(components);
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.componentType).toBe("casting");
  });

  it("filters out metal_loss component", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "metal_loss", basis: "cost_side", valueKind: "percentage" },
      { componentType: "casting", basis: "cost_side", valueKind: "fixed" },
    ];
    const sorted = orderCostSideComponents(components);
    expect(sorted.length).toBe(1);
    expect(sorted[0]!.componentType).toBe("casting");
  });

  it("sorts unknown components to the end, deterministically by name", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "unknown_z", basis: "cost_side", valueKind: "fixed" },
      { componentType: "casting", basis: "cost_side", valueKind: "fixed" },
      { componentType: "unknown_a", basis: "cost_side", valueKind: "fixed" },
    ];
    const sorted = orderCostSideComponents(components);
    const types = sorted.map((c) => c.componentType);
    expect(types).toEqual(["casting", "unknown_a", "unknown_z"]);
  });
});

describe("applyCostSideComponents", () => {
  it("applies fixed components", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "casting", basis: "cost_side", valueKind: "fixed", amount: { amountMinorUnits: "2500", currency: "USD" } },
    ];
    const subtotal = new MoneyDecimal("10000"); // $100
    const result = applyCostSideComponents(subtotal, components, 0);
    // 10000 + 2500 = 12500
    expect(result.total.toString()).toBe("12500");
    expect(result.perComponent[0]!.amount.toString()).toBe("2500");
  });

  it("applies per_stone components", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "setting", basis: "cost_side", valueKind: "per_stone", amount: { amountMinorUnits: "400", currency: "USD" } },
    ];
    const result = applyCostSideComponents(new MoneyDecimal("10000"), components, 5); // 5 stones
    // 10000 + (400 * 5) = 10000 + 2000 = 12000
    expect(result.total.toString()).toBe("12000");
    expect(result.perComponent[0]!.amount.toString()).toBe("2000");
  });

  it("applies percentage components to subtotal", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "warranty_reserve", basis: "cost_side", valueKind: "percentage", rate: "0.02" },
    ];
    const subtotal = new MoneyDecimal("10000"); // $100
    const result = applyCostSideComponents(subtotal, components, 0);
    // 10000 + (10000 * 0.02) = 10000 + 200 = 10200
    expect(result.total.toString()).toBe("10200");
    expect(result.perComponent[0]!.amount.toString()).toBe("200");
  });

  it("percentage applies to accumulating subtotal", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "casting", basis: "cost_side", valueKind: "fixed", amount: { amountMinorUnits: "1000", currency: "USD" } },
      { componentType: "warranty_reserve", basis: "cost_side", valueKind: "percentage", rate: "0.02" },
    ];
    const subtotal = new MoneyDecimal("10000");
    const result = applyCostSideComponents(subtotal, components, 0);
    // Step 1: 10000 + 1000 = 11000
    // Step 2: 11000 + (11000 * 0.02) = 11000 + 220 = 11220
    expect(result.total.toString()).toBe("11220");
    expect(result.perComponent[1]!.amount.toString()).toBe("220");
  });

  it("handles zero components", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "cad", basis: "cost_side", valueKind: "fixed", amount: { amountMinorUnits: "0", currency: "USD" } },
    ];
    const result = applyCostSideComponents(new MoneyDecimal("10000"), components, 0);
    expect(result.total.toString()).toBe("10000");
  });
});

describe("partitionRevenueSide", () => {
  it("sums revenue-side percentage rates", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "percentage", rate: "0.029" },
      { componentType: "insurance", basis: "revenue_side", valueKind: "percentage", rate: "0.015" },
    ];
    const { rate, fixedMinorUnits } = partitionRevenueSide(components);
    expect(rate.toString()).toBe("0.044");
    expect(fixedMinorUnits.toString()).toBe("0");
  });

  it("sums revenue-side fixed amounts", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "fixed", amount: { amountMinorUnits: "30", currency: "USD" } },
    ];
    const { rate, fixedMinorUnits } = partitionRevenueSide(components);
    expect(rate.toString()).toBe("0");
    expect(fixedMinorUnits.toString()).toBe("30");
  });

  it("combines rates and fixed amounts", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "percentage", rate: "0.029" },
      { componentType: "payment_fee", basis: "revenue_side", valueKind: "fixed", amount: { amountMinorUnits: "30", currency: "USD" } },
    ];
    const { rate, fixedMinorUnits } = partitionRevenueSide(components);
    expect(rate.toString()).toBe("0.029");
    expect(fixedMinorUnits.toString()).toBe("30");
  });

  it("ignores cost-side components", () => {
    const components: ResolvedCostComponent[] = [
      { componentType: "casting", basis: "cost_side", valueKind: "percentage", rate: "0.1" },
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "percentage", rate: "0.029" },
    ];
    const { rate } = partitionRevenueSide(components);
    expect(rate.toString()).toBe("0.029");
  });

  it("returns zero rate and zero fixed for empty array", () => {
    const { rate, fixedMinorUnits } = partitionRevenueSide([]);
    expect(rate.toString()).toBe("0");
    expect(fixedMinorUnits.toString()).toBe("0");
  });
});

describe("calculateLandedCost (spec §5.2 end-to-end)", () => {
  it("composes the full cost breakdown", () => {
    const input = {
      pricePerGramMinorUnits: "4825.000000",
      weightGrams: "3.5",
      stones: [
        {
          position: 1,
          quantity: 1,
          unitCost: Money.fromMinorUnits(42000n, "USD").toJSON(),
        },
        {
          position: 2,
          quantity: 12,
          unitCost: Money.fromMinorUnits(325n, "USD").toJSON(),
        },
      ] as ResolvedStonePosition[],
      components: [
        { componentType: "metal_loss", basis: "cost_side" as const, valueKind: "percentage" as const, rate: "0" },
        { componentType: "casting", basis: "cost_side" as const, valueKind: "fixed" as const, amount: { amountMinorUnits: "2500", currency: "USD" } },
        { componentType: "setting", basis: "cost_side" as const, valueKind: "per_stone" as const, amount: { amountMinorUnits: "400", currency: "USD" } },
        { componentType: "polishing", basis: "cost_side" as const, valueKind: "fixed" as const, amount: { amountMinorUnits: "800", currency: "USD" } },
        { componentType: "qc", basis: "cost_side" as const, valueKind: "fixed" as const, amount: { amountMinorUnits: "500", currency: "USD" } },
        { componentType: "packaging", basis: "cost_side" as const, valueKind: "fixed" as const, amount: { amountMinorUnits: "600", currency: "USD" } },
        { componentType: "shipping", basis: "cost_side" as const, valueKind: "fixed" as const, amount: { amountMinorUnits: "1200", currency: "USD" } },
        { componentType: "insurance", basis: "cost_side" as const, valueKind: "fixed" as const, amount: { amountMinorUnits: "300", currency: "USD" } },
        { componentType: "warranty_reserve", basis: "cost_side" as const, valueKind: "percentage" as const, rate: "0.02" },
      ] as ResolvedCostComponent[],
    };

    const result = calculateLandedCost(input);
    const breakdown = result.breakdown;

    // Per §5.8 worked example intermediate values:
    expect(breakdown.metalMinorUnits).toBe("16887.5");
    expect(breakdown.stonesMinorUnits).toBe("45900");
    // Labour: casting + setting*13 + polishing + qc = 2500 + 5200 + 800 + 500 = 9000
    expect(breakdown.labourMinorUnits).toBe("9000");
    // Overhead: packaging + shipping + insurance = 600 + 1200 + 300 = 2100
    // Then warranty_reserve 2% of (16887.5 + 45900 + 9000 + 2100) = 2% of 73887.5 = 1477.75
    expect(breakdown.overheadMinorUnits).toBe("3577.75");
    // Landed cost: 16887.5 + 45900 + 9000 + 3577.75 = 75365.25
    expect(breakdown.landedCostMinorUnits).toBe("75365.25");
    expect(result.stoneCount).toBe(13);
  });

  it("handles missing metal_loss as 0%", () => {
    const input = {
      pricePerGramMinorUnits: "1000",
      weightGrams: "1",
      stones: [],
      components: [],
    };

    const result = calculateLandedCost(input);
    expect(result.breakdown.metalMinorUnits).toBe("1000");
  });
});
