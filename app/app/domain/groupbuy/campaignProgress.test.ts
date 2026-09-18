import { describe, expect, it } from "vitest";

import { CORE_MESSAGE, buildCampaignProgress } from "./campaignProgress";
import type { TierDefinition } from "./tiers";

/**
 * The storefront progress view (README "Live Savings / Progress").
 *
 * The README lists nine things the page shows and forbids two. Both halves are
 * tested, and the prohibitions matter more: a missing field is visible the
 * moment someone looks at the page, whereas a crowdfunding-style percentage
 * looks perfectly reasonable and misrepresents the product.
 */

const TIERS: TierDefinition[] = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
  { tierNumber: 3, minQualifyingUnits: 25, priceMultiplier: "0.800000" },
];

const PRICES = { 1: 40_000n, 2: 36_000n, 3: 32_000n };
const ASOF = new Date("2026-09-18T12:00:00Z");

function view(over: Partial<Parameters<typeof buildCampaignProgress>[0]> = {}) {
  return buildCampaignProgress({
    campaignCode: "spring-solitaire",
    currency: "USD",
    tiers: TIERS,
    qualifyingUnitsSold: 4,
    frozenBaseMinorUnits: 40_000n,
    buyNowPriceMinorUnits: 42_000n,
    tierPricesMinorUnits: PRICES,
    scheduledCloseAt: new Date("2026-09-25T12:00:00Z"),
    asOf: ASOF,
    ...over,
  });
}

describe("the nine required fields", () => {
  it("shows qualifying units sold", () => {
    expect(view({ qualifyingUnitsSold: 7 }).qualifyingUnitsSold).toBe(7);
  });

  it("shows the current tier as a DISCOUNT percentage, not the raw multiplier", () => {
    // Stored as 0.90; a shopper reads "10% off". Converting here keeps the
    // storefront from doing the subtraction and getting the direction wrong —
    // a mistake this project has already made once with the card uplift.
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.currentTierNumber).toBe(2);
    expect(v.currentDiscountPercent).toBe("10");
  });

  it("shows the next threshold and how many units are needed", () => {
    const v = view({ qualifyingUnitsSold: 4 });
    expect(v.nextThresholdUnits).toBe(10);
    expect(v.unitsToNextTier).toBe(6);
  });

  it("shows the selected variant's Group Buy price and the Buy Now comparison", () => {
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.groupBuyPriceMinorUnits).toBe("36000");
    expect(v.buyNowComparisonPriceMinorUnits).toBe("42000");
  });

  it("shows savings in dollars and percent, against BUY NOW", () => {
    // Measured against Buy Now, not the campaign base — those differ once Buy
    // Now moves, and the shopper's real alternative is buying it now.
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.savingsMinorUnits).toBe("6000");
    expect(v.savingsPercent).toBe("14.29");
  });

  it("shows the next-tier price and the additional saving it would bring", () => {
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.nextTierPriceMinorUnits).toBe("32000");
    expect(v.additionalSavingsMinorUnits).toBe("4000");
  });

  it("shows time remaining", () => {
    // Seven days.
    expect(view().secondsRemaining).toBe(7 * 24 * 60 * 60);
    expect(view().closesAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("shows tier markers, flagging which are unlocked and which is current", () => {
    const markers = view({ qualifyingUnitsSold: 12 }).tierMarkers;
    expect(markers.map((m) => m.unlocked)).toEqual([true, true, false]);
    expect(markers.map((m) => m.current)).toEqual([false, true, false]);
    expect(markers[2]!.priceMinorUnits).toBe("32000");
  });

  it("carries the README's core message", () => {
    expect(view().coreMessage).toBe(CORE_MESSAGE);
    expect(CORE_MESSAGE).toMatch(/your final price drops too/);
  });
});

describe("the two prohibitions", () => {
  it("produces NO crowdfunding-style funded percentage", () => {
    // README: "Do not use crowdfunding-funded percentages or imply a minimum is
    // required." A percentage-of-goal reads as money raised towards a target
    // that must be met — which is what a crowdfunder is and this is not.
    const keys = Object.keys(view());
    for (const forbidden of ["percentFunded", "funded", "goal", "target", "progressPercent"]) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });

  it("implies no minimum — one unit is already on tier 1", () => {
    // README: "There is no mandatory minimum buyer/unit count. One qualifying
    // unit can proceed at Tier 1." Progress is "units so far" and "units to the
    // next price", never a shortfall.
    const v = view({ qualifyingUnitsSold: 1 });
    expect(v.currentTierNumber).toBe(1);
    expect(v.groupBuyPriceMinorUnits).toBe("40000");

    const keys = Object.keys(v);
    for (const forbidden of ["minimumRequired", "shortfall", "remainingToMinimum"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("renders sensibly at zero units, without suggesting the campaign has failed", () => {
    const v = view({ qualifyingUnitsSold: 0 });
    expect(v.qualifyingUnitsSold).toBe(0);
    expect(v.currentTierNumber).toBe(1);
    expect(v.unitsToNextTier).toBe(10);
  });
});

describe("Best Price Unlocked", () => {
  it("is true only at the FINAL configured tier", () => {
    expect(view({ qualifyingUnitsSold: 25 }).bestPriceUnlocked).toBe(true);
    expect(view({ qualifyingUnitsSold: 1000 }).bestPriceUnlocked).toBe(true);
  });

  it("is false at every earlier tier, however good the discount", () => {
    expect(view({ qualifyingUnitsSold: 0 }).bestPriceUnlocked).toBe(false);
    expect(view({ qualifyingUnitsSold: 12 }).bestPriceUnlocked).toBe(false);
    expect(view({ qualifyingUnitsSold: 24 }).bestPriceUnlocked).toBe(false);
  });

  it("stops advertising a next tier once the best price is reached", () => {
    const v = view({ qualifyingUnitsSold: 25 });
    expect(v.nextThresholdUnits).toBeNull();
    expect(v.unitsToNextTier).toBeNull();
    expect(v.nextTierPriceMinorUnits).toBeNull();
    expect(v.additionalSavingsMinorUnits).toBeNull();
  });
});

describe("edges that would otherwise mislead a shopper", () => {
  it("never shows a NEGATIVE saving when Buy Now has fallen below the tier price", () => {
    // Buy Now can drop after a campaign freezes. Showing "-$40 savings" is
    // worse than showing none; the honest display is zero.
    const v = view({ qualifyingUnitsSold: 1, buyNowPriceMinorUnits: 30_000n });
    expect(v.savingsMinorUnits).toBe("0");
    // "0", not "0.00": these are exact decimal strings with trailing zeros
    // trimmed, and PRESENTATION formatting belongs to the storefront. Padding
    // here would mean the domain had an opinion about display.
    expect(v.savingsPercent).toBe("0");
  });

  it("shows no countdown for an open-ended campaign rather than inventing one", () => {
    const v = view({ scheduledCloseAt: null });
    expect(v.closesAt).toBeNull();
    expect(v.secondsRemaining).toBeNull();
  });

  it("clamps a past close time to zero rather than counting down past it", () => {
    const v = view({ scheduledCloseAt: new Date("2026-09-17T12:00:00Z") });
    expect(v.secondsRemaining).toBe(0);
  });

  it("throws rather than substituting a price it was not given", () => {
    // Silently falling back to the base would show a customer a price the
    // campaign never offered.
    expect(() => view({ tierPricesMinorUnits: { 1: 40_000n } })).toThrow(/No price supplied for tier/);
  });
});

describe("nothing cost-related crosses this boundary", () => {
  it("exposes no cost, margin, floor or profile field", () => {
    // CLAUDE.md: never expose supplier-private cost data or admin-only margins
    // to storefront clients. The view model has no field for any of it, which
    // is what makes this structural rather than a habit.
    const serialised = JSON.stringify(view()).toLowerCase();

    for (const leak of [
      "landedcost",
      "cost",
      "margin",
      "profit",
      "floor",
      "profile",
      "multiplier",
      "supplier",
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });
});
