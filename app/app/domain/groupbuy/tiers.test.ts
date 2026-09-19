import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import {
  DEFAULT_TIER_COUNT,
  InvalidTierSetError,
  MAX_TIERS,
  MIN_TIERS,
  nextTier,
  selectTier,
  tierCashPriceExact,
  unitsToNextTier,
  validateTierSet,
  type TierDefinition,
} from "./tiers";

/**
 * Group Buy tiers — README "Group Buy — Locked MVP1 Direction".
 *
 * THE FIRST TEST IN THIS FILE IS THE IMPORTANT ONE. A widely-repeated
 * interpretation of this feature is "Tier 1 = 1–9, Tier 2 = 10+, 10% lower".
 * That is one valid two-tier configuration, not the model: the README specifies
 * three tiers by default, configurable from two to five per campaign. If 9, 10
 * or 0.90 ever appears as a constant in the implementation, a per-campaign
 * setting has silently become a product-wide one.
 */

const THREE_TIERS: TierDefinition[] = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
  { tierNumber: 3, minQualifyingUnits: 25, priceMultiplier: "0.850000" },
];

describe("nothing about the boundary is hard-coded", () => {
  it("honours a campaign's own thresholds, whatever they are", () => {
    // Two campaigns, entirely different boundaries, same code.
    const tight: TierDefinition[] = [
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 3, priceMultiplier: "0.950000" },
    ];
    const loose: TierDefinition[] = [
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 500, priceMultiplier: "0.700000" },
    ];

    expect(selectTier(tight, 3).tierNumber).toBe(2);
    expect(selectTier(loose, 3).tierNumber).toBe(1);
    expect(selectTier(loose, 500).tierNumber).toBe(2);
  });

  it("does not privilege the 1-9 / 10+ interpretation", () => {
    // At 9 units the widely-quoted reading says "still tier 1". That is true of
    // THREE_TIERS only because its threshold happens to be 10 — and false for a
    // campaign that set it elsewhere.
    const nine: TierDefinition[] = [
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 9, priceMultiplier: "0.900000" },
    ];
    expect(selectTier(THREE_TIERS, 9).tierNumber).toBe(1);
    expect(selectTier(nine, 9).tierNumber).toBe(2);
  });

  it("supports the full configurable range the README allows", () => {
    expect(MIN_TIERS).toBe(2);
    expect(MAX_TIERS).toBe(5);
    expect(DEFAULT_TIER_COUNT).toBe(3);

    const five: TierDefinition[] = [1, 2, 3, 4, 5].map((n) => ({
      tierNumber: n,
      minQualifyingUnits: n === 1 ? 1 : n * 10,
      priceMultiplier: new MoneyDecimal(1).minus(new MoneyDecimal(n - 1).dividedBy(20)).toString(),
    }));
    expect(() => validateTierSet(five)).not.toThrow();
  });
});

describe("threshold boundaries", () => {
  it("applies a tier AT its threshold, not one unit later", () => {
    // The classic off-by-one. At exactly 10 units tier 2 is live.
    expect(selectTier(THREE_TIERS, 9).tierNumber).toBe(1);
    expect(selectTier(THREE_TIERS, 10).tierNumber).toBe(2);
    expect(selectTier(THREE_TIERS, 11).tierNumber).toBe(2);
    expect(selectTier(THREE_TIERS, 24).tierNumber).toBe(2);
    expect(selectTier(THREE_TIERS, 25).tierNumber).toBe(3);
  });

  it("selects the HIGHEST tier reached, not the nearest", () => {
    // Far past the last threshold, the last tier still applies.
    expect(selectTier(THREE_TIERS, 10_000).tierNumber).toBe(3);
  });

  it("quotes tier 1 at zero units, so a campaign with no sales has a price", () => {
    expect(selectTier(THREE_TIERS, 0).tierNumber).toBe(1);
  });

  it("proceeds at tier 1 on a single unit — there is no minimum", () => {
    // README: "There is no mandatory minimum buyer/unit count. One qualifying
    // unit can proceed at Tier 1."
    expect(selectTier(THREE_TIERS, 1).tierNumber).toBe(1);
  });

  it("rejects a fractional or negative unit count", () => {
    // Units are counted pieces, not a measurement.
    expect(() => selectTier(THREE_TIERS, 2.5)).toThrow(InvalidTierSetError);
    expect(() => selectTier(THREE_TIERS, -1)).toThrow(InvalidTierSetError);
  });
});

describe("progress towards the next tier", () => {
  it("reports the next tier and the units still needed", () => {
    expect(nextTier(THREE_TIERS, 4)?.tierNumber).toBe(2);
    expect(unitsToNextTier(THREE_TIERS, 4)).toBe(6);
    expect(unitsToNextTier(THREE_TIERS, 9)).toBe(1);
  });

  it("reports nothing further at the final tier — Best Price Unlocked", () => {
    expect(nextTier(THREE_TIERS, 25)).toBeNull();
    expect(unitsToNextTier(THREE_TIERS, 25)).toBeNull();
    expect(unitsToNextTier(THREE_TIERS, 999)).toBeNull();
  });

  it("never reports a negative remaining count", () => {
    for (let units = 0; units <= 40; units++) {
      const remaining = unitsToNextTier(THREE_TIERS, units);
      if (remaining !== null) expect(remaining).toBeGreaterThan(0);
    }
  });
});

describe("tier set validation", () => {
  const valid = () => THREE_TIERS.map((t) => ({ ...t }));

  it("accepts a well-formed set", () => {
    expect(() => validateTierSet(valid())).not.toThrow();
  });

  it("rejects fewer than two or more than five tiers", () => {
    expect(() => validateTierSet([valid()[0]!])).toThrow(/between 2 and 5 tiers/);

    const six = [1, 2, 3, 4, 5, 6].map((n) => ({
      tierNumber: n,
      minQualifyingUnits: n === 1 ? 1 : n * 10,
      priceMultiplier: `0.${99 - n}0000`,
    }));
    expect(() => validateTierSet(six)).toThrow(/between 2 and 5 tiers/);
  });

  it("requires tier 1 to start at one unit", () => {
    const tiers = valid();
    tiers[0]!.minQualifyingUnits = 5;
    expect(() => validateTierSet(tiers)).toThrow(/must start at 1 qualifying unit/);
  });

  it("requires thresholds to ascend", () => {
    const tiers = valid();
    tiers[2]!.minQualifyingUnits = 10; // equal to tier 2
    expect(() => validateTierSet(tiers)).toThrow(/must exceed tier 2/);
  });

  it("requires later tiers to be CHEAPER", () => {
    // Selling more must not make the price worse — the storefront promises
    // "next-tier price and additional savings".
    const tiers = valid();
    tiers[2]!.priceMultiplier = "0.950000"; // more expensive than tier 2
    expect(() => validateTierSet(tiers)).toThrow(/must be lower than tier 2/);
  });

  it("rejects a multiplier above 1, which would price above the campaign base", () => {
    const tiers = valid();
    tiers[0]!.priceMultiplier = "1.100000";
    expect(() => validateTierSet(tiers)).toThrow(/exceeds 1/);
  });

  it("allows exactly 1 — a first tier at full price is a legitimate shape", () => {
    expect(() => validateTierSet(valid())).not.toThrow();
  });

  it("rejects a zero or negative multiplier", () => {
    const tiers = valid();
    tiers[2]!.priceMultiplier = "0";
    expect(() => validateTierSet(tiers)).toThrow(/greater than 0/);
  });

  it("reports EVERY problem at once, not just the first", () => {
    // Someone configuring a campaign should see everything wrong in one pass
    // rather than discovering faults one save at a time.
    const broken: TierDefinition[] = [
      { tierNumber: 1, minQualifyingUnits: 5, priceMultiplier: "1.500000" },
      { tierNumber: 2, minQualifyingUnits: 3, priceMultiplier: "1.600000" },
    ];
    const error = (() => {
      try {
        validateTierSet(broken);
      } catch (e) {
        return e as InvalidTierSetError;
      }
    })();

    expect(error).toBeInstanceOf(InvalidTierSetError);
    expect(error!.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("tier price", () => {
  it("multiplies the frozen base by the tier multiplier", () => {
    // README: Variant Group Price = Frozen Base x Applicable Tier Percentage.
    const price = tierCashPriceExact(new MoneyDecimal("40000"), THREE_TIERS[1]!);
    expect(price.toString()).toBe("36000");
  });

  it("treats the multiplier as a MULTIPLIER, not a discount rate", () => {
    // The trap this codebase has already hit once with the card uplift. 0.90
    // means 90% of base, not 90% off.
    const price = tierCashPriceExact(new MoneyDecimal("10000"), {
      tierNumber: 2,
      minQualifyingUnits: 10,
      priceMultiplier: "0.900000",
    });
    expect(price.toString()).toBe("9000");
    expect(price.toString()).not.toBe("1000");
  });

  it("returns the base unchanged at a multiplier of 1", () => {
    expect(tierCashPriceExact(new MoneyDecimal("12345"), THREE_TIERS[0]!).toString()).toBe("12345");
  });

  it("stays EXACT and unrounded, leaving rounding to the engine boundary", () => {
    // 33333 x 0.85 = 28333.05. Rounding here and again in the engine would
    // round twice, and double rounding drifts.
    const price = tierCashPriceExact(new MoneyDecimal("33333"), THREE_TIERS[2]!);
    expect(price.toString()).toBe("28333.05");
  });

  it("is exact on a value where float arithmetic diverges", () => {
    // 1002 x 0.9 is 901.8 exactly; the double path gives 901.8000000000001.
    const price = tierCashPriceExact(new MoneyDecimal("1002"), THREE_TIERS[1]!);
    expect(price.toString()).toBe("901.8");
  });
});
