import type { LoaderFunctionArgs } from "react-router";

import { listPublicGroupBuyCampaigns } from "~/jobs/groupbuy/publicCampaignFeed.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/group-buy-campaigns
 *
 * Every Group Buy a customer may discover right now — the Group Buy hub's
 * entire data source, in ONE request.
 *
 * A RESOURCE ROUTE — no default export. React Router 7's CSRF guard applies
 * only to modules that have one, and an App Proxy caller always arrives from
 * the storefront's origin rather than this app's (architecture §2.1, finding
 * F-23, pinned by `csrfResourceRouteFence.test.ts`).
 *
 * SIGNATURE VERIFIED BEFORE THE DATABASE IS TOUCHED, exactly as the
 * per-campaign progress endpoint does. This one reveals which campaigns
 * exist, so an unsigned caller must not be able to learn that — nor to use
 * response timing to infer it.
 *
 * ONE REQUEST, NOT ONE PER VARIANT. The requirement was explicit that the hub
 * must not make a browser request per variant per campaign. Everything the
 * cards need — including each campaign's lowest current-tier price, which is
 * a server-side computation over its eligible variants — is assembled in
 * `listPublicGroupBuyCampaigns` and returned here as a single payload.
 *
 * WHAT IT CANNOT RETURN. The response is `PublicCampaignSummary[]`, a type
 * with no field for cost, margin, floor, pricing-profile data, variant
 * identifiers, staff actors or snapshots. The absence is structural rather
 * than a matter of remembering to strip things.
 */

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const { verified, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    logger.warn("groupbuy.hub_proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const campaigns = await listPublicGroupBuyCampaigns();

  return Response.json(
    { campaigns },
    {
      headers: {
        // SHORT AND PRIVATE, for the same reason the progress endpoint is:
        // unit counts and tiers move as people buy, and a shared cache would
        // show one shopper another's stale progress. Slightly longer than the
        // per-campaign endpoint's 15s because the hub is a scanning surface
        // where a few seconds of staleness costs nothing.
        "Cache-Control": "private, max-age=30",
      },
    }
  );
}
