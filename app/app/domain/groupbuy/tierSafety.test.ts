import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { evaluateTierSafety, type TierSafetyVariantInput } from "./tierSafety";
import type { TierDefinition } from "./tiers";

/**
 * Pre-publication tier safety — README: "Before publication, validate every
 * allowed variant against configured minimum gross-margin percentage, minimum
 * dollar profit, and any variant-specific floor. Unsafe tiers must be blocked
 * or require an explicit authorized override."
 */

const TIERS: TierDefinition[] = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
  { tierNumber: 3, minQualifyingUnits: 25, priceMultiplier: "0.800000" },
];

const PROFILE = {
  minGrossMarginRate: "0.200000",
  minDollarProfit: { amountMinorUnits: "10000", currency: "USD" },
};

function variant(overrides: Partial<TierSafetyVariantInput> = {}): TierSafetyVariantInput {
  return {
    masterVariantId: "v1",
    frozenBaseMinorUnits: 100_000n, // $1,000
    landedCostMinorUnits: new MoneyDecimal("50000"), // $500
    revenueRate: new MoneyDecimal("0.029"),
    revenueFixedMinorUnits: new MoneyDecimal("30"),
    ...overrides,
  };
}

function run(variants: TierSafetyVariantInput[], tiers = TIERS) {
  return evaluateTierSafety({
    variants,
    tiers,
    profile: PROFILE,
    roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
    priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
    currency: "USD",
  });
}

describe("coverage", () => {
  it("evaluates EVERY variant against EVERY tier", () => {
    const report = run([variant({ masterVariantId: "a" }), variant({ masterVariantId: "b" })]);
    expect(report.results).toHaveLength(6); // 2 variants x 3 tiers
  });

  it("passes a campaign with comfortable margins at every tier", () => {
    const report = run([variant()]);
    expect(report.allSafe).toBe(true);
    expect(report.unsafe).toHaveLength(0);
  });
});

describe("floor breaches", () => {
  it("catches a deep tier that falls under the margin floor", () => {
    // Cost $850 against a $1,000 base: tier 3 at 80% is $800, below cost.
    const report = run([variant({ landedCostMinorUnits: new MoneyDecimal("85000") })]);

    expect(report.allSafe).toBe(false);
    const tier3 = report.unsafe.find((r) => r.tierNumber === 3);
    expect(tier3).toBeDefined();
    expect(tier3!.evaluation.failing).toContain("min_gross_margin");
  });

  it("catches an INTERMEDIATE tier via a variant floor, not just the deepest", () => {
    // The reason this checks every tier rather than only the last one. A
    // variant floor of $950 is cleared at tier 1 ($1,000) and breached at
    // tier 2 ($900) — so the FIRST unsafe tier is the middle one, and a
    // check that looked only at tier 3 would still have reported it, but a
    // check that assumed "only the deepest tier can fail" would mis-attribute
    // where the campaign actually stops being publishable.
    const report = run([
      variant({ variantFloorMinorUnits: new MoneyDecimal("95000") }),
    ]);

    const byTier = Object.fromEntries(report.results.map((r) => [r.tierNumber, r.safe]));
    expect(byTier[1]).toBe(true);
    expect(byTier[2]).toBe(false);
    expect(byTier[3]).toBe(false);

    const tier2 = report.unsafe.find((r) => r.tierNumber === 2)!;
    expect(tier2.evaluation.failing).toContain("variant_floor");
  });

  it("catches one unsafe variant among several safe ones", () => {
    const report = run([
      variant({ masterVariantId: "cheap-to-make" }),
      variant({ masterVariantId: "expensive", landedCostMinorUnits: new MoneyDecimal("85000") }),
    ]);

    expect(report.allSafe).toBe(false);
    expect(report.unsafe.every((r) => r.masterVariantId === "expensive")).toBe(true);
  });

  it("catches the minimum-dollar-profit floor independently of margin", () => {
    // A low-value item can clear 20% margin while never reaching $100 of
    // profit. Checking margin alone would pass it.
    const report = run([
      variant({
        frozenBaseMinorUnits: 20_000n, // $200
        landedCostMinorUnits: new MoneyDecimal("14000"), // $140
      }),
    ]);

    const tier3 = report.results.find((r) => r.tierNumber === 3)!;
    expect(tier3.evaluation.failing).toContain("min_dollar_profit");
  });
});

describe("it validates the price a customer would actually pay", () => {
  it("applies the rounding and price-ending rules before checking floors", () => {
    // $1,000 x 0.90 = $900 exactly; with whole-dollar-up the price is $900.
    // Checking an unrounded value would answer a question about a price nobody
    // is charged.
    const report = run([variant()]);
    const tier2 = report.results.find((r) => r.tierNumber === 2)!;

    expect(tier2.priceMinorUnits).toBe(90_000n);
    expect(tier2.priceMinorUnits % 100n).toBe(0n);
  });

  it("rounds a fractional tier price up to a whole dollar", () => {
    // 33333 x 0.80 = 26666.4 -> $267.00 under WHOLE_DOLLAR_UP_V1.
    const report = run([
      variant({ frozenBaseMinorUnits: 33_333n, landedCostMinorUnits: new MoneyDecimal("1000") }),
    ]);
    const tier3 = report.results.find((r) => r.tierNumber === 3)!;
    expect(tier3.priceMinorUnits).toBe(26_700n);
  });
});

describe("it reports rather than decides", () => {
  it("returns the breaches without throwing", () => {
    // Whether an unsafe tier is blocked or proceeds under an authorized
    // override is a publication decision; burying it in arithmetic would put
    // it out of reach of the person making it.
    expect(() => run([variant({ landedCostMinorUnits: new MoneyDecimal("99000") })])).not.toThrow();
  });

  it("gives the margin and contribution for each tier, so a human can judge", () => {
    const report = run([variant()]);
    for (const result of report.results) {
      expect(result.evaluation.grossMargin).toMatch(/^-?[0-9.]+$/);
      expect(result.evaluation.contribution).toMatch(/^-?[0-9.]+$/);
    }
  });
});
