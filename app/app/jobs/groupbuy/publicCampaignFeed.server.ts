/**
 * The storefront's view of Group Buy: which campaigns a customer may discover,
 * and what one campaign looks like when they open it.
 *
 * ===========================================================================
 * THE BRIDGE THE ADMIN BUILDER NEEDED AND DID NOT HAVE
 * ===========================================================================
 * Campaign presentation (headline, short description, imagery) now lives in
 * `groupbuy.campaign_presentation.v1` and `groupbuy.campaign_builder.v1`, and
 * the saleable configuration lives in the frozen
 * `groupbuy.campaign_options.v1` pinned at open. None of those were readable
 * from the storefront, which is why the theme still carried a campaign code,
 * a headline and a blob of options JSON in Theme Editor settings.
 *
 * This module is that bridge, and it is deliberately a NARROW one. It reads
 * those internal records and emits only what a customer may see. The internal
 * shapes do not pass through: every field is copied onto a public type by
 * hand, so adding a leak takes a deliberate edit rather than an accidental
 * spread.
 *
 * ===========================================================================
 * NO PRICING ARITHMETIC HAPPENS HERE
 * ===========================================================================
 * Prices come from `campaignTierDualPrices` — the one definition every Group
 * Buy surface quotes from — fed with each variant's price as FROZEN AT OPEN
 * and the campaign's FROZEN profile rules. This file multiplies nothing,
 * rounds nothing, and derives no card price. It selects and it copies.
 *
 * ===========================================================================
 * COST OF A HUB LOAD
 * ===========================================================================
 * One query for the campaign rows (with tiers and variants), then a small
 * fixed set of reads per campaign: its frozen profile, its presentation, its
 * unit ledger. That is a handful of queries for a handful of open campaigns,
 * served behind a short cache — not one request per variant, which is what
 * the requirement warned against. The browser makes ONE call for the whole
 * hub.
 */

import { prisma } from "~/db/client.server";
import {
  getLatestGroupBuyCampaignBuilderState,
  getLatestGroupBuyCampaignPresentation,
  getFrozenGroupBuyCampaignOptions,
} from "~/db/repositories/groupBuyRepository.server";
import { PUBLIC_ACTIVE_GROUP_BUY_CAMPAIGNS } from "~/domain/groupbuy/campaignVisibility";
import { buildCampaignProgress, type CampaignProgressView, type DualPrice } from "~/domain/groupbuy/campaignProgress";
import {
  campaignTierDualPrices,
  dualPriceFrom,
  type FrozenCampaignPricingRules,
} from "~/domain/groupbuy/campaignTierPricing";
import {
  buildPublicCampaignSummary,
  sortPublicCampaignSummaries,
  type PublicCampaignImage,
  type PublicCampaignSummary,
} from "~/domain/groupbuy/publicCampaignSummary";
import { selectTier, type TierDefinition } from "~/domain/groupbuy/tiers";
import {
  toPublicCampaignOptions,
  type PublicCampaignOptions,
} from "~/domain/groupbuy/storefrontSelection";
import type { CampaignBuilderState, BuilderImageRef } from "~/domain/groupbuy/campaignBuilder";
import { MoneyDecimal } from "~/domain/money/decimal";
import type { RoundingRuleId } from "~/domain/money/rounding";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import { getQualifyingUnits } from "./unitLedger.server";

/** Internal image reference -> the two fields a customer needs. */
function publicImage(ref: BuilderImageRef | null | undefined): PublicCampaignImage | null {
  if (!ref || ref.url.trim() === "") return null;
  // The Shopify file id is DELIBERATELY dropped. The storefront renders a URL
  // and an alt text; a `gid://shopify/MediaImage/...` on a public page is an
  // internal identifier serving no customer purpose.
  return { url: ref.url, altText: ref.altText };
}

/**
 * The content a campaign presents with: latest presentation version laid over
 * the frozen builder content.
 *
 * Same reading rule the admin page uses — frozen commerce configuration plus
 * latest presentation — so a correction made after a campaign opened appears
 * to customers without the frozen record being touched.
 */
async function resolveContent(campaignId: string): Promise<{
  readonly headline: string;
  readonly shortDescription: string;
  readonly heroImage: PublicCampaignImage | null;
  readonly mobileHeroImage: PublicCampaignImage | null;
  readonly cardImage: PublicCampaignImage | null;
  readonly galleryImages: readonly PublicCampaignImage[];
  readonly highlights: readonly string[];
  readonly displayDetails: readonly { readonly label: string; readonly value: string }[];
  readonly productType: string | null;
  readonly builderState: CampaignBuilderState | null;
}> {
  const [presentation, builder] = await Promise.all([
    getLatestGroupBuyCampaignPresentation(campaignId),
    getLatestGroupBuyCampaignBuilderState(campaignId),
  ]);

  const frozen = builder?.state.content ?? null;
  const latest = presentation?.presentation ?? null;

  return {
    headline: latest?.headline ?? frozen?.headline ?? "",
    shortDescription: latest?.shortDescription ?? frozen?.shortDescription ?? "",
    heroImage: publicImage(latest?.heroImage ?? frozen?.heroImage),
    mobileHeroImage: publicImage(latest?.mobileHeroImage ?? frozen?.mobileHeroImage),
    cardImage: publicImage(latest?.cardImage ?? frozen?.cardImage),
    galleryImages: (latest?.galleryImages ?? frozen?.galleryImages ?? [])
      .map(publicImage)
      .filter((image): image is PublicCampaignImage => image !== null),
    // HIGHLIGHTS AND DISPLAY DETAILS COME FROM THE FROZEN RECORD ONLY, never
    // from a presentation version. They are claims about the goods — material,
    // certification, quality — and they freeze at open precisely so a
    // historical campaign still describes what was actually sold. A
    // presentation version cannot carry them (its type has no such field);
    // reading them from `frozen` here is what makes that visible at the
    // boundary rather than implied.
    highlights: frozen?.highlights ?? [],
    displayDetails: frozen?.displayDetails ?? [],
    productType: builder?.state.productType?.trim() ? builder.state.productType : null,
    builderState: builder?.state ?? null,
  };
}

interface FrozenPricing {
  readonly rules: FrozenCampaignPricingRules;
  readonly tiers: readonly TierDefinition[];
}

async function frozenPricingFor(campaign: {
  id: string;
  currency: string;
  pricingProfileId: string | null;
  tiers: readonly { tierNumber: number; minQualifyingUnits: number; priceMultiplier: { toString(): string } }[];
}): Promise<FrozenPricing | null> {
  if (!campaign.pricingProfileId) return null;
  const profile = await prisma.pricingProfile.findUnique({ where: { id: campaign.pricingProfileId } });
  if (!profile) return null;

  return {
    // THE CAMPAIGN'S FROZEN RULES, not today's. Reading the current profile
    // would let a later change of card or rounding rule move the advertised
    // price of a campaign customers have already joined.
    rules: {
      currency: campaign.currency,
      fixedCardUpliftRate: new MoneyDecimal(profile.fixedCardUpliftRate.toString()),
      regularCardPriceRuleId: profile.regularCardPriceRuleId as RegularCardPriceRuleId,
      roundingRuleId: profile.roundingRuleId as RoundingRuleId,
      priceEndingRuleId: profile.priceEndingRuleId as PriceEndingRuleId,
    },
    tiers: campaign.tiers.map((tier) => ({
      tierNumber: tier.tierNumber,
      minQualifyingUnits: tier.minQualifyingUnits,
      priceMultiplier: tier.priceMultiplier.toString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

export async function listPublicGroupBuyCampaigns(
  asOf: Date = new Date()
): Promise<readonly PublicCampaignSummary[]> {
  // ONE shared visibility predicate, not an inline condition — the fixture
  // exclusion has exactly one definition and `campaignVisibilityFence.test.ts`
  // enforces that.
  const campaigns = await prisma.groupBuyCampaign.findMany({
    where: PUBLIC_ACTIVE_GROUP_BUY_CAMPAIGNS,
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  const summaries = await Promise.all(
    campaigns.map(async (campaign) => {
      const pricing = await frozenPricingFor(campaign);
      // A campaign whose frozen profile is missing cannot be priced, and a
      // card with no price is better than a card with a wrong one. It still
      // appears; `From` is simply absent.
      const [content, units] = await Promise.all([
        resolveContent(campaign.id),
        getQualifyingUnits(campaign.id),
      ]);

      const variantPrices: { currentTier: DualPrice }[] = [];
      let nextTierFrom: DualPrice | null = null;
      let unitsToNextTier: number | null = null;
      let bestPriceUnlocked = false;

      if (pricing && pricing.tiers.length > 0) {
        const current = selectTier(pricing.tiers, units.total);
        const next = pricing.tiers.find((tier) => tier.tierNumber === current.tierNumber + 1) ?? null;
        bestPriceUnlocked = next === null;
        unitsToNextTier = next === null ? null : Math.max(0, next.minQualifyingUnits - units.total);

        // The cheapest variant AT THE CURRENT TIER, and that same variant's
        // next-tier price — so "3 more unlock $1,195" describes the ring the
        // "$1,295" came from.
        let lowestBase: bigint | null = null;
        for (const variant of campaign.variants) {
          const prices = campaignTierDualPrices(
            variant.frozenBaseBankPaymentPriceMinorUnits,
            pricing.tiers,
            pricing.rules
          );
          const atCurrent = prices[current.tierNumber];
          if (!atCurrent) continue;
          variantPrices.push({ currentTier: atCurrent });

          if (lowestBase === null || atCurrent.regularCardMinorUnits < lowestBase) {
            lowestBase = atCurrent.regularCardMinorUnits;
            nextTierFrom = next === null ? null : (prices[next.tierNumber] ?? null);
          }
        }
      }

      return buildPublicCampaignSummary({
        code: campaign.code,
        currency: campaign.currency,
        headline: content.headline || campaign.name,
        shortDescription: content.shortDescription,
        cardImage: content.cardImage,
        productType: content.productType,
        qualifyingUnitsSold: units.total,
        unitsToNextTier,
        nextTierFrom,
        bestPriceUnlocked,
        scheduledCloseAt: campaign.scheduledCloseAt,
        variantPrices,
        asOf,
      });
    })
  );

  return sortPublicCampaignSummaries(summaries);
}

// ---------------------------------------------------------------------------
// One campaign
// ---------------------------------------------------------------------------

export interface PublicCampaignDetail {
  readonly code: string;
  readonly currency: string;
  /** `open` or `closed`. A draft is never reachable. */
  readonly status: "open" | "closed";
  readonly headline: string;
  readonly shortDescription: string;
  readonly productType: string | null;
  readonly heroImage: PublicCampaignImage | null;
  readonly mobileHeroImage: PublicCampaignImage | null;
  readonly galleryImages: readonly PublicCampaignImage[];
  readonly highlights: readonly string[];
  readonly displayDetails: readonly { readonly label: string; readonly value: string }[];
  /** Null when the campaign has no configurable options recorded. */
  readonly options: PublicCampaignOptions | null;
  /** Live progress for a representative variant. Null once closed. */
  readonly progress: CampaignProgressView | null;
  readonly closesAt: string | null;
}

export type PublicCampaignDetailResult =
  | { readonly ok: true; readonly detail: PublicCampaignDetail }
  | { readonly ok: false; readonly reason: "not_found" };

/**
 * One campaign, as a customer sees it.
 *
 * REACHABLE WHEN OPEN *OR* CLOSED. A shared link must keep working after a
 * campaign closes — the page then renders its historical state rather than a
 * dead end. A DRAFT is never reachable, and neither is a fixture; both return
 * the same `not_found` as an unknown code, so probing reveals nothing.
 *
 * The caller is responsible for the fixture refusal and the proxy signature;
 * this function is given a code that has already cleared both.
 */
export async function getPublicGroupBuyCampaign(
  code: string,
  asOf: Date = new Date()
): Promise<PublicCampaignDetailResult> {
  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { code },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  if (!campaign || (campaign.status !== "open" && campaign.status !== "closed")) {
    return { ok: false, reason: "not_found" };
  }

  const [content, optionsUpload, units, pricing] = await Promise.all([
    resolveContent(campaign.id),
    getFrozenGroupBuyCampaignOptions(campaign.snapshotId),
    getQualifyingUnits(campaign.id),
    frozenPricingFor(campaign),
  ]);

  let progress: CampaignProgressView | null = null;

  // Progress is a LIVE figure, so a closed campaign has none: its tier is
  // settled, not moving. The historical state the page renders instead comes
  // from the content and the archive, not from a moving counter.
  if (campaign.status === "open" && pricing && pricing.tiers.length > 0) {
    const representative = campaign.variants[0];
    if (representative) {
      const tierPrices = campaignTierDualPrices(
        representative.frozenBaseBankPaymentPriceMinorUnits,
        pricing.tiers,
        pricing.rules
      );
      progress = buildCampaignProgress({
        campaignCode: campaign.code,
        currency: campaign.currency,
        tiers: pricing.tiers,
        qualifyingUnitsSold: units.total,
        // No Buy Now comparison is fetched for the bootstrap: the detail page
        // quotes the Group Buy price, and the per-variant endpoint supplies
        // the comparison once a configuration is chosen. Passing the group
        // price itself yields a zero saving rather than a fabricated one.
        buyNowPrice: dualPriceFrom(
          representative.frozenBaseBankPaymentPriceMinorUnits,
          pricing.rules.fixedCardUpliftRate,
          pricing.rules.regularCardPriceRuleId
        ),
        tierPrices,
        scheduledCloseAt: campaign.scheduledCloseAt,
        asOf,
      });
    }
  }

  return {
    ok: true,
    detail: {
      code: campaign.code,
      currency: campaign.currency,
      status: campaign.status === "open" ? "open" : "closed",
      headline: content.headline || campaign.name,
      shortDescription: content.shortDescription,
      productType: content.productType,
      heroImage: content.heroImage,
      mobileHeroImage: content.mobileHeroImage,
      galleryImages: content.galleryImages,
      highlights: content.highlights,
      displayDetails: content.displayDetails,
      options: optionsUpload ? toPublicCampaignOptions(optionsUpload.options) : null,
      progress,
      closesAt: campaign.scheduledCloseAt ? campaign.scheduledCloseAt.toISOString() : null,
    },
  };
}

/**
 * The builder state for a campaign, for SERVER-SIDE resolution only.
 *
 * Returned to the price endpoint so it can turn a customer's selection into a
 * variant. Never serialised to a response: it carries band assignments and
 * variant mappings, which is exactly what `storefrontSelection.ts` exists to
 * keep on this side of the wire.
 */
export async function getCampaignBuilderStateForResolution(
  campaignId: string
): Promise<CampaignBuilderState | null> {
  const record = await getLatestGroupBuyCampaignBuilderState(campaignId);
  return record?.state ?? null;
}
