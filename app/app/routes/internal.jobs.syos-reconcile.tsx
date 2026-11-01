import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import { reconcileCompatibility, syncProduct } from "~/jobs/setyourownstone/syncCompatibility.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { adminClientForShop } from "~/shopify/admin/offlineClient.server";

/**
 * POST /internal/jobs/syos-reconcile — rebuild the Set Your Own Stone
 * compatibility index from Shopify.
 *
 * THE RECOVERY HALF of the sync design. Events give freshness; this gives
 * recovery, and it is the thing that proves `ReadySettingCompatibility` is
 * genuinely derived — if this cannot reproduce the index, something is being
 * authored in our database that should not be.
 *
 * Optionally takes `productGids` to sync specific products, which is how a
 * newly imported mounting gets its first rows: it has never emitted an event
 * and has no existing rows for reconciliation to find.
 *
 * NO NEW LOGIC. It calls the same `syncProduct` the two event handlers call,
 * so event-derived and reconciliation-derived rows cannot diverge.
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `internal.jobs.*` route: `allowedActionOrigins` resolves to an empty array
 * in every production build, so a default export would 400 the scheduler
 * before any of this code runs. `csrfResourceRouteFence.test.ts` enforces it.
 * DO NOT ADD A DEFAULT EXPORT.
 *
 * AUTHENTICATION MIRRORS EVERY OTHER `internal.jobs.*` ROUTE EXACTLY — same
 * shared `CRON_SECRET`, same header, same timing-safe comparison — rather
 * than factoring out a helper, for the reason
 * `internal.jobs.bank-payment-guarantee.tsx` already gives.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

export async function action({ request }: ActionFunctionArgs) {
  if (!isAuthorised(request)) {
    logger.warn("syos_reconcile.rejected", { reason: "invalid_or_missing_secret" });
    return new Response(null, { status: 401 });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // The shop this app serves. A cron request carries no session, so it is
  // named explicitly rather than inferred.
  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    return Response.json({ error: "SHOPIFY_SHOP_DOMAIN is not configured" }, { status: 500 });
  }

  const client = await adminClientForShop(SHOPIFY_SHOP_DOMAIN);
  if (!client) {
    return Response.json(
      { error: `no offline Shopify session for ${SHOPIFY_SHOP_DOMAIN}` },
      { status: 503 }
    );
  }

  let productGids: string[] = [];
  try {
    const body = (await request.json()) as { productGids?: unknown };
    if (Array.isArray(body.productGids)) {
      productGids = body.productGids.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // No body is the ordinary scheduled case: reconcile everything known.
  }

  // One named product is a targeted sync; everything else is a full rebuild.
  if (productGids.length === 1) {
    const outcome = await syncProduct(client, productGids[0]!);
    return Response.json({ mode: "product", ...outcome }, { status: 200 });
  }

  const result = await reconcileCompatibility(client, { additionalProductGids: productGids });

  // Counts and problem summaries only — no price, cost or margin value.
  return Response.json(
    {
      mode: "reconcile",
      productsConsidered: result.productsConsidered,
      synced: result.outcomes.length,
      rowsUpserted: result.outcomes.reduce((n, o) => n + o.rowsUpserted, 0),
      rowsDeactivated: result.outcomes.reduce((n, o) => n + o.rowsDeactivated, 0),
      eligible: result.outcomes.reduce((n, o) => n + o.eligible, 0),
      withProblems: result.outcomes.reduce((n, o) => n + o.withProblems, 0),
      failures: result.failures,
    },
    { status: 200 }
  );
}

function isAuthorised(request: Request): boolean {
  const presented = request.headers.get(CRON_SECRET_HEADER);
  if (presented === null) return false;

  const { CRON_SECRET } = getEnv();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(CRON_SECRET, "utf8");

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
