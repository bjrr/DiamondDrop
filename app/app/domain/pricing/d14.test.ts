import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { Money } from "~/domain/money/money";

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
    cashPriceRuleId: "CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1",
    cashDiscountRate: "0.050000",
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
      cashPriceRuleId: "CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1",
      cashDiscountRate: "0.050000",
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

  it("derives the cash price from the FINAL list price, not the exact solve", () => {
    const result = computeBuyNowPrice(inputs);
    const list = new MoneyDecimal(result.price.amountMinorUnits);

    // Re-derivable from the recorded price and rate — that is D9's whole point.
    // Computed here from the OUTPUT, so it catches a cash price derived from the
    // pre-bump exact figure rather than from the list price actually charged.
    const expected = list.times("0.95").dividedBy(100).floor().times(100);
    expect(result.cashPrice.amountMinorUnits).toBe(expected.toString());

    // The exact solve and the final list price differ (rounding + ending), so
    // the assertion above is genuinely discriminating rather than trivially true.
    expect(new MoneyDecimal(result.exactPriceMinorUnits).equals(list)).toBe(false);
  });

  it("delivers AT LEAST the advertised discount, never less", () => {
    // The reason the cash rule floors rather than rounds. A $349 list at 5% is
    // $331.55; rounding up to $332 would advertise 5% and deliver 4.87%.
    const result = computeBuyNowPrice(inputs);
    const list = new MoneyDecimal(result.price.amountMinorUnits);
    const cash = new MoneyDecimal(result.cashPrice.amountMinorUnits);
    const realised = list.minus(cash).dividedBy(list);

    expect(realised.greaterThanOrEqualTo("0.05")).toBe(true);
    // Sanity bound: flooring to a whole dollar can never overshoot by more than
    // $1, so the realised discount stays close to the advertised one.
    expect(realised.lessThan("0.06")).toBe(true);
  });

  it("gives a whole-dollar cash price below the whole-dollar list price", () => {
    const result = computeBuyNowPrice(inputs);
    expect(BigInt(result.cashPrice.amountMinorUnits) % 100n).toBe(0n);
    expect(BigInt(result.cashPrice.amountMinorUnits)).toBeLessThan(
      BigInt(result.price.amountMinorUnits)
    );
  });

  it("records the rule id and rate so a historical cash price can be re-derived", () => {
    const result = computeBuyNowPrice(inputs);
    expect(result.cashPriceRuleId).toBe("CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1");
    expect(result.cashDiscountRate).toBe("0.050000");
  });

  it("lets the discount take the cash price BELOW the minimum profit, by owner instruction", () => {
    // D9, owner-revised: "5% should override any profit minimums." The floors
    // bind the LIST price; the cash price may fall through them. With the MVP1
    // numbers this happens under $303.03 of landed cost.
    //
    // A cheap piece: 1.5g at $50/g is $75 of metal, far under that threshold.
    const cheap = computeBuyNowPrice({
      ...inputs,
      weight: { ...inputs.weight, baseWeightGrams: "1.5000" },
    });

    // The LIST price still satisfies every floor — the override does not weaken
    // the constraint that actually governs what is published.
    expect(cheap.floors.satisfied).toBe(true);

    // The CASH price does not, and that is the approved outcome rather than a
    // defect. Asserted explicitly so that "fixing" it by clamping cash up to the
    // floor — which would silently cancel the discount on exactly the items it
    // was meant for — fails this test.
    expect(cheap.cashFloors.satisfied).toBe(false);
    expect(cheap.cashFloors.failing).toContain("min_dollar_profit");

    // Still a real price, and still above cost: the override extends to the
    // profit minimums, not to selling at a loss.
    expect(BigInt(cheap.cashPrice.amountMinorUnits)).toBeGreaterThan(
      BigInt(Money.fromDecimalMinorUnits(
        new MoneyDecimal(cheap.breakdown.landedCostMinorUnits),
        "USD",
        "HALF_UP_MINOR_UNIT_V1"
      ).amountMinorUnits)
    );
  });

  it("records the cash floor evaluation even when it passes", () => {
    // "Checked and satisfied" must be distinguishable from "never evaluated",
    // or "how often does the discount go under the minimum?" is unanswerable.
    const result = computeBuyNowPrice(inputs);
    expect(result.cashFloors).toBeDefined();
    expect(typeof result.cashFloors.satisfied).toBe("boolean");
    expect(result.cashFloors.grossMargin).toMatch(/^[0-9.-]+$/);
  });
});
