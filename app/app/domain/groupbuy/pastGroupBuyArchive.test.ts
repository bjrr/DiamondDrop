import { describe, expect, it } from "vitest";

import { buildPastGroupBuyCampaignView, type PastGroupBuyCampaignInput } from "./pastGroupBuyArchive";
import type { FrozenCampaignPricingRules } from "./campaignTierPricing";
import { MoneyDecimal } from "../money/decimal";

/**
 * The public Past Group Buys archive view.
 *
 * ============================================================================
 * THE ARCHIVE IS A CLAIM ABOUT THE PAST
 * ============================================================================
 * "47 people joined and the price fell to $X" has to still be true next year,
 * after metal costs have moved and the card rule has changed. So the tests
 * that matter here are the ones about what the figures come FROM: the locked
 * final count rather than a fresh fold, the campaign's own frozen rules
 * rather than today's, and the campaign's own first tier rather than the
 * number 1.
 *
 * The other half is what the view must NOT say — a bank payment figure it
 * cannot let anyone act on, or a $0.00 saving dressed up as an achievement.
 */

/** The current tiered/$5 rules. */
const RULES: FrozenCampaignPricingRules = {
  currency: "USD",
  fixedCardUpliftRate: new MoneyDecimal("0.05"),
  regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
  roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
  priceEndingRuleId: "NONE_V1",
};

const TIERS = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
  { tierNumber: 3, minQualifyingUnits: 25, priceMultiplier: "0.800000" },
];

function input(overrides: Partial<PastGroupBuyCampaignInput> = {}): PastGroupBuyCampaignInput {
  return {
    code: "gb-summer-rings",
    name: "Summer Rings",
    currency: "USD",
    closedAt: new Date("2026-08-01T12:00:00.000Z"),
    finalQualifyingUnits: 31,
    finalTierNumber: 3,
    tiers: TIERS,
    frozenVariantBasesMinorUnits: [100_000n],
    rules: RULES,
    ...overrides,
  };
}

function viewOf(overrides: Partial<PastGroupBuyCampaignInput> = {}) {
  const result = buildPastGroupBuyCampaignView(input(overrides));
  if (!result.ok) throw new Error(`expected a view, got omission: ${result.reason}`);
  return result.view;
}

describe("what the archive reports", () => {
  it("reports the LOCKED final unit count, verbatim", () => {
    // Not a recount. The campaign's locked figure is the historical fact, and
    // monotonic public progress means a later cancellation must never lower it.
    expect(viewOf({ finalQualifyingUnits: 31 }).finalQualifyingUnits).toBe(31);
  });

  it("prices the starting tier and the tier the campaign actually finished on", () => {
    const view = viewOf();
    // $1,000.00 bank payment at tier 1 -> card price under the tiered rule.
    // $800.00 bank payment at tier 3 -> a lower card price.
    expect(view.startingRegularCardPrice).toBe("1040.00");
    expect(view.finalRegularCardPrice).toBe("840.00");
    expect(view.finalTierNumber).toBe(3);
  });

  it("states what the price fell by, computed from the two card prices", () => {
    expect(viewOf().priceFellBy).toBe("200.00");
  });

  it("reports NULL rather than 0.00 when the campaign closed on its opening tier", () => {
    // A campaign that unlocked nothing achieved nothing to advertise. "$0.00
    // saved" invites a theme to render it as though something happened.
    expect(viewOf({ finalTierNumber: 1 }).priceFellBy).toBeNull();
  });

  it("carries the campaign's own currency and close date", () => {
    const view = viewOf();
    expect(view.currency).toBe("USD");
    expect(view.closedAt).toBe("2026-08-01T12:00:00.000Z");
  });
});

describe("the campaign's own frozen rules decide the prices — not today's", () => {
  it("quotes a campaign frozen under the superseded fixed 5% / whole-dollar rule under THAT rule", () => {
    // THE REGRESSION THAT frozenRuleVersioning.test.ts EXISTS FOR, at the
    // archive. A campaign closed years ago must read the same forever.
    const superseded: FrozenCampaignPricingRules = {
      ...RULES,
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
    };
    const view = viewOf({ rules: superseded });
    // Fixed 5% on $1,000.00, not the tiered 4.0% the current rule would pick.
    expect(view.startingRegularCardPrice).toBe("1050.00");
    expect(view.finalRegularCardPrice).toBe("840.00");
  });

  it("two campaigns with identical tiers but different frozen rules report different prices", () => {
    const underTiered = viewOf().startingRegularCardPrice;
    const underFixed = viewOf({
      rules: { ...RULES, regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1", priceEndingRuleId: "WHOLE_DOLLAR_UP_V1" },
    }).startingRegularCardPrice;
    expect(underTiered).not.toBe(underFixed);
  });
});

describe("multiple eligible variants", () => {
  it("prices the LOWEST base, and says so", () => {
    const view = viewOf({ frozenVariantBasesMinorUnits: [250_000n, 100_000n, 180_000n] });
    expect(view.startingRegularCardPrice).toBe("1040.00");
    // Without this flag a customer reads one variant's price as the campaign's.
    expect(view.priceIsFromLowestVariant).toBe(true);
  });

  it("does NOT claim 'from' for a single-variant campaign", () => {
    expect(viewOf({ frozenVariantBasesMinorUnits: [100_000n] }).priceIsFromLowestVariant).toBe(false);
  });
});

describe("tier numbering is campaign data, not an assumption", () => {
  it("uses the campaign's own FIRST tier rather than tier number 1", () => {
    // Nothing guarantees a campaign's tiers start at 1. Assuming it would
    // either throw or silently price the wrong tier as "starting".
    const view = viewOf({
      tiers: [
        { tierNumber: 4, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 5, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
      ],
      finalTierNumber: 5,
    });
    expect(view.startingRegularCardPrice).toBe("1040.00");
    // AND THE CARD TIER IS CHOSEN PER PRICE. $1,000.00 takes 4.0%; the $900.00
    // tier-5 price falls in the $500-$999.99 band and takes 4.5%, giving
    // $940.50, which then rounds UP to the next $5. Deriving both from one
    // rate picked off the campaign base would have printed $936.00 here.
    expect(view.finalRegularCardPrice).toBe("945.00");
  });
});

describe("what it refuses to publish, rather than half-printing", () => {
  it("omits a campaign with no locked final figures", () => {
    for (const broken of [{ finalQualifyingUnits: null }, { finalTierNumber: null }]) {
      const result = buildPastGroupBuyCampaignView(input(broken));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("no_locked_final_figures");
    }
  });

  it("omits a campaign with no close date", () => {
    const result = buildPastGroupBuyCampaignView(input({ closedAt: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_closed_at");
  });

  it("omits a campaign with no eligible variants — there is no price to report", () => {
    const result = buildPastGroupBuyCampaignView(input({ frozenVariantBasesMinorUnits: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_eligible_variants");
  });

  it("omits a campaign whose locked final tier is not in its tier set", () => {
    const result = buildPastGroupBuyCampaignView(input({ finalTierNumber: 99 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("final_tier_not_in_tier_set");
  });
});

describe("what the view must never contain", () => {
  it("carries NO bank payment price — the archive quotes Regular/Card only", () => {
    // CLAUDE.md rule 13: Group Buy surfaces lead with Regular/Card and note
    // that Bank Payment was lower, rather than showing both. Nothing here is
    // purchasable, so there is no Payment Type to select — which is exactly
    // why quoting a bank figure here would be an offer nobody can accept.
    const keys = Object.keys(viewOf());
    expect(keys.join(",")).not.toMatch(/bank/i);
  });

  it("carries no cost, margin, multiplier, profile or variant identifier", () => {
    const serialized = JSON.stringify(viewOf()).toLowerCase();
    for (const forbidden of [
      "landedcost",
      "margin",
      "wholesale",
      "multiplier",
      "profile",
      "mastervariant",
      "snapshot",
      "supplier",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
