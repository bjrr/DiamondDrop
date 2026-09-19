import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { buildCampaignProgress, type DualPrice } from "~/domain/groupbuy/campaignProgress";
import type { TierDefinition } from "~/domain/groupbuy/tiers";
import { tierCashPriceExact } from "~/domain/groupbuy/tiers";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { deriveCreditCardPrice } from "~/domain/pricing/creditCardPrice";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import type { CreditCardPriceRuleId } from "~/domain/pricing/types";
import { getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/group-buy/:code?variant=<id>
 *
 * Live Group Buy progress for the storefront, served through Shopify's App
 * Proxy so it appears on the shop's own domain (README "Live Savings /
 * Progress").
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as the webhook and cron
 * routes (architecture §2.1, finding F-23).
 *
 * SIGNATURE VERIFIED BEFORE ANYTHING ELSE. An unsigned request is a direct hit
 * on our origin pretending to be a storefront, and this endpoint reveals live
 * campaign state. Verification happens before the database is touched, so an
 * unauthenticated caller cannot use response timing to learn whether a campaign
 * code exists.
 *
 * TWO PRICES ON EVERY FIGURE. The response carries a credit-card price and a
 * cash-equivalent price for the group price, the Buy Now comparison and every
 * tier marker. Card is the primary displayed price; cash is the discounted
 * payment option. There is no bare `price` field — an ambiguous name here is
 * how a storefront ends up showing the internal cash figure as the headline.
 *
 * The response states NO cash-discount percentage, deliberately: the uplift and
 * the discount are reciprocals and whole-dollar rounding makes the realised
 * figure vary per item, so only the two absolute prices are always exact.
 *
 * WHAT THIS DELIBERATELY NEVER RETURNS. No landed cost, no margin, no floor, no
 * pricing-profile data, no customer identifiers. The uplift RATE is profile
 * data and stays on the server too — the storefront receives the two prices it
 * produced, never the rule that produced them. A shopper is entitled to
 * prices and savings; everything that would reveal what a piece costs us stays
 * on the server (CLAUDE.md: never expose supplier-private cost data or
 * admin-only margins to storefront clients). The view model in
 * campaignProgress.ts has no field for any of it, which is what makes that a
 * structural guarantee rather than a habit.
 */

function notFound() {
  // Deliberately indistinguishable from "campaign exists but is not open". A
  // storefront has no business learning which draft campaigns are being planned.
  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const { verified } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("groupbuy.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const code = params.code;
  if (!code) return notFound();

  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { code },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  // Only an OPEN campaign has live progress. A draft has no frozen prices yet,
  // and a closed one has a settled final tier rather than a moving one.
  if (!campaign || campaign.status !== "open") return notFound();

  // The selected variant, per "selected variant's current Group Buy price".
  //
  // ACCEPTS EITHER IDENTIFIER, because the two callers have different ones. A
  // theme knows Shopify variant ids and nothing about our master variants; an
  // admin or a test has the master variant id directly. Requiring the internal
  // id would have made the storefront block unimplementable, which is the sort
  // of thing only discovered when someone tries to wire it up.
  //
  // Shopify ids arrive either bare ("4455") or as a gid; both are normalised.
  const requested = url.searchParams.get("variant");
  const shopifyVariant = url.searchParams.get("shopify_variant");

  let selected = requested
    ? campaign.variants.find((v) => v.masterVariantId === requested)
    : undefined;

  if (!selected && shopifyVariant) {
    const gid = shopifyVariant.startsWith("gid://")
      ? shopifyVariant
      : `gid://shopify/ProductVariant/${shopifyVariant}`;

    const mapped = await prisma.masterVariant.findFirst({
      where: { shopifyVariantGid: gid },
      select: { id: true },
    });
    if (mapped) {
      selected = campaign.variants.find((v) => v.masterVariantId === mapped.id);
    }
  }

  // Falls back to the first eligible variant so the block renders before a
  // shopper has chosen a size, and before Shopify ids have been synced at all.
  selected = selected ?? campaign.variants[0];
  if (!selected) return notFound();

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));

  // THE CAMPAIGN'S FROZEN UPLIFT, not today's. A campaign records the pricing
  // profile it froze at open; reading the current profile instead would let a
  // change to the uplift rate move the displayed price of a campaign customers
  // have already joined, which is precisely what freezing exists to prevent.
  //
  // Only the DISPLAY derivation is frozen this way. The cash prices were frozen
  // outright at open and are read straight from the row.
  const frozenProfile = campaign.pricingProfileId
    ? await prisma.pricingProfile.findUnique({ where: { id: campaign.pricingProfileId } })
    : null;
  if (!frozenProfile) return notFound();

  const upliftRate = new MoneyDecimal(frozenProfile.creditCardUpliftRate.toString());
  const creditCardRuleId = frozenProfile.creditCardPriceRuleId as CreditCardPriceRuleId;

  /**
   * Cash first, card derived from it — the same order the Buy Now engine uses,
   * through the same versioned rule. Deriving the card price here from anything
   * other than the rounded cash price, or with a second rounding of its own,
   * would produce a storefront price that no calculation on the server agrees
   * with.
   */
  const dual = (cashMinorUnits: bigint): DualPrice => ({
    cashMinorUnits,
    creditCardMinorUnits: deriveCreditCardPrice(cashMinorUnits, upliftRate, creditCardRuleId),
  });

  // Every tier's price for THIS variant, rounded exactly as a customer would be
  // charged — through the same registries the engine uses, not a local rounding.
  const tierPrices: Record<number, DualPrice> = {};
  for (const tier of tiers) {
    const exactCash = tierCashPriceExact(
      new MoneyDecimal(selected.frozenBaseCashPriceMinorUnits.toString()),
      tier
    );
    const rounded = Money.fromDecimalMinorUnits(
      exactCash,
      campaign.currency,
      "HALF_UP_MINOR_UNIT_V1"
    );
    tierPrices[tier.tierNumber] = dual(
      applyPriceEnding(rounded.amountMinorUnits, "WHOLE_DOLLAR_UP_V1")
    );
  }

  // The Buy Now comparison price is the LATEST computed one for this variant,
  // not the campaign's frozen base. Those diverge as costs move, and the
  // shopper's real alternative is buying it now at today's price.
  const latestBuyNow = await prisma.priceCalculation.findFirst({
    where: { masterVariantId: selected.masterVariantId, status: "computed" },
    orderBy: { createdAt: "desc" },
  });

  const { total: qualifyingUnitsSold } = await getQualifyingUnits(campaign.id);

  const view = buildCampaignProgress({
    campaignCode: campaign.code,
    currency: campaign.currency,
    tiers,
    qualifyingUnitsSold,
    // Falls back to the frozen base when no Buy Now calculation exists yet.
    // Savings then read as zero rather than as a fabricated discount against a
    // comparison price we do not actually have.
    buyNowPrice: dual(
      latestBuyNow?.cashPriceMinorUnits ?? selected.frozenBaseCashPriceMinorUnits
    ),
    tierPrices,
    scheduledCloseAt: campaign.scheduledCloseAt,
    asOf: new Date(),
  });

  return Response.json(
    { variantId: selected.masterVariantId, ...view },
    {
      headers: {
        // Short and private. Unit counts move as people buy, and a shared cache
        // would show one shopper another's stale tier.
        "Cache-Control": "private, max-age=15",
      },
    }
  );
}
