import { campaignTierDualPrices, type FrozenCampaignPricingRules } from "./campaignTierPricing";
import type { TierDefinition } from "./tiers";

/**
 * THE PUBLIC PAST GROUP BUYS ARCHIVE — what a closed campaign actually
 * achieved, stated as history.
 *
 * README: "Maintain a public Past Group Buys archive preserving actual final
 * unit count and historical starting/final unlocked price."
 *
 * ============================================================================
 * HISTORY, NOT MERCHANDISING
 * ============================================================================
 * Every figure here is read or re-derived from what the campaign FROZE and
 * what it LOCKED at close. Nothing is recomputed from current costs, nothing
 * is rounded differently for presentation, and the final unit count is the
 * locked `finalQualifyingUnits` rather than a fresh fold over the ledger.
 *
 * That matters because the archive is a claim about the past. "47 people
 * joined and the price fell to $X" has to still be true next year, after
 * metal costs have moved and the card rule has changed twice.
 *
 * ============================================================================
 * REGULAR/CARD PRICES ONLY, WITH THE NOTE (CLAUDE.md rule 13)
 * ============================================================================
 * Group Buy surfaces lead with the Regular/Card Price and note that lower
 * pricing is available with Bank Payment, rather than showing both side by
 * side. Nothing here is purchasable, so there is no Payment Type to select —
 * which is exactly why the archive must not start quoting bank payment
 * figures it cannot let anyone act on. The bank payment prices are therefore
 * computed (they are the authoritative input the card price derives from) and
 * then deliberately NOT returned.
 *
 * NEVER IN THIS OUTPUT: landed cost, margin, supplier data, the internal card
 * percentage, pricing-profile ids, master variant ids, or anything about who
 * bought. A closed campaign is still somebody's order history.
 *
 * ============================================================================
 * A CAMPAIGN MISSING ITS LOCKED FIGURES IS OMITTED, NOT HALF-PRINTED
 * ============================================================================
 * `closeGroupBuyCampaign` always writes both `finalQualifyingUnits` and
 * `finalTierNumber`, so a closed campaign without them got there some other
 * way. Printing a row with a blank final price would be a public statement we
 * cannot stand behind; the caller logs the omission rather than dropping it
 * silently.
 */

/** One campaign's frozen inputs, as read from the database. */
export interface PastGroupBuyCampaignInput {
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly closedAt: Date | null;
  readonly finalQualifyingUnits: number | null;
  readonly finalTierNumber: number | null;
  readonly tiers: readonly TierDefinition[];
  /** Frozen base bank payment price per eligible variant, in minor units. */
  readonly frozenVariantBasesMinorUnits: readonly bigint[];
  readonly rules: FrozenCampaignPricingRules;
}

/** One row of the public archive. Card prices are decimal strings. */
export interface PastGroupBuyCampaignView {
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly closedAt: string;
  readonly finalQualifyingUnits: number;
  /** The first tier's Regular/Card Price — what the campaign opened at. */
  readonly startingRegularCardPrice: string;
  /** The Regular/Card Price at the tier the campaign actually finished on. */
  readonly finalRegularCardPrice: string;
  readonly finalTierNumber: number;
  /**
   * True when the campaign had more than one eligible variant, so the figures
   * above are the LOWEST-priced one and the theme must say "from". Without
   * this a customer reads one variant's price as the whole campaign's.
   */
  readonly priceIsFromLowestVariant: boolean;
  /** Set when the final tier beat the starting tier. Absent when it did not. */
  readonly priceFellBy: string | null;
}

export type PastGroupBuyOmissionReason =
  | "no_locked_final_figures"
  | "no_eligible_variants"
  | "final_tier_not_in_tier_set"
  | "no_closed_at";

export type PastGroupBuyCampaignResult =
  | { readonly ok: true; readonly view: PastGroupBuyCampaignView }
  | { readonly ok: false; readonly reason: PastGroupBuyOmissionReason };

/** Minor units to a decimal string by integer arithmetic. Never a float. */
function decimalString(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export function buildPastGroupBuyCampaignView(
  input: PastGroupBuyCampaignInput
): PastGroupBuyCampaignResult {
  if (input.finalQualifyingUnits === null || input.finalTierNumber === null) {
    return { ok: false, reason: "no_locked_final_figures" };
  }
  if (input.closedAt === null) return { ok: false, reason: "no_closed_at" };
  if (input.frozenVariantBasesMinorUnits.length === 0) {
    return { ok: false, reason: "no_eligible_variants" };
  }

  // THE LOWEST-PRICED VARIANT. The card price rises monotonically with the
  // bank payment price it derives from, so the cheapest base is also the
  // cheapest card price — no need to price every variant to find out.
  const lowestBase = input.frozenVariantBasesMinorUnits.reduce((a, b) => (b < a ? b : a));

  const tierPrices = campaignTierDualPrices(lowestBase, input.tiers, input.rules);

  // The campaign's own first tier, not tier number 1 by assumption — tier
  // numbering is campaign data and nothing guarantees it starts at 1.
  const firstTierNumber = input.tiers.reduce(
    (lowest, tier) => (tier.tierNumber < lowest ? tier.tierNumber : lowest),
    Number.POSITIVE_INFINITY
  );
  const starting = tierPrices[firstTierNumber];
  const final = tierPrices[input.finalTierNumber];
  if (!starting || !final) return { ok: false, reason: "final_tier_not_in_tier_set" };

  const fell = starting.regularCardMinorUnits - final.regularCardMinorUnits;

  return {
    ok: true,
    view: {
      code: input.code,
      name: input.name,
      currency: input.currency,
      closedAt: input.closedAt.toISOString(),
      finalQualifyingUnits: input.finalQualifyingUnits,
      startingRegularCardPrice: decimalString(starting.regularCardMinorUnits),
      finalRegularCardPrice: decimalString(final.regularCardMinorUnits),
      finalTierNumber: input.finalTierNumber,
      priceIsFromLowestVariant: input.frozenVariantBasesMinorUnits.length > 1,
      // NULL WHEN IT DID NOT FALL, rather than "0.00". A campaign that closed
      // on its opening tier unlocked nothing, and printing a zero saving
      // invites a theme to render "saved $0.00" as though something happened.
      priceFellBy: fell > 0n ? decimalString(fell) : null,
    },
  };
}
