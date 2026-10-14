import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import {
  resolveDefaultParticipantEmailLookup,
  runGroupBuyMilestoneSweep,
} from "~/jobs/groupbuy/milestoneNotificationSweep.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

/**
 * POST /internal/jobs/group-buy-milestones — the Group Buy participant
 * milestone emails README line 245 requires (tier unlock, best-tier unlock,
 * campaign close).
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `internal.jobs.*` route: `allowedActionOrigins` resolves to an empty array
 * in every production build, so a default export here would 400 the platform
 * scheduler before any of this code runs. `csrfResourceRouteFence.test.ts`
 * enforces this. DO NOT ADD A DEFAULT EXPORT.
 *
 * CADENCE IS A SCHEDULER CONFIGURATION, NOT ENCODED HERE — same discipline as
 * every other `internal.jobs.*` route. `runGroupBuyMilestoneSweep` is
 * idempotent under arbitrarily frequent or overlapping invocation. Hourly,
 * matching the other Group Buy sweep, is a reasonable default; nothing in
 * this file assumes it.
 *
 * AUTHENTICATION MIRRORS EVERY OTHER `internal.jobs.*` ROUTE EXACTLY (same
 * shared `CRON_SECRET`, same header, same timing-safe comparison) rather than
 * factoring out a shared helper — see `internal.jobs.bank-payment-guarantee.tsx`'s
 * own comment on why that duplication is deliberate.
 *
 * NO ADMIN CLIENT IS RESOLVED HERE. Card-basis participants' addresses come
 * from Shopify, but `shopify.server.test.ts` fences every `internal.jobs.*`
 * route against touching `unauthenticated.admin` directly — a cron request
 * has no shop session and no App Bridge frame. The acquisition lives in the
 * job module, the same way this route's siblings reach the Admin API only
 * through their sweeps. DO NOT INLINE IT HERE.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

export async function action({ request }: ActionFunctionArgs) {
  if (!isAuthorised(request)) {
    logger.warn("group_buy_milestone.sweep_rejected", { reason: "invalid_or_missing_secret" });
    return new Response(null, { status: 401 });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const summary = await runGroupBuyMilestoneSweep({
    participantEmailLookup: await resolveDefaultParticipantEmailLookup(),
  });

  // Counts only — no address, no price, no cost or margin value.
  return Response.json(summary, { status: 200 });
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
