import { describe, expect, it } from "vitest";

import {
  buildPublicCampaignSummary,
  campaignDetailUrl,
  sortPublicCampaignSummaries,
  GROUP_BUY_HUB_PATH,
  type PublicCampaignSummary,
  type PublicCampaignSummaryInput,
} from "./publicCampaignSummary";

/**
 * THE HUB CARD. What a shopper sees while scanning, and nothing more.
 *
 * The figure that needs the most protection is `From $X`. A campaign sells
 * many configurations at many prices, so there is no single campaign price —
 * and the tempting shortcut, "show the first variant's price", quotes
 * whichever row the database returned first. That is not a number anyone
 * decided, and it would be wrong in a way nobody notices until a shopper
 * taps through and finds a higher price than the card promised.
 */

const ASOF = new Date("2026-11-07T12:00:00.000Z");

function dual(card: bigint, bank: bigint) {
  return { regularCardMinorUnits: card, bankPaymentMinorUnits: bank };
}

function input(overrides: Partial<PublicCampaignSummaryInput> = {}): PublicCampaignSummaryInput {
  return {
    code: "signature-solitaire",
    currency: "USD",
    headline: "The Signature Solitaire",
    shortDescription: "A classic solitaire, grouped.",
    cardImage: { url: "https://cdn.shopify.com/s/files/1/card.jpg", altText: "A solitaire ring" },
    productType: "Engagement ring",
    qualifyingUnitsSold: 12,
    unitsToNextTier: 3,
    nextTierFrom: dual(119500n, 114000n),
    bestPriceUnlocked: false,
    scheduledCloseAt: new Date("2026-11-10T02:00:00.000Z"),
    variantPrices: [
      { currentTier: dual(219500n, 209000n) },
      { currentTier: dual(129500n, 123500n) }, // the lowest
      { currentTier: dual(189500n, 180500n) },
    ],
    asOf: ASOF,
    ...overrides,
  };
}

describe("the From price", () => {
  it("is the LOWEST current-tier card price, not the first variant's", () => {
    const summary = buildPublicCampaignSummary(input());
    expect(summary.fromRegularCardPriceMinorUnits).toBe("129500");
    // And its bank counterpart comes from the SAME variant, not from the
    // lowest bank price independently — otherwise the two figures would
    // describe different rings.
    expect(summary.fromBankPaymentPriceMinorUnits).toBe("123500");
  });

  it("is omitted rather than guessed when the campaign has no priced variant", () => {
    const summary = buildPublicCampaignSummary(input({ variantPrices: [] }));
    expect(summary.fromRegularCardPriceMinorUnits).toBeNull();
    expect(summary.fromBankPaymentPriceMinorUnits).toBeNull();
    // The campaign still appears — hiding a live campaign from the only page
    // that lists it would be worse than a card without a price.
    expect(summary.code).toBe("signature-solitaire");
    expect(summary.headline).toBe("The Signature Solitaire");
  });

  it("does not invent a next-tier figure when there is no From price to compare it to", () => {
    const summary = buildPublicCampaignSummary(input({ variantPrices: [] }));
    expect(summary.nextTierFromRegularCardPriceMinorUnits).toBeNull();
  });

  it("omits the next-tier figure at the final tier", () => {
    const summary = buildPublicCampaignSummary(
      input({ nextTierFrom: null, unitsToNextTier: null, bestPriceUnlocked: true })
    );
    expect(summary.nextTierFromRegularCardPriceMinorUnits).toBeNull();
    expect(summary.unitsToNextTier).toBeNull();
    expect(summary.bestPriceUnlocked).toBe(true);
  });

  it("handles a single-variant campaign", () => {
    const summary = buildPublicCampaignSummary(
      input({ variantPrices: [{ currentTier: dual(99900n, 95000n) }] })
    );
    expect(summary.fromRegularCardPriceMinorUnits).toBe("99900");
  });

  it("performs no arithmetic on the prices it is given", () => {
    // The figures must be the caller's, byte for byte — this module selects,
    // it does not compute. A multiplication or rounding here would be a
    // second definition of a Group Buy price.
    const summary = buildPublicCampaignSummary(
      input({ variantPrices: [{ currentTier: dual(123456789n, 123456780n) }] })
    );
    expect(summary.fromRegularCardPriceMinorUnits).toBe("123456789");
    expect(summary.fromBankPaymentPriceMinorUnits).toBe("123456780");
  });
});

describe("the countdown", () => {
  it("reports whole seconds remaining", () => {
    const summary = buildPublicCampaignSummary(input());
    // 2026-11-07T12:00 to 2026-11-10T02:00 is 2 days 14 hours.
    expect(summary.secondsRemaining).toBe(2 * 86400 + 14 * 3600);
    expect(summary.closesAt).toBe("2026-11-10T02:00:00.000Z");
  });

  it("floors at zero rather than counting upwards past the close", () => {
    // A campaign whose scheduled close has passed but which the close job has
    // not processed yet must read "0", not a negative number rendering as a
    // timer running backwards.
    const summary = buildPublicCampaignSummary(
      input({ scheduledCloseAt: new Date("2026-11-07T11:00:00.000Z") })
    );
    expect(summary.secondsRemaining).toBe(0);
  });

  it("has no countdown for an open-ended campaign", () => {
    const summary = buildPublicCampaignSummary(input({ scheduledCloseAt: null }));
    expect(summary.secondsRemaining).toBeNull();
    expect(summary.closesAt).toBeNull();
  });
});

describe("the deep link", () => {
  it("needs no Shopify Page per campaign", () => {
    // /pages/group-buy was NOT available: that handle belongs to the Group
    // Buy POLICY page on the live store, found during the draft-theme
    // preview. The hub lives at the plural handle instead.
    expect(GROUP_BUY_HUB_PATH).toBe("/pages/group-buys");
    expect(campaignDetailUrl("signature-solitaire")).toBe(
      `${GROUP_BUY_HUB_PATH}?campaign=signature-solitaire`
    );
  });

  it("escapes a code that would otherwise break the URL", () => {
    expect(campaignDetailUrl("spring/2027 rings")).toBe(
      `${GROUP_BUY_HUB_PATH}?campaign=spring%2F2027%20rings`
    );
  });

  it("is carried on the summary itself, so one definition exists", () => {
    expect(buildPublicCampaignSummary(input()).detailUrl).toBe(
      `${GROUP_BUY_HUB_PATH}?campaign=signature-solitaire`
    );
  });
});

describe("ordering", () => {
  function summaryClosing(code: string, closesAt: string | null): PublicCampaignSummary {
    return buildPublicCampaignSummary(
      input({ code, scheduledCloseAt: closesAt === null ? null : new Date(closesAt) })
    );
  }

  it("puts the campaign closing soonest first", () => {
    const sorted = sortPublicCampaignSummaries([
      summaryClosing("later", "2026-12-01T00:00:00.000Z"),
      summaryClosing("sooner", "2026-11-08T00:00:00.000Z"),
      summaryClosing("middle", "2026-11-20T00:00:00.000Z"),
    ]);
    expect(sorted.map((s) => s.code)).toEqual(["sooner", "middle", "later"]);
  });

  it("puts open-ended campaigns LAST, not first", () => {
    // "No deadline" is the least urgent thing on the page. A naive comparator
    // sorts null to the front, which would top the hub with the campaign a
    // shopper has the least reason to hurry for.
    const sorted = sortPublicCampaignSummaries([
      summaryClosing("open-ended", null),
      summaryClosing("closing", "2026-12-01T00:00:00.000Z"),
    ]);
    expect(sorted.map((s) => s.code)).toEqual(["closing", "open-ended"]);
  });

  it("is deterministic when two campaigns close at the same moment", () => {
    // A hub that reshuffles between loads looks broken.
    const same = "2026-11-09T00:00:00.000Z";
    const first = sortPublicCampaignSummaries([
      summaryClosing("bravo", same),
      summaryClosing("alpha", same),
    ]);
    const second = sortPublicCampaignSummaries([
      summaryClosing("alpha", same),
      summaryClosing("bravo", same),
    ]);
    expect(first.map((s) => s.code)).toEqual(["alpha", "bravo"]);
    expect(second.map((s) => s.code)).toEqual(first.map((s) => s.code));
  });

  it("does not mutate the array it was given", () => {
    const original = [summaryClosing("b", "2026-12-01T00:00:00.000Z"), summaryClosing("a", "2026-11-08T00:00:00.000Z")];
    const before = original.map((s) => s.code);
    sortPublicCampaignSummaries(original);
    expect(original.map((s) => s.code)).toEqual(before);
  });
});

describe("what a card may never carry", () => {
  it("declares only customer-safe fields", () => {
    const summary = buildPublicCampaignSummary(input());
    expect(Object.keys(summary).sort()).toEqual(
      [
        "bestPriceUnlocked",
        "cardImage",
        "closesAt",
        "code",
        "currency",
        "detailUrl",
        "fromBankPaymentPriceMinorUnits",
        "fromRegularCardPriceMinorUnits",
        "headline",
        "nextTierFromRegularCardPriceMinorUnits",
        "productType",
        "qualifyingUnitsSold",
        "secondsRemaining",
        "shortDescription",
        "unitsToNextTier",
      ].sort()
    );
  });

  it("leaks no cost, margin, floor, profile or variant identifier", () => {
    const serialised = JSON.stringify(buildPublicCampaignSummary(input())).toLowerCase();
    for (const forbidden of [
      "landedcost",
      "supplier",
      "margin",
      "floor",
      "pricingprofile",
      "mastervariant",
      "variantid",
      "snapshot",
      "actor",
      "staff",
      "uplift",
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it("carries no tier table — that belongs on the detail page", () => {
    const summary = buildPublicCampaignSummary(input());
    expect(summary).not.toHaveProperty("tierMarkers");
    expect(summary).not.toHaveProperty("tiers");
  });
});
