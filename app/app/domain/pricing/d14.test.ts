import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { computeBuyNowPrice } from "./engine";
import { applyPriceEnding } from "./priceEnding";
import { enforceFloors, solveExactPrice } from "./solve";
import type { BuyNowPricingInputs, PricingProfileInputs } from "./types";

/**
 * D14 (owner-resolved 2026-09-17) — the four pricing controls:
 *   target markup 40% ON COST, minimum gross margin 20% OF PRICE,
 *   minimum dollar profit $100, whole-dollar price endings.
 *
 * These are BUSINESS NUMBERS, so the tests assert the owner's arithmetic
 * directly rather than re-deriving it from the implementation. A test that
 * computes its expectation the same way the code does would pass even if both
 * were wrong.
 */

describe("MARKUP_ON_COST_V1 (D14 target markup)", () => {
  const markupProfile = (overrides: Partial<PricingProfileInputs> = {}): PricingProfileInputs => ({
    code: "buy_now",
    version: 2,
    marginModel: "MARKUP_ON_COST_V1",
    targetMarkupRate: "0.40",
    minGrossMarginRate: "0.20",
    minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
    roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
    priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
    autoApplyToleranceBps: null,
    cardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
    cardUpliftRate: "0.050000",
    isPlaceholder: false,
    ...overrides,
  });

  const base = {
    profile: markupProfile(),
    landedCostMinorUnits: new MoneyDecimal("10000"), // $100.00
    revenueRate: new MoneyDecimal("0"),
    revenueFixedMinorUnits: new MoneyDecimal("0"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("prices at cost x 1.40, the owner's formula", () => {
    expect(solveExactPrice(base).exact.toString()).toBe("14000");
  });

  it("is NOT the same as a 40% gross margin — the distinction that motivated D14", () => {
    const markup = solveExactPrice(base).exact;
    const margin = solveExactPrice({
      ...base,
      profile: markupProfile({
        marginModel: "TARGET_GROSS_MARGIN_V1",
        targetMarkupRate: undefined,
        targetGrossMarginRate: "0.40",
      }),
    }).exact;

    expect(markup.toDecimalPlaces(2).toString()).toBe("14000"); // $140.00
    expect(margin.toDecimalPlaces(2).toString()).toBe("16666.67"); // $166.67

    // Confusing one for the other under-prices by ~16%. This assertion exists
    // so that a future "simplification" merging the two models fails loudly.
    expect(markup.lessThan(margin)).toBe(true);
  });

  it("realises a 28.6% gross margin on a 40% markup", () => {
    // The identity behind the warning above: markup m on cost yields a gross
    // margin of m/(1+m). 0.4/1.4 = 0.2857...
    const price = solveExactPrice(base).exact;
    const margin = price.minus(base.landedCostMinorUnits).dividedBy(price);
    expect(margin.toDecimalPlaces(4).toString()).toBe("0.2857");
  });

  it("refuses to price when the model's required rate is absent", () => {
    // A profile claiming MARKUP_ON_COST_V1 while carrying only a gross-margin
    // rate must fail loudly, not quietly fall back to the other model's number.
    expect(() =>
      solveExactPrice({
        ...base,
        profile: markupProfile({
          targetMarkupRate: undefined,
          targetGrossMarginRate: "0.40",
        }),
      })
    ).toThrow(/targetMarkupRate/);
  });

  it("still lets the minimum-profit floor outrank the markup target", () => {
    // $100 cost at 40% markup is $140 — only $40 of profit. The owner's $100
    // minimum dollar profit has to win.
    const { exact, binding } = solveExactPrice({
      ...base,
      profile: markupProfile({
        minDollarProfit: { amountMinorUnits: "10000", currency: "USD" },
      }),
    });
    expect(binding).toBe("min_profit");
    expect(exact.toString()).toBe("20000");
  });
});

describe("WHOLE_DOLLAR_UP_V1 (D14 price ending)", () => {
  it("rounds up to the next whole dollar", () => {
    expect(applyPriceEnding(33380n, "WHOLE_DOLLAR_UP_V1")).toBe(33400n);
  });

  it("leaves an exact dollar alone rather than adding one", () => {
    expect(applyPriceEnding(34900n, "WHOLE_DOLLAR_UP_V1")).toBe(34900n);
  });

  it("never rounds DOWN, so it can never push a price below a floor", () => {
    // This is why the rule is a ceiling rather than nearest. A nearest rule
    // would move 33449 down to 33400, possibly under the margin floor, which
    // the bump loop would then have to climb back out of.
    for (const cents of [1n, 49n, 50n, 51n, 99n]) {
      const price = 33400n + cents;
      expect(applyPriceEnding(price, "WHOLE_DOLLAR_UP_V1")).toBe(33500n);
      expect(applyPriceEnding(price, "WHOLE_DOLLAR_UP_V1")).toBeGreaterThan(price);
    }
  });
});

describe("floor bumping preserves the price ending", () => {
  const floorInput = {
    priceMinorUnits: 33400n,
    landedCostMinorUnits: new MoneyDecimal("23843"),
    revenueRate: new MoneyDecimal("0.029"),
    revenueFixedMinorUnits: new MoneyDecimal("30"),
    minGrossMarginRate: new MoneyDecimal("0.20"),
    minDollarProfitMinorUnits: new MoneyDecimal("10000"),
    variantFloorMinorUnits: new MoneyDecimal("0"),
  };

  it("steps by a whole dollar when the ending rule is whole-dollar", () => {
    const { priceMinorUnits, final } = enforceFloors(floorInput, 100, 100n);
    expect(final.satisfied).toBe(true);
    expect(priceMinorUnits % 100n).toBe(0n);
  });

  it("would otherwise land on a price ending in cents — the bug the step guards", () => {
    // With the default one-minor-unit step the loop clears the floor at a price
    // ending in cents, quietly undoing the whole-dollar rule applied moments
    // earlier. Asserting the WRONG behaviour documents why the parameter
    // exists: if a change ever makes both paths agree, this fails and the guard
    // gets re-examined rather than silently carried forward.
    const { priceMinorUnits } = enforceFloors(floorInput, 10000, 1n);
    expect(priceMinorUnits % 100n).not.toBe(0n);
  });
});

describe("the engine end-to-end under the owner's D14 + D9 profile", () => {
  const inputs: BuyNowPricingInputs = {
    asOf: "2026-09-17T00:00:00.000Z",
    currency: "USD",
    size: "7",
    weight: {
      sizeAxis: "ring_size_us",
      allowedSizeMin: "4",
      allowedSizeMax: "10",
      sizeIncrement: "0.5",
      baseSize: "7",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.1000",
    },
    metalPricePerGramMinorUnits: "5000.00",
    stones: [],
    components: [
      {
        componentType: "payment_processing",
        basis: "revenue_side",
        valueKind: "percentage",
        rate: "0.029000",
      },
    ],
    profile: {
      code: "buy_now",
      version: 2,
      marginModel: "MARKUP_ON_COST_V1",
      targetMarkupRate: "0.400000",
      minGrossMarginRate: "0.200000",
      minDollarProfit: { amountMinorUnits: "10000", currency: "USD" },
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      autoApplyToleranceBps: null,
      cardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      cardUpliftRate: "0.050000",
      isPlaceholder: false,
    },
  };

  it("produces a whole-dollar cash price that satisfies both owner floors", () => {
    const result = computeBuyNowPrice(inputs);
    expect(BigInt(result.price.amountMinorUnits) % 100n).toBe(0n);
    expect(result.floors.satisfied).toBe(true);
    expect(new MoneyDecimal(result.floors.grossMargin).greaterThanOrEqualTo("0.20")).toBe(true);
    expect(new MoneyDecimal(result.floors.contribution).greaterThanOrEqualTo("10000")).toBe(true);
  });

  it("derives the card price from the FINAL cash price, not the exact solve", () => {
    const result = computeBuyNowPrice(inputs);
    const cash = new MoneyDecimal(result.price.amountMinorUnits);

    // Re-derivable from the recorded price and rate — that is D9's whole point.
    // Computed here from the OUTPUT, so it catches a card price derived from
    // the pre-bump exact figure rather than from the cash price actually used.
    const expected = cash.times("1.05").dividedBy(100).ceil().times(100);
    expect(result.cardPrice.amountMinorUnits).toBe(expected.toString());

    // The exact solve and the final cash price differ (rounding + ending), so
    // the assertion above is genuinely discriminating rather than trivially true.
    expect(new MoneyDecimal(result.exactPriceMinorUnits).equals(cash)).toBe(false);
  });

  it("gives a whole-dollar card price above the whole-dollar cash price", () => {
    const result = computeBuyNowPrice(inputs);
    expect(BigInt(result.cardPrice.amountMinorUnits) % 100n).toBe(0n);
    expect(BigInt(result.cardPrice.amountMinorUnits)).toBeGreaterThan(
      BigInt(result.price.amountMinorUnits)
    );
  });

  it("records the rule id and rate so a historical card price can be re-derived", () => {
    const result = computeBuyNowPrice(inputs);
    expect(result.cardPriceRuleId).toBe("CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1");
    expect(result.cardUpliftRate).toBe("0.050000");
  });

  it("binds the floors to the CASH price, so BOTH prices clear them", () => {
    // The reason the internal calculation is cash-based. An earlier revision
    // bound the floors to the displayed card price, which left cash sales
    // unprotected and put four of seven fixture prices under the $100 minimum.
    //
    // A deliberately cheap piece, well under the threshold where the minimum
    // profit binds.
    const cheap = computeBuyNowPrice({
      ...inputs,
      weight: { ...inputs.weight, baseWeightGrams: "1.5000" },
    });

    expect(cheap.floors.satisfied).toBe(true);

    // The card price is strictly higher, so it clears the same floors without
    // needing its own evaluation.
    expect(BigInt(cheap.cardPrice.amountMinorUnits)).toBeGreaterThan(
      BigInt(cheap.price.amountMinorUnits)
    );
  });

  it("measures margin and profit on the CASH price, not the displayed one", () => {
    // What the floors report must describe the price actually netted. Reporting
    // margin on the card price would overstate profitability on every cash sale.
    const result = computeBuyNowPrice(inputs);
    const cash = new MoneyDecimal(result.price.amountMinorUnits);
    const cost = new MoneyDecimal(result.breakdown.landedCostMinorUnits);

    // contribution = cash - revenue-side deductions - cost, so it must be
    // strictly below cash - cost, and nowhere near card - cost.
    const contribution = new MoneyDecimal(result.floors.contribution);
    expect(contribution.lessThan(cash.minus(cost))).toBe(true);
    expect(contribution.lessThan(new MoneyDecimal(result.cardPrice.amountMinorUnits).minus(cost))).toBe(true);
  });
});
