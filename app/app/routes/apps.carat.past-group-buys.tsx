import type { LoaderFunctionArgs } from "react-router";

import { listPastGroupBuyCampaigns } from "~/db/repositories/groupBuyRepository.server";
import type { FrozenCampaignPricingRules } from "~/domain/groupbuy/campaignTierPricing";
import {
  buildPastGroupBuyCampaignView,
  type PastGroupBuyCampaignView,
} from "~/domain/groupbuy/pastGroupBuyArchive";
import { MoneyDecimal } from "~/domain/money/decimal";
import type { RoundingRuleId } from "~/domain/money/rounding";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/past-group-buys?limit=N
 *
 * The PUBLIC Past Group Buys archive. README: "Maintain a public Past Group
 * Buys archive preserving actual final unit count and historical
 * starting/final unlocked price. Homepage may show the five most recent."
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `apps.carat.*` route: `allowedActionOrigins: []` means a component here
 * would pull server code into the client bundle.
 *
 * ============================================================================
 * NO CUSTOMER, NO AUTHENTICATION — AND NOTHING PERSONAL IN THE RESPONSE
 * ============================================================================
 * Unlike the approval and checkout surfaces, this one is genuinely public:
 * past campaigns are merchandising history that anyone may read. The App Proxy
 * signature is still required, because an unsigned request is a direct hit on
 * our origin rather than a storefront page, but no logged-in customer is
 * needed and none is consulted.
 *
 * Which makes the response contents the thing to be careful about. It carries
 * campaign names, final unit COUNTS and historical prices — never who bought,
 * never an order, never a variant or profile id. `listPastGroupBuyCampaigns`
 * selects only the columns needed, so nothing personal is even in memory here.
 *
 * ============================================================================
 * WHY THE ROWS CAN BE SHORTER THAN THE LIMIT
 * ============================================================================
 * A closed campaign with no locked final figures, no eligible variants, or no
 * frozen pricing profile cannot be priced as history, and a public row with a
 * blank final price is a statement we cannot stand behind. Those campaigns are
 * OMITTED — and every omission is logged with its reason, because a silently
 * short archive reads as "that's all there was".
 */

const DEFAULT_LIMIT = 5; // README: "Homepage may show the five most recent."
const MAX_LIMIT = 50;

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  // Rejects "5.5", "1e3", "-5" and " 5 " alike rather than coercing them.
  if (!/^\d{1,3}$/.test(raw)) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) return DEFAULT_LIMIT;
  return parsed > MAX_LIMIT ? MAX_LIMIT : parsed;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const { verified, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("groupbuy.past_archive_proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const rows = await listPastGroupBuyCampaigns(limit);

  const campaigns: PastGroupBuyCampaignView[] = [];
  for (const row of rows) {
    if (!row.frozenProfile) {
      logger.warn("groupbuy.past_archive_campaign_omitted", {
        campaignCode: row.code,
        reason: "no_frozen_pricing_profile",
      });
      continue;
    }

    // THE CAMPAIGN'S OWN FROZEN RULES, never today's. A campaign that closed
    // under the superseded fixed-5% whole-dollar card rule is still quoted
    // under it — restating history under current rules would make the archive
    // disagree with the prices customers actually paid.
    const rules: FrozenCampaignPricingRules = {
      currency: row.currency,
      fixedCardUpliftRate: new MoneyDecimal(row.frozenProfile.fixedCardUpliftRate),
      regularCardPriceRuleId: row.frozenProfile.regularCardPriceRuleId as RegularCardPriceRuleId,
      roundingRuleId: row.frozenProfile.roundingRuleId as RoundingRuleId,
      priceEndingRuleId: row.frozenProfile.priceEndingRuleId as PriceEndingRuleId,
    };

    const result = buildPastGroupBuyCampaignView({
      code: row.code,
      name: row.name,
      currency: row.currency,
      closedAt: row.closedAt,
      finalQualifyingUnits: row.finalQualifyingUnits,
      finalTierNumber: row.finalTierNumber,
      tiers: row.tiers,
      frozenVariantBasesMinorUnits: row.frozenVariantBasesMinorUnits,
      rules,
    });

    if (!result.ok) {
      logger.warn("groupbuy.past_archive_campaign_omitted", {
        campaignCode: row.code,
        reason: result.reason,
      });
      continue;
    }
    campaigns.push(result.view);
  }

  return Response.json(
    {
      campaigns,
      /* THE NOTE REQUIRED BY CLAUDE.md RULE 13. Prices above are Regular/Card
         prices; the theme must render this rather than restating it, and must
         not invent a percentage. Nothing here is purchasable, so there is no
         payment type to choose — this is why the archive quotes one price per
         figure instead of a pair. */
      regularCardPriceNote: "Prices shown are Regular/Card prices. Lower pricing was available with Bank Payment.",
    },
    {
      headers: {
        /* PUBLIC AND CACHEABLE, unlike the live progress endpoint. These
           figures are locked history: a closed campaign's final unit count
           and prices cannot change, so there is no stale-data risk and no
           per-shopper variation to leak between viewers. */
        "Cache-Control": "public, max-age=300",
      },
    }
  );
}
