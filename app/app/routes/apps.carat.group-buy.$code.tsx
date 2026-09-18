import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { buildCampaignProgress } from "~/domain/groupbuy/campaignProgress";
import type { TierDefinition } from "~/domain/groupbuy/tiers";
import { tierPriceExact } from "~/domain/groupbuy/tiers";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
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
 * WHAT THIS DELIBERATELY NEVER RETURNS. No landed cost, no margin, no floor, no
 * pricing-profile data, no customer identifiers. A shopper is entitled to
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
  // Falls back to the first eligible one so the page renders before a shopper
  // has chosen a size.
  const requested = url.searchParams.get("variant");
  const selected =
    campaign.variants.find((v) => v.masterVariantId === requested) ?? campaign.variants[0];
  if (!selected) return notFound();

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));

  // Every tier's price for THIS variant, rounded exactly as a customer would be
  // charged — through the same registries the engine uses, not a local rounding.
  const tierPricesMinorUnits: Record<number, bigint> = {};
  for (const tier of tiers) {
    const exact = tierPriceExact(
      new MoneyDecimal(selected.frozenBasePriceMinorUnits.toString()),
      tier
    );
    const rounded = Money.fromDecimalMinorUnits(exact, campaign.currency, "HALF_UP_MINOR_UNIT_V1");
    tierPricesMinorUnits[tier.tierNumber] = applyPriceEnding(
      rounded.amountMinorUnits,
      "WHOLE_DOLLAR_UP_V1"
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
    frozenBaseMinorUnits: selected.frozenBasePriceMinorUnits,
    // Falls back to the frozen base when no Buy Now calculation exists yet.
    // Savings then read as zero rather than as a fabricated discount against a
    // comparison price we do not actually have.
    buyNowPriceMinorUnits:
      latestBuyNow?.computedPriceMinorUnits ?? selected.frozenBasePriceMinorUnits,
    tierPricesMinorUnits,
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
