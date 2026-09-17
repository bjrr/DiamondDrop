import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

/**
 * POST /internal/jobs/price-recalculation (spec §9.1).
 *
 * A RESOURCE ROUTE — no default export, matching slice 0's webhook routes.
 *
 * That is not incidental. React Router 7 added `throwIfPotentialCSRFAttack`,
 * which rejects mutation-method requests to routes WITH a default export
 * unless the Origin is allowlisted, and the default allowlist is empty
 * (architecture §2.1 "R-1", finding F-23). Resource routes are exempt, and a
 * cron invocation sends no Origin header in any case.
 *
 * DO NOT ADD A DEFAULT EXPORT to this file without re-reading F-23: doing so
 * would start rejecting the scheduler with a 400 before any of our code runs,
 * and the failure would look like a scheduler problem rather than a framework
 * one.
 *
 * Invoked by the platform scheduler (R21) — there is no in-process timer.
 * Daily by default; twice-daily is a scheduler configuration change, not a
 * code change (R7, and D15 is still open).
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

export async function action({ request }: ActionFunctionArgs) {
  // Authenticate BEFORE reading the body, so an unauthenticated caller cannot
  // make us allocate or parse anything.
  if (!isAuthorised(request)) {
    logger.warn("pricing.cron_rejected", { reason: "invalid_or_missing_secret" });
    return new Response(null, { status: 401 });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const summary = await runPriceRecalculation();
  // Counts and references only — no price, cost or margin values (criterion 30).
  return Response.json(summary, { status: 200 });
}

function isAuthorised(request: Request): boolean {
  const presented = request.headers.get(CRON_SECRET_HEADER);
  if (presented === null) return false;

  const { CRON_SECRET } = getEnv();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(CRON_SECRET, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself leak
  // length through an exception path — compare lengths first and return the
  // same false either way.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
