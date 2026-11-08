/**
 * The PUBLIC Group Buy hub card — what a customer sees while scanning
 * several campaigns, and nothing else.
 *
 * PURE. No database, no I/O, no clock beyond the `asOf` the caller passes.
 * Same discipline as `campaignProgress.ts`, which this module deliberately
 * mirrors rather than competes with: that one answers "what is happening on
 * the campaign I am looking at", this one answers "which campaigns exist and
 * roughly what do they cost".
 *
 * ===========================================================================
 * WHY `From $X` IS THE HARD PART
 * ===========================================================================
 * A campaign sells many configurations at many prices. A 1ct round in 14k
 * costs a different amount from a 3ct oval in platinum. So there is no single
 * "campaign price", and picking one variant's price to display would be
 * arbitrary — and specifically, picking the FIRST variant would quote
 * whichever row happened to be inserted first, which is not a number anyone
 * decided.
 *
 * `From` therefore means exactly one thing: THE LOWEST CURRENT-TIER
 * REGULAR/CARD PRICE AMONG THE CAMPAIGN'S ELIGIBLE PRICED VARIANTS. Lowest,
 * so it is never an overstatement a shopper can be disappointed by.
 * Current-tier, because that is the price available right now. Card, because
 * CLAUDE.md rule 13 makes Regular/Card the advertised figure on a Group Buy
 * surface, with Bank Payment mentioned alongside rather than led with.
 *
 * COMPUTED FROM PRICES THE CALLER ALREADY HAD COMPUTED. This module performs
 * no pricing arithmetic: it selects a minimum from a list of
 * already-derived `DualPrice` values produced by `campaignTierDualPrices`,
 * the same one definition every other Group Buy surface quotes from. There is
 * no multiplication, no rounding and no card derivation in this file.
 *
 * OMITTED RATHER THAN GUESSED. A campaign with no eligible priced variant
 * yields `fromPrice: null`, and the card renders without a price. A made-up
 * "From $0" or a silently-dropped campaign would both be worse: the first
 * lies, the second hides a live campaign from the only page that lists it.
 */

import type { DualPrice } from "./campaignProgress";

/** One campaign's eligible priced variant, already priced at the current tier. */
export interface SummaryVariantPrice {
  /** The current tier's price for this variant, both forms. */
  readonly currentTier: DualPrice;
}

/** Customer-safe imagery, as chosen in the Admin Builder. */
export interface PublicCampaignImage {
  readonly url: string;
  readonly altText: string;
}

export interface PublicCampaignSummaryInput {
  /** The campaign's public code; also its deep-link identifier. */
  readonly code: string;
  readonly currency: string;
  /** From the latest presentation version, falling back to the frozen builder content. */
  readonly headline: string;
  readonly shortDescription: string;
  readonly cardImage: PublicCampaignImage | null;
  /** Free text from the campaign's own metadata, e.g. "Engagement ring". */
  readonly productType: string | null;
  readonly qualifyingUnitsSold: number;
  readonly unitsToNextTier: number | null;
  /** The next tier's price for the SAME variant the `From` price came from, or null at the final tier. */
  readonly nextTierFrom: DualPrice | null;
  readonly bestPriceUnlocked: boolean;
  readonly scheduledCloseAt: Date | null;
  /** Every eligible priced variant. Empty is legitimate and yields no price. */
  readonly variantPrices: readonly SummaryVariantPrice[];
  readonly asOf: Date;
}

export interface PublicCampaignSummary {
  readonly code: string;
  readonly currency: string;
  readonly headline: string;
  readonly shortDescription: string;
  readonly cardImage: PublicCampaignImage | null;
  readonly productType: string | null;

  /** Lowest current-tier price across eligible variants. Null when undeterminable. */
  readonly fromRegularCardPriceMinorUnits: string | null;
  readonly fromBankPaymentPriceMinorUnits: string | null;

  readonly qualifyingUnitsSold: number;
  readonly unitsToNextTier: number | null;
  readonly nextTierFromRegularCardPriceMinorUnits: string | null;
  readonly bestPriceUnlocked: boolean;

  readonly closesAt: string | null;
  readonly secondsRemaining: number | null;

  /** Where the campaign detail lives. Built here so one definition exists. */
  readonly detailUrl: string;
}

/**
 * The customer-shareable deep link for a campaign.
 *
 * ONE SHOPIFY PAGE, not one per campaign. A merchant configures a campaign in
 * the Admin Builder and it becomes linkable immediately; nobody has to create
 * a Page to mint a URL, which was the explicit requirement. The code travels
 * as a query parameter because a Shopify Page has no sub-paths, and a query
 * parameter is a real, bookmarkable, shareable URL that Back works with.
 */
export const GROUP_BUY_HUB_PATH = "/pages/group-buys";

export function campaignDetailUrl(code: string): string {
  return `${GROUP_BUY_HUB_PATH}?campaign=${encodeURIComponent(code)}`;
}

/** The lowest of a set of already-computed prices, compared on the card figure. */
function lowestByCardPrice(prices: readonly SummaryVariantPrice[]): DualPrice | null {
  let lowest: DualPrice | null = null;
  for (const candidate of prices) {
    if (lowest === null || candidate.currentTier.regularCardMinorUnits < lowest.regularCardMinorUnits) {
      lowest = candidate.currentTier;
    }
  }
  return lowest;
}

export function buildPublicCampaignSummary(input: PublicCampaignSummaryInput): PublicCampaignSummary {
  const lowest = lowestByCardPrice(input.variantPrices);

  // Seconds remaining, floored at zero. A campaign whose scheduled close has
  // passed but which the close job has not yet processed must read as "0", not
  // as a negative number counting upwards — which is what a bare subtraction
  // renders as, and which looks like a bug to a shopper.
  const secondsRemaining =
    input.scheduledCloseAt === null
      ? null
      : (() => {
          const remaining = input.scheduledCloseAt.getTime() - input.asOf.getTime();
          return remaining <= 0 ? 0 : (remaining - (remaining % 1000)) / 1000;
        })();

  return {
    code: input.code,
    currency: input.currency,
    headline: input.headline,
    shortDescription: input.shortDescription,
    cardImage: input.cardImage,
    productType: input.productType,

    fromRegularCardPriceMinorUnits: lowest === null ? null : lowest.regularCardMinorUnits.toString(),
    fromBankPaymentPriceMinorUnits: lowest === null ? null : lowest.bankPaymentMinorUnits.toString(),

    qualifyingUnitsSold: input.qualifyingUnitsSold,
    unitsToNextTier: input.unitsToNextTier,
    // Only meaningful alongside a `From` price: "3 more unlock $1,195" has to
    // be the next price for the SAME configuration the $1,295 came from, or
    // the two figures describe different rings.
    nextTierFromRegularCardPriceMinorUnits:
      lowest === null || input.nextTierFrom === null
        ? null
        : input.nextTierFrom.regularCardMinorUnits.toString(),
    bestPriceUnlocked: input.bestPriceUnlocked,

    closesAt: input.scheduledCloseAt === null ? null : input.scheduledCloseAt.toISOString(),
    secondsRemaining,

    detailUrl: campaignDetailUrl(input.code),
  };
}

/**
 * Hub ordering: CLOSING SOONEST FIRST.
 *
 * The data model carries no merchandising/priority column — checked before
 * inventing one — so this uses the one field that is both present and
 * genuinely useful to a shopper: how long they have left to join. A campaign
 * closing in two days is more urgent to surface than one closing in three
 * weeks, and that ordering needs no merchant upkeep.
 *
 * OPEN-ENDED CAMPAIGNS SORT LAST, not first. A null close date is "no
 * deadline", which is the least urgent thing on the page; sorting null first
 * (the default when comparing against null in most naive comparators) would
 * put the least time-sensitive campaign at the top.
 *
 * DETERMINISTIC. Ties break on `code`, so two campaigns closing in the same
 * minute always render in the same order rather than in whatever order the
 * database returned them. A hub that reshuffles between loads looks broken.
 */
export function sortPublicCampaignSummaries(
  summaries: readonly PublicCampaignSummary[]
): readonly PublicCampaignSummary[] {
  return [...summaries].sort((a, b) => {
    if (a.closesAt !== b.closesAt) {
      if (a.closesAt === null) return 1;
      if (b.closesAt === null) return -1;
      return a.closesAt < b.closesAt ? -1 : 1;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}
