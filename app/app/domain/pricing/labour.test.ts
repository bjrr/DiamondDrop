import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { calculateLandedCost, calculateManufacturingLabour } from "./cost";

/**
 * Manufacturing labour — grams x a rate per gram, chosen by manufacturing
 * source.
 *
 * Kept distinct from stone setting throughout. Setting is per-stone or fixed
 * and flows through the component loop; this scales with WEIGHT. Collapsing
 * them would make a heavy plain band and a light multi-stone piece report the
 * same labour figure, and the breakdown exists precisely to tell those apart.
 */

describe("calculateManufacturingLabour", () => {
  it("multiplies grams by the rate", () => {
    // 3.5g at $4.50/g = $15.75 = 1575 minor units.
    expect(
      calculateManufacturingLabour({
        ratePerGramMinorUnits: "450",
        weightGrams: "3.5000",
      }).toString()
    ).toBe("1575");
  });

  it("is exact on a weight a double cannot represent", () => {
    // 0.1 + 0.2 territory. 1.15g at $5.25/g is 603.75 minor units exactly;
    // a float path drifts in the last digits.
    const result = calculateManufacturingLabour({
      ratePerGramMinorUnits: "525",
      weightGrams: "1.1500",
    });
    expect(result.toString()).toBe("603.75");
  });

  it("scales linearly with weight — the property that makes it not a flat fee", () => {
    const light = calculateManufacturingLabour({ ratePerGramMinorUnits: "450", weightGrams: "2" });
    const heavy = calculateManufacturingLabour({ ratePerGramMinorUnits: "450", weightGrams: "8" });
    expect(new MoneyDecimal(heavy).dividedBy(light).toString()).toBe("4");
  });

  it("returns zero for a zero rate, which is a legitimate configuration", () => {
    expect(
      calculateManufacturingLabour({ ratePerGramMinorUnits: "0", weightGrams: "5" }).toString()
    ).toBe("0");
  });
});

describe("manufacturing labour inside the landed cost", () => {
  const base = {
    pricePerGramMinorUnits: "5000",
    weightGrams: "4.0000",
    stones: [],
    components: [],
  };

  it("is included in the landed cost", () => {
    const without = calculateLandedCost(base);
    const with_ = calculateLandedCost({ ...base, laborRatePerGramMinorUnits: "450" });

    // 4g x 450 = 1800 minor units more.
    expect(
      new MoneyDecimal(with_.landedCost).minus(without.landedCost).toString()
    ).toBe("1800");
  });

  it("is itemised separately from the other labour components", () => {
    const result = calculateLandedCost({ ...base, laborRatePerGramMinorUnits: "450" });

    expect(result.breakdown.manufacturingLabourMinorUnits).toBe("1800");
    // The headline labour figure includes it.
    expect(result.breakdown.labourMinorUnits).toBe("1800");
  });

  it("does NOT conflate itself with per-stone setting", () => {
    // A setting charge and a grams-based rate must both appear, and the
    // grams-based line must report only the grams-based part.
    const result = calculateLandedCost({
      ...base,
      stones: [{ position: 1, quantity: 2, unitCost: { amountMinorUnits: "1000", currency: "USD" } }],
      components: [
        {
          componentType: "setting",
          basis: "cost_side",
          valueKind: "per_stone",
          amount: { amountMinorUnits: "300", currency: "USD" },
        },
      ],
      laborRatePerGramMinorUnits: "450",
    });

    // Grams-based portion alone: 4g x 450.
    expect(result.breakdown.manufacturingLabourMinorUnits).toBe("1800");
    // Headline labour also carries the 2 x 300 setting charge.
    expect(result.breakdown.labourMinorUnits).toBe("2400");
  });

  it("reports nothing when no rate is supplied, rather than guessing one", () => {
    const result = calculateLandedCost(base);
    expect(result.breakdown.manufacturingLabourMinorUnits).toBe("0");
  });

  it("a heavier piece from the same source costs more to make", () => {
    // The distinction a flat fee would erase.
    const light = calculateLandedCost({
      ...base,
      weightGrams: "2.0000",
      laborRatePerGramMinorUnits: "450",
    });
    const heavy = calculateLandedCost({
      ...base,
      weightGrams: "10.0000",
      laborRatePerGramMinorUnits: "450",
    });

    expect(light.breakdown.manufacturingLabourMinorUnits).toBe("900");
    expect(heavy.breakdown.manufacturingLabourMinorUnits).toBe("4500");
  });

  it("a US-made piece costs more than the same piece made in India", () => {
    // Rates are fixture values, but the ORDERING is the business fact worth
    // pinning: source selection must actually change the cost.
    const india = calculateLandedCost({ ...base, laborRatePerGramMinorUnits: "450" });
    const usa = calculateLandedCost({ ...base, laborRatePerGramMinorUnits: "1200" });

    expect(new MoneyDecimal(usa.landedCost).greaterThan(india.landedCost)).toBe(true);
  });

  it("percentage components apply to a cost that already includes labour", () => {
    // Ordering matters: a percentage applied to metal + stones alone would
    // understate itself on a labour-heavy piece.
    const withLabour = calculateLandedCost({
      ...base,
      components: [
        { componentType: "warranty_reserve", basis: "cost_side", valueKind: "percentage", rate: "0.10" },
      ],
      laborRatePerGramMinorUnits: "450",
    });

    // metal 20000 + labour 1800 = 21800; 10% = 2180.
    const reserve = withLabour.breakdown.perComponent.find(
      (c) => c.componentType === "warranty_reserve"
    );
    expect(reserve?.amountMinorUnits).toBe("2180");
  });
});
