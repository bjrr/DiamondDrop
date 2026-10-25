import type { LoaderFunctionArgs } from "react-router";

import { prisma } from "~/db/client.server";
import { buildCampaignProgress, type DualPrice } from "~/domain/groupbuy/campaignProgress";
import {
  campaignTierDualPrices,
  dualPriceFrom,
  type FrozenCampaignPricingRules,
} from "~/domain/groupbuy/campaignTierPricing";
import { isTestFixtureCampaignCode } from "~/domain/groupbuy/testFixtureCampaign";
import type { TierDefinition } from "~/domain/groupbuy/tiers";
import { MoneyDecimal } from "~/domain/money/decimal";
import type {
  PriceEndingRuleId,
  RegularCardPriceRuleId,
} from "~/domain/pricing/types";
import type { RoundingRuleId } from "~/domain/money/rounding";
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
 * TWO PRICES ON EVERY FIGURE. The response carries a Regular/Card Price and a
 * Bank Payment Price for the group price, the Buy Now comparison and every tier
 * marker. Card is the primary advertised price; the Bank Payment Price is shown
 * alongside it. There is no bare `price` field — an ambiguous name here is how
 * a storefront ends up showing the internal figure as the headline and
 * undercharging every card customer.
 *
 * The response states NO bank/card percentage (policy §6) — only absolute
 * prices and the exact dollar saving between them, which is the one figure that
 * always matches what the shopper can check by subtracting.
 *
 * WHAT THIS DELIBERATELY NEVER RETURNS. No landed cost, no margin, no floor, no
 * pricing-profile data, no customer identifiers. The tier RATE and the rule id
 * stay on the server too — the storefront receives the prices they produced,
 * never the rule that produced them. A shopper is entitled to
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

  const { verified, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("groupbuy.proxy_rejected", { reason, signedShop: shop });
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

  // A LIVE-GATE FIXTURE CAMPAIGN IS NOT REACHABLE BY A CUSTOMER, EVER — even
  // by someone holding its code.
  //
  // These are real, open campaigns with real frozen prices, created so the
  // gates could prove enforcement against production. They are unlisted
  // rather than unreachable by nature: the code is the only thing standing
  // between a customer and a live Group Buy page offering a synthetic product
  // at a synthetic price. "Nobody knows the code" is an assumption, not a
  // control, and it is a poor one — codes end up in logs, screenshots and
  // handover notes.
  //
  // Returns the SAME `not_found` as a genuinely unknown code, so this does not
  // confirm the campaign exists to anyone probing.
  if (isTestFixtureCampaignCode(campaign.code)) {
    logger.warn("groupbuy.public_progress_test_fixture_refused", { campaignCode: campaign.code });
    return notFound();
  }

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

  // THE CAMPAIGN'S FROZEN CARD RULE, not today's. A campaign records the
  // pricing profile it froze at open; reading the current profile instead would
  // let a change of card rule move the advertised price of a campaign customers
  // have already joined, which is precisely what freezing exists to prevent.
  //
  // Only the DISPLAY derivation is frozen this way. The bank payment prices were
  // frozen outright at open and are read straight from the row.
  const frozenProfile = campaign.pricingProfileId
    ? await prisma.pricingProfile.findUnique({ where: { id: campaign.pricingProfileId } })
    : null;
  if (!frozenProfile) return notFound();

  // EVERY RULE COMES FROM THE FROZEN PROFILE, none is written in here. These
  // were hardcoded to today's ids, which is invisible while only one set is in
  // use and wrong the moment a profile changes a rounding or price-ending rule:
  // a campaign frozen under the old rules would be quoted under the new ones,
  // and the storefront would disagree with both the freeze and the refund.
  const frozenRules: FrozenCampaignPricingRules = {
    currency: campaign.currency,
    fixedCardUpliftRate: new MoneyDecimal(frozenProfile.fixedCardUpliftRate.toString()),
    regularCardPriceRuleId: frozenProfile.regularCardPriceRuleId as RegularCardPriceRuleId,
    roundingRuleId: frozenProfile.roundingRuleId as RoundingRuleId,
    priceEndingRuleId: frozenProfile.priceEndingRuleId as PriceEndingRuleId,
  };

  /** Under the campaign's frozen card rule. See campaignTierPricing.ts. */
  const dual = (bankPaymentMinorUnits: bigint): DualPrice =>
    dualPriceFrom(bankPaymentMinorUnits, frozenRules.fixedCardUpliftRate, frozenRules.regularCardPriceRuleId);

  // Every tier's price for THIS variant. Shared with the public Past Group
  // Buys archive, which must quote a closed campaign exactly as this quoted it
  // while open — a second copy of the derivation is how those two drift apart.
  const tierPrices = campaignTierDualPrices(
    selected.frozenBaseBankPaymentPriceMinorUnits,
    tiers,
    frozenRules
  );

  // The Buy Now comparison price is the LATEST computed one for this variant,
  // not the campaign's frozen base. Those diverge as costs move, and the
  // shopper's real alternative is buying it now at today's price.
  const latestBuyNow = await prisma.priceCalculation.findFirst({
    where: { masterVariantId: selected.masterVariantId, status: "computed" },
    orderBy: { createdAt: "desc" },
    include: { pricingProfile: true },
  });

  // AND ITS CARD PRICE COMES FROM ITS OWN PROFILE, not the campaign's.
  //
  // The campaign froze a card rule; the Buy Now calculation was made under
  // whichever profile was active when it ran. Those are now genuinely different
  // rules — a campaign frozen before 2026-09-18 carries the fixed 5%
  // whole-dollar rule while today's Buy Now price carries the tiered $5 one.
  //
  // Deriving the comparison under the campaign's frozen rule would print a
  // "Buy it now" figure that disagrees with the price on the product page for
  // the same variant, and would make the advertised Group Buy saving wrong by
  // the difference. The frozen rule governs what the CAMPAIGN quotes; it has no
  // claim over a price computed outside it.
  const buyNowCard = latestBuyNow
    ? (buyNowBank: bigint): DualPrice =>
        dualPriceFrom(
          buyNowBank,
          new MoneyDecimal(latestBuyNow.pricingProfile.fixedCardUpliftRate.toString()),
          latestBuyNow.pricingProfile.regularCardPriceRuleId as RegularCardPriceRuleId
        )
    : dual;

  const { total: qualifyingUnitsSold } = await getQualifyingUnits(campaign.id);

  const view = buildCampaignProgress({
    campaignCode: campaign.code,
    currency: campaign.currency,
    tiers,
    qualifyingUnitsSold,
    // Falls back to the frozen base when no Buy Now calculation exists yet —
    // and then to the campaign's own rule, since there is no other profile to
    // consult. Savings read as zero rather than as a fabricated discount
    // against a comparison price we do not actually have.
    buyNowPrice: buyNowCard(
      latestBuyNow?.bankPaymentPriceMinorUnits ?? selected.frozenBaseBankPaymentPriceMinorUnits
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
