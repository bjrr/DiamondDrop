import type { LoaderFunctionArgs } from "react-router";

import { isTestFixtureCampaignCode } from "~/domain/groupbuy/testFixtureCampaign";
import { getPublicGroupBuyCampaign } from "~/jobs/groupbuy/publicCampaignFeed.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * GET /apps/carat/group-buy-campaign/:code
 *
 * Everything the campaign detail page needs on first paint: presentation,
 * imagery, the frozen customer options, and opening progress.
 *
 * DELIBERATELY SEPARATE FROM `/apps/carat/group-buy/:code`, which stays as it
 * was. That endpoint answers "what does THIS VARIANT cost right now" and is
 * called again on every configuration change; this one answers "what is this
 * campaign" and is called once per page load. Folding them together would
 * mean re-sending imagery and the whole options contract every time a shopper
 * taps a different ring size.
 *
 * A RESOURCE ROUTE — no default export; see `csrfResourceRouteFence.test.ts`.
 *
 * REACHABLE WHEN CLOSED. A shared link must keep working after a campaign
 * ends: the page then renders its historical state rather than breaking. A
 * DRAFT is never reachable, and a live-gate fixture is refused by code with
 * the SAME `not_found` as an unknown campaign — identical response, so
 * probing cannot confirm that a fixture exists.
 */

function notFound() {
  // Indistinguishable from "exists but is not public". A storefront has no
  // business learning which campaigns are being planned.
  return Response.json({ error: "not_found" }, { status: 404 });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const { verified, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    logger.warn("groupbuy.detail_proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const code = params.code;
  if (!code) return notFound();

  // THE FIXTURE REFUSAL COMES BEFORE THE LOOKUP, and before anything is
  // revealed by timing. Live-gate campaigns are real open campaigns with real
  // frozen prices; "nobody knows the code" is an assumption, not a control.
  if (isTestFixtureCampaignCode(code)) {
    logger.warn("groupbuy.public_detail_test_fixture_refused", { campaignCode: code });
    return notFound();
  }

  const result = await getPublicGroupBuyCampaign(code);
  if (!result.ok) return notFound();

  return Response.json(result.detail, {
    headers: {
      // A closed campaign's detail never changes again, so it can be cached
      // for longer. An open one carries live progress and must not be.
      "Cache-Control":
        result.detail.status === "closed" ? "private, max-age=300" : "private, max-age=15",
    },
  });
}
