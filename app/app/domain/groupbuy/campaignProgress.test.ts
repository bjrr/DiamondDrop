import { describe, expect, it } from "vitest";

import { CORE_MESSAGE, buildCampaignProgress, type DualPrice } from "./campaignProgress";
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

/**
 * Bank Payment Prices, and the Regular/Card Prices the current rule derives
 * from them. All four are under $500, so all four take the 5.0% tier and then
 * the $5 ceiling:
 *
 *   $400 -> x1.05 = $420.00, already a $5 multiple -> $420
 *   $360 -> x1.05 = $378.00                        -> $380
 *   $320 -> x1.05 = $336.00                        -> $340
 *   $420 Buy Now -> x1.05 = $441.00                -> $445
 *
 * Written out rather than computed, so the fixture states the pairing a shopper
 * actually sees and a change in the rule shows up here as a deliberate edit
 * rather than silently flowing through.
 */
const PRICES: Record<number, DualPrice> = {
  1: { bankPaymentMinorUnits: 40_000n, regularCardMinorUnits: 42_000n },
  2: { bankPaymentMinorUnits: 36_000n, regularCardMinorUnits: 38_000n },
  3: { bankPaymentMinorUnits: 32_000n, regularCardMinorUnits: 34_000n },
};
const BUY_NOW: DualPrice = { bankPaymentMinorUnits: 42_000n, regularCardMinorUnits: 44_500n };
const ASOF = new Date("2026-09-18T12:00:00Z");

function view(over: Partial<Parameters<typeof buildCampaignProgress>[0]> = {}) {
  return buildCampaignProgress({
    campaignCode: "spring-solitaire",
    currency: "USD",
    tiers: TIERS,
    qualifyingUnitsSold: 4,
    buyNowPrice: BUY_NOW,
    tierPrices: PRICES,
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
    expect(v.currentTierDiscountPercent).toBe("10");
  });

  it("shows the next threshold and how many units are needed", () => {
    const v = view({ qualifyingUnitsSold: 4 });
    expect(v.nextThresholdUnits).toBe(10);
    expect(v.unitsToNextTier).toBe(6);
  });

  it("shows the selected variant's Group Buy price and the Buy Now comparison", () => {
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.groupBuyBankPaymentPriceMinorUnits).toBe("36000");
    expect(v.buyNowBankPaymentPriceMinorUnits).toBe("42000");
  });

  it("shows savings in dollars and percent, against BUY NOW", () => {
    // Measured against Buy Now, not the campaign base — those differ once Buy
    // Now moves, and the shopper's real alternative is buying it now.
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.bankBasisSavingsMinorUnits).toBe("6000");
    expect(v.bankBasisSavingsPercent).toBe("14.29");
  });

  it("shows the next-tier price and the additional saving it would bring", () => {
    const v = view({ qualifyingUnitsSold: 12 });
    expect(v.nextTierBankPaymentPriceMinorUnits).toBe("32000");
    expect(v.additionalBankPaymentSavingsMinorUnits).toBe("4000");
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
    expect(markers[2]!.bankPaymentPriceMinorUnits).toBe("32000");
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
    expect(v.groupBuyBankPaymentPriceMinorUnits).toBe("40000");

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
    expect(v.nextTierBankPaymentPriceMinorUnits).toBeNull();
    expect(v.additionalBankPaymentSavingsMinorUnits).toBeNull();
  });
});

describe("edges that would otherwise mislead a shopper", () => {
  it("never shows a NEGATIVE saving when Buy Now has fallen below the tier price", () => {
    // Buy Now can drop after a campaign freezes. Showing "-$40 savings" is
    // worse than showing none; the honest display is zero.
    const v = view({
      qualifyingUnitsSold: 1,
      buyNowPrice: { bankPaymentMinorUnits: 30_000n, regularCardMinorUnits: 31_500n },
    });
    expect(v.bankBasisSavingsMinorUnits).toBe("0");
    // "0", not "0.00": these are exact decimal strings with trailing zeros
    // trimmed, and PRESENTATION formatting belongs to the storefront. Padding
    // here would mean the domain had an opinion about display.
    expect(v.bankBasisSavingsPercent).toBe("0");
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
    expect(() =>
      view({ tierPrices: { 1: { bankPaymentMinorUnits: 40_000n, regularCardMinorUnits: 42_000n } } })
    ).toThrow(/No price supplied for tier/);
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

describe("two prices, explicitly named", () => {
  it("carries both a Regular/Card and a Bank Payment price for every figure", () => {
    // The storefront presents the Regular/Card Price as the primary advertised
    // price and the Bank Payment Price alongside it, so both must reach it. A
    // single ambiguous `price` field is what let the internal figure be
    // displayed as the headline.
    const v = view({ qualifyingUnitsSold: 12 });

    expect(v.groupBuyRegularCardPriceMinorUnits).toBe("38000");
    expect(v.groupBuyBankPaymentPriceMinorUnits).toBe("36000");
    expect(v.buyNowRegularCardPriceMinorUnits).toBe("44500");
    expect(v.buyNowBankPaymentPriceMinorUnits).toBe("42000");
    expect(v.nextTierRegularCardPriceMinorUnits).toBe("34000");
    expect(v.nextTierBankPaymentPriceMinorUnits).toBe("32000");
  });

  it('carries the "Save $Y with Bank Payment" figure, from the rounded prices', () => {
    // Policy §9. At tier 2 the pair shown is $380 card / $360 bank, so the
    // saving is $20 — the exact difference a shopper gets by subtracting the
    // two figures in front of them.
    const v = view({ qualifyingUnitsSold: 12 });

    expect(v.groupBuyBankPaymentSavingsMinorUnits).toBe("2000");
    expect(v.groupBuyBankPaymentSavingsMinorUnits).toBe(
      String(
        BigInt(v.groupBuyRegularCardPriceMinorUnits) -
          BigInt(v.groupBuyBankPaymentPriceMinorUnits)
      )
    );
  });

  it("keeps the two savings separate", () => {
    // A $20 bank-payment saving and a $65 Group-Buy-vs-Buy-Now saving measure
    // different things. A template showing either as the other, or adding them,
    // would misstate the offer.
    const v = view({ qualifyingUnitsSold: 12 });

    expect(v.groupBuyBankPaymentSavingsMinorUnits).toBe("2000"); // 38000 − 36000
    expect(v.groupSavingsCardBasisMinorUnits).toBe("6500"); //     44500 − 38000
    expect(v.groupBuyBankPaymentSavingsMinorUnits).not.toBe(v.groupSavingsCardBasisMinorUnits);
  });

  it("has NO ambiguously-named money field at all", () => {
    // Structural, not stylistic. A key called `price` or `priceMinorUnits`
    // leaves the storefront to guess which of the two it holds, and the guess
    // stays invisible until someone is charged the wrong amount.
    //
    // Scoped to fields CARRYING AN AMOUNT — the `…MinorUnits` suffix — rather
    // than to every key containing "price". `bestPriceUnlocked` is a boolean
    // about which tier is in force and belongs to neither basis; demanding it
    // pick one would be the test failing to say what it means.
    // `…CardBasis…` / `…BankBasis…` count as saying which side they measure:
    // a SAVING is a difference between two prices on one basis, not a price, so
    // it names the basis rather than the price. Accepting both spellings is the
    // test describing the convention rather than insisting on one word.
    const keys = Object.keys(view()).concat(Object.keys(view().tierMarkers[0]!));
    const amountKeys = keys.filter((k) => k.endsWith("MinorUnits"));

    expect(amountKeys.length).toBeGreaterThan(5);
    for (const key of amountKeys) {
      expect(
        /bankpayment|regularcard|cardbasis|bankbasis/i.test(key),
        `"${key}" must say which price or basis it is`
      ).toBe(true);
    }
  });

  it("measures savings like against like, never across the two bases", () => {
    // Card against card, bank against bank. Crossing them would fold the
    // bank/card spread into the advertised Group Buy saving: a $445 card Buy
    // Now against a $360 bank group price reads as an $85 saving when the Group
    // Buy is worth $65 of it.
    const v = view({ qualifyingUnitsSold: 12 });

    expect(v.groupSavingsCardBasisMinorUnits).toBe("6500"); // 44500 − 38000
    expect(v.bankBasisSavingsMinorUnits).toBe("6000"); //      42000 − 36000
    expect(v.groupSavingsCardBasisMinorUnits).not.toBe("8500"); // the crossed figure
  });

  it("states no bank/card percentage anywhere", () => {
    // Policy §6 keeps the tier rate internal, and the $5 ceiling makes any
    // fixed percentage wrong per item in any case. The percentages present are
    // the GROUP BUY savings and the Group Buy tier discount — different,
    // legitimate figures the README asks for.
    const v = view({ qualifyingUnitsSold: 12 });
    const percentKeys = Object.keys(v).filter((k) => /percent/i.test(k));

    expect(percentKeys.sort()).toEqual([
      "bankBasisSavingsPercent",
      "currentTierDiscountPercent",
      "groupSavingsCardBasisPercent",
    ]);
  });

  it("gives tier markers both prices", () => {
    const markers = view({ qualifyingUnitsSold: 12 }).tierMarkers;
    expect(markers[1]!.regularCardPriceMinorUnits).toBe("38000");
    expect(markers[1]!.bankPaymentPriceMinorUnits).toBe("36000");
  });

  it("does not expose the tier rate or the rule that produced the pair", () => {
    // The two prices cross the boundary; the tier and the rule that derived one
    // from the other are internal (policy §6) and stay on the server.
    const serialised = JSON.stringify(view()).toLowerCase();
    for (const leak of ["uplift", "rule", "tierlabel", "0.05", "0.045", "0.04"]) {
      expect(serialised).not.toContain(leak);
    }
  });
});
