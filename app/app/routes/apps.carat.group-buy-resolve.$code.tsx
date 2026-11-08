import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { getFrozenGroupBuyCampaignOptions } from "~/db/repositories/groupBuyRepository.server";
import { buildCampaignProgress, type DualPrice } from "~/domain/groupbuy/campaignProgress";
import {
  campaignTierDualPrices,
  dualPriceFrom,
  type FrozenCampaignPricingRules,
} from "~/domain/groupbuy/campaignTierPricing";
import { resolveSelection } from "~/domain/groupbuy/storefrontSelection";
import { isTestFixtureCampaignCode } from "~/domain/groupbuy/testFixtureCampaign";
import type { TierDefinition } from "~/domain/groupbuy/tiers";
import { MoneyDecimal } from "~/domain/money/decimal";
import type { RoundingRuleId } from "~/domain/money/rounding";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import { getCampaignBuilderStateForResolution } from "~/jobs/groupbuy/publicCampaignFeed.server";
import { getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/group-buy-resolve/:code?selection=<json>
 *
 * THE ONE PLACE A CUSTOMER'S SELECTION BECOMES A PURCHASABLE THING.
 *
 * ===========================================================================
 * THE DIRECTION OF TRUST
 * ===========================================================================
 * The authority runs one way only:
 *
 *     customer selection -> SERVER resolution -> Shopify variant id
 *
 * and never the other way. The browser does not pick a variant and ask the
 * server to price it; it says what the shopper chose ("oval, 2.00ct,
 * platinum, size 7.5") and this route decides, in order, whether that is a
 * declared combination, which size band it prices from, which MasterVariant
 * the merchant mapped it to, whether that variant is actually eligible for
 * THIS campaign, and only then what it costs.
 *
 * A browser that invents a variant id gains nothing, because no parameter
 * here accepts one.
 *
 * ===========================================================================
 * WHAT CROSSES THE WIRE, AND WHAT CANNOT
 * ===========================================================================
 * Out: `available`, a `shopifyVariantId`, and the existing customer-safe
 * progress view. The Shopify variant id is public storefront data — it is on
 * every product page — and Shopify's native cart needs it. It is released
 * ONLY for a selection that has already passed every gate above, and only
 * one at a time: there is no endpoint here that hands over the whole mapping.
 *
 * Never out: the MasterVariant id, the size band, the configuration
 * signature, the mapping, the pricing profile, any cost, margin or floor.
 * The response is assembled field by field below rather than spread from a
 * record, so a leak takes a deliberate edit.
 *
 * ===========================================================================
 * NO FALLBACK. EVER.
 * ===========================================================================
 * An unresolvable selection returns `available: false`. It does not fall
 * back to the first eligible variant, which is what the page this replaces
 * did — and which quotes one ring's price while the shopper looks at another.
 *
 * A RESOURCE ROUTE — no default export; see `csrfResourceRouteFence.test.ts`.
 */

function notFound() {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** A refusal the page can render without losing the shopper's selections. */
function unavailable(reason: string) {
  return Response.json(
    { available: false, reason },
    { headers: { "Cache-Control": "private, max-age=0, no-store" } }
  );
}

/**
 * `gid://shopify/ProductVariant/1234` -> `1234`.
 *
 * The numeric form is what `/cart/add` takes. Returns null for anything that
 * is not a product-variant gid rather than passing a malformed id to the
 * cart, where it would fail with a less useful message.
 */
export function shopifyVariantIdFromGid(gid: string | null): string | null {
  if (!gid) return null;
  const match = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(gid);
  return match ? match[1]! : null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const { verified, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    logger.warn("groupbuy.resolve_proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const code = params.code;
  if (!code) return notFound();

  // Fixture refusal before the lookup, same as every other public surface.
  if (isTestFixtureCampaignCode(code)) {
    logger.warn("groupbuy.resolve_test_fixture_refused", { campaignCode: code });
    return notFound();
  }

  const raw = url.searchParams.get("selection");
  if (!raw) return notFound();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return notFound();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return notFound();

  const selection: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") return notFound();
    selection[key] = value;
  }

  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { code },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });
  // Only an open campaign sells anything. A closed one's detail page renders
  // history and has no purchase controls to resolve for.
  if (!campaign || campaign.status !== "open") return notFound();

  const [optionsUpload, builderState, frozenProfile] = await Promise.all([
    getFrozenGroupBuyCampaignOptions(campaign.snapshotId),
    getCampaignBuilderStateForResolution(campaign.id),
    campaign.pricingProfileId
      ? prisma.pricingProfile.findUnique({ where: { id: campaign.pricingProfileId } })
      : Promise.resolve(null),
  ]);
  if (!optionsUpload || !builderState || !frozenProfile) return notFound();

  // (1) and (2): declared combination, then the private band projection.
  const resolution = resolveSelection(optionsUpload.options, builderState, selection);
  if (!resolution.ok) {
    logger.info("groupbuy.selection_unresolved", { campaignCode: campaign.code, reason: resolution.reason });
    return unavailable(resolution.reason);
  }

  // (3) and (4): the mapped MasterVariant, confirmed to belong to THIS
  // campaign. A mapping left behind from an earlier configuration must not
  // sell a variant the campaign never froze a price for.
  const eligible = campaign.variants.find((v) => v.masterVariantId === resolution.masterVariantId);
  if (!eligible) return unavailable("not_eligible_for_campaign");

  // (5): its Shopify variant, which is the only identifier that leaves here.
  const masterVariant = await prisma.masterVariant.findUnique({
    where: { id: resolution.masterVariantId },
    select: { shopifyVariantGid: true },
  });
  const shopifyVariantId = shopifyVariantIdFromGid(masterVariant?.shopifyVariantGid ?? null);
  if (!shopifyVariantId) {
    // Mapped and eligible, but never synced to Shopify. Honest refusal: the
    // native cart cannot accept it, so offering a Join button would fail at
    // the last step.
    logger.warn("groupbuy.resolved_variant_not_synced", { campaignCode: campaign.code });
    return unavailable("not_purchasable_yet");
  }

  // (6): the price, from the campaign's FROZEN rules and this variant's
  // frozen base — the same two calls every other Group Buy surface makes.
  const tiers: TierDefinition[] = campaign.tiers.map((tier) => ({
    tierNumber: tier.tierNumber,
    minQualifyingUnits: tier.minQualifyingUnits,
    priceMultiplier: tier.priceMultiplier.toString(),
  }));

  const frozenRules: FrozenCampaignPricingRules = {
    currency: campaign.currency,
    fixedCardUpliftRate: new MoneyDecimal(frozenProfile.fixedCardUpliftRate.toString()),
    regularCardPriceRuleId: frozenProfile.regularCardPriceRuleId as RegularCardPriceRuleId,
    roundingRuleId: frozenProfile.roundingRuleId as RoundingRuleId,
    priceEndingRuleId: frozenProfile.priceEndingRuleId as PriceEndingRuleId,
  };

  const tierPrices = campaignTierDualPrices(
    eligible.frozenBaseBankPaymentPriceMinorUnits,
    tiers,
    frozenRules
  );

  // The Buy Now comparison, under ITS OWN profile rather than the campaign's
  // frozen one — the same reasoning as the progress endpoint: the frozen rule
  // governs what the campaign quotes and has no claim over a price computed
  // outside it.
  const latestBuyNow = await prisma.priceCalculation.findFirst({
    where: { masterVariantId: resolution.masterVariantId, status: "computed" },
    orderBy: { createdAt: "desc" },
    include: { pricingProfile: true },
  });

  const buyNowPrice: DualPrice = latestBuyNow
    ? dualPriceFrom(
        latestBuyNow.bankPaymentPriceMinorUnits,
        new MoneyDecimal(latestBuyNow.pricingProfile.fixedCardUpliftRate.toString()),
        latestBuyNow.pricingProfile.regularCardPriceRuleId as RegularCardPriceRuleId
      )
    : dualPriceFrom(
        eligible.frozenBaseBankPaymentPriceMinorUnits,
        frozenRules.fixedCardUpliftRate,
        frozenRules.regularCardPriceRuleId
      );

  const { total: qualifyingUnitsSold } = await getQualifyingUnits(campaign.id);

  const price = buildCampaignProgress({
    campaignCode: campaign.code,
    currency: campaign.currency,
    tiers,
    qualifyingUnitsSold,
    buyNowPrice,
    tierPrices,
    scheduledCloseAt: campaign.scheduledCloseAt,
    asOf: new Date(),
  });

  return Response.json(
    { available: true, shopifyVariantId, price },
    {
      headers: {
        // Private and brief: unit counts move as people buy, and a shared
        // cache would show one shopper another's tier.
        "Cache-Control": "private, max-age=10",
      },
    }
  );
}
