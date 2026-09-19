import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { computeBuyNowBandPrice, computeBuyNowPrice } from "./engine";
import { PricingCurrencyMismatchError, UnreachableMarginError } from "./errors";
import type { BuyNowPricingInputs, ResolvedCostComponent } from "./types";

/**
 * CRITERION 13, 15, 16, 18, 20, 21 — the engine end to end (spec §5.6, §5.8).
 *
 * Every expected value below comes from the worked example in §5.8, which
 * states each intermediate independently of this implementation. Nothing here
 * is computed by calling the function under test.
 */

const usd = (amountMinorUnits: string) => ({ amountMinorUnits, currency: "USD" });

/** The §5.8 case, exactly. */
function workedExample(): BuyNowPricingInputs {
  return {
    asOf: "2026-06-01T00:00:00.000Z",
    currency: "USD",
    size: "8",
    weight: {
      sizeAxis: "ring_size_us",
      allowedSizeMin: "2",
      allowedSizeMax: "11",
      sizeIncrement: "0.5",
      baseSize: "6",
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
    },
    metalPricePerGramMinorUnits: "4825.000000",
    stones: [
      { position: 1, quantity: 1, unitCost: usd("42000") },
      { position: 2, quantity: 12, unitCost: usd("325") },
    ],
    components: [
      { componentType: "metal_loss", basis: "cost_side", valueKind: "percentage", rate: "0" },
      { componentType: "casting", basis: "cost_side", valueKind: "fixed", amount: usd("2500") },
      { componentType: "setting", basis: "cost_side", valueKind: "per_stone", amount: usd("400") },
      { componentType: "polishing", basis: "cost_side", valueKind: "fixed", amount: usd("800") },
      { componentType: "qc", basis: "cost_side", valueKind: "fixed", amount: usd("500") },
      { componentType: "packaging", basis: "cost_side", valueKind: "fixed", amount: usd("600") },
      { componentType: "shipping", basis: "cost_side", valueKind: "fixed", amount: usd("1200") },
      { componentType: "insurance", basis: "cost_side", valueKind: "fixed", amount: usd("300") },
      { componentType: "warranty_reserve", basis: "cost_side", valueKind: "percentage", rate: "0.02" },
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "percentage", rate: "0.029" },
      { componentType: "payment_processing", basis: "revenue_side", valueKind: "fixed", amount: usd("30") },
    ],
    profile: {
      code: "buy_now",
      version: 1,
      marginModel: "TARGET_GROSS_MARGIN_V1" as const,
      targetGrossMarginRate: "0.42",
      minGrossMarginRate: "0.35",
      minDollarProfit: usd("15000"),
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1" as const,
      fixedCardUpliftRate: "0.050000",
      autoApplyToleranceBps: 50,
      isPlaceholder: false,
    },
  };
}

describe("computeBuyNowPrice — the worked example (criterion 13)", () => {
  const result = computeBuyNowPrice(workedExample());

  it("weight at size 8 is 3.2 + (8 - 6) x 0.15 = 3.5 g", () => {
    expect(result.weightGrams).toBe("3.5");
  });

  it("metal = 4825 x 3.5 = 16887.5, with 0% loss", () => {
    expect(result.breakdown.metalMinorUnits).toBe("16887.5");
  });

  it("stones = 42000 + 12 x 325 = 45900", () => {
    expect(result.breakdown.stonesMinorUnits).toBe("45900");
  });

  it("labour = 2500 + 400x13 + 800 + 500 = 9000", () => {
    expect(result.breakdown.labourMinorUnits).toBe("9000");
  });

  it("overhead = 600 + 1200 + 300 + warranty 1477.75 = 3577.75", () => {
    expect(result.breakdown.overheadMinorUnits).toBe("3577.75");
  });

  it("landed cost C = 75365.25", () => {
    expect(result.breakdown.landedCostMinorUnits).toBe("75365.25");
  });

  it("P_exact = (75365.25 + 30) / 0.551", () => {
    // The spec shows this truncated with an ellipsis; the engine keeps full
    // precision, so the spec value is asserted as a prefix, not by equality.
    expect(result.exactBankPaymentPriceMinorUnits.startsWith("136833.484573502722323")).toBe(true);
  });

  it("rounds HALF_UP at the minor unit to 136833", () => {
    expect(result.bankPaymentPrice.amountMinorUnits).toBe("136833");
    expect(result.bankPaymentPrice.currency).toBe("USD");
  });

  it("bank payment contribution = 136833 − 75365.25 = 61467.75", () => {
    // The PRICE still follows the spec's worked example — TARGET_GROSS_MARGIN_V1
    // is unchanged and still solves net of the revenue-side rate. What changed
    // is how the FLOORS measure the result: gross of payment expense, per the
    // owner's 2026-09-18 rule. The spec's 57469.593 was the fee-deducted figure.
    expect(result.floors.bankPaymentContributionMinorUnits).toBe("61467.75");
    expect(result.floors.basisId).toBe("BANK_PAYMENT_PRICE_GROSS_OF_PAYMENT_EXPENSE_V1");
  });

  it("bank payment gross margin 0.449217... clears the 0.35 floor", () => {
    // 61467.75 / 136833. Three points above the 0.419998 the fee-deducting
    // definition reported for the identical price and cost.
    expect(result.floors.bankPaymentGrossMarginRate.startsWith("0.449217")).toBe(true);
    expect(result.floors.satisfied).toBe(true);
  });

  it("is NOT bumped for landing a fraction below the TARGET (criterion 18)", () => {
    // The subtle half of criterion 18: the solve aims at a 0.42 margin NET of
    // the 2.9% revenue-side rate, and rounding lands it a hair under. The floor
    // it is checked against is 0.35, measured on the bank price. Comparing the
    // rounded price against the target instead would bump nearly every price by
    // a cent and still look like it was working.
    expect(result.bumps).toBe(0);
  });

  it("records margin as the binding constraint", () => {
    expect(result.binding).toBe("margin");
  });
});

describe("computeBuyNowBandPrice (criterion 11)", () => {
  it("prices a band at its most expensive allowed size", () => {
    const band = computeBuyNowBandPrice({
      ...workedExample(),
      band: { label: "6.5-8", sizeMin: "6.5", sizeMax: "8" },
    });
    expect(band.perSize.map((p) => p.size)).toEqual(["6.5", "7", "7.5", "8"]);
    expect(band.bandBankPaymentPrice.amountMinorUnits).toBe("136833");
    expect(band.costBasisSize).toBe("8");
  });

  it("an override making an INTERIOR size dearest sets the band price", () => {
    // A band.sizeMax shortcut would price this band off size 8 and sell size
    // 7.5 below floor. The override makes 7.5 the heaviest, and therefore the
    // most expensive, size in the band.
    const inputs = workedExample();
    const band = computeBuyNowBandPrice({
      ...inputs,
      weight: { ...inputs.weight, overrides: { "7.5": "9.0000" } },
      band: { label: "6.5-8", sizeMin: "6.5", sizeMax: "8" },
    });
    expect(band.costBasisSize).toBe("7.5");

    const atMax = band.perSize.find((p) => p.size === "8")!;
    expect(BigInt(band.bandBankPaymentPrice.amountMinorUnits) > BigInt(atMax.bankPaymentPriceMinorUnits)).toBe(true);
  });
});

describe("engine guards", () => {
  it("throws on a currency mismatch rather than pricing (criterion 21)", () => {
    const inputs = workedExample();
    expect(() =>
      computeBuyNowPrice({
        ...inputs,
        stones: [{ position: 1, quantity: 1, unitCost: { amountMinorUnits: "42000", currency: "EUR" } }],
      })
    ).toThrow(PricingCurrencyMismatchError);
  });

  it("throws when margin plus revenue rates consume the whole price (criterion 16)", () => {
    const inputs = workedExample();
    expect(() =>
      computeBuyNowPrice({
        ...inputs,
        profile: { ...inputs.profile, targetGrossMarginRate: "0.98", minGrossMarginRate: "0.90" },
      })
    ).toThrow(UnreachableMarginError);
  });

  it("rounds exactly once — pre-rounding the metal cost would change the price (criterion 20)", () => {
    // Metal is 16887.5 minor units: exactly a half cent. Rounding it up to
    // 16888 before the margin is applied inflates C by 0.5, which divides
    // through 0.551 into about +0.9 minor units of price — enough to change
    // the rounded answer. The engine must give the unrounded-path result.
    const inputs = workedExample();
    const actual = computeBuyNowPrice(inputs);

    const preRoundedC = new MoneyDecimal("75365.25").plus("0.5");
    const wouldBe = preRoundedC.plus("30").dividedBy("0.551");

    expect(actual.exactBankPaymentPriceMinorUnits.startsWith("136833.4845")).toBe(true);
    expect(wouldBe.toString().startsWith("136834")).toBe(true);
    expect(actual.bankPaymentPrice.amountMinorUnits).toBe("136833");
  });

  it("a component present with value 0 computes normally (criterion 15)", () => {
    const inputs = workedExample();
    const zeroed: ResolvedCostComponent[] = inputs.components.map((c) =>
      c.componentType === "warranty_reserve" ? { ...c, rate: "0" } : c
    );
    const result = computeBuyNowPrice({ ...inputs, components: zeroed });
    // Landed cost drops by exactly the 1477.75 warranty reserve.
    expect(result.breakdown.landedCostMinorUnits).toBe("73887.5");
  });
});
