import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import { runGuaranteeSweep } from "~/jobs/bankpayment/guaranteeSweep.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

/**
 * POST /internal/jobs/bank-payment-guarantee (spec §13/§14, criteria
 * 100-102).
 *
 * A RESOURCE ROUTE — no default export. Identical reasoning to
 * `internal.jobs.price-recalculation.tsx`: `allowedActionOrigins` resolves
 * to an empty array in every production build, so a default export here
 * would 400 the platform scheduler before any of this code runs.
 * `csrfResourceRouteFence.test.ts` enforces this for every `internal.*`
 * route, this one included. DO NOT ADD A DEFAULT EXPORT.
 *
 * CADENCE IS HOURLY (criterion 100), and — same discipline as the
 * recalculation route's own header comment — that is a SCHEDULER
 * configuration, not something encoded here. `runGuaranteeSweep` itself
 * has no opinion on how often it is called; nothing in this file assumes
 * "once an hour" either. Configure the platform scheduler to invoke this
 * endpoint hourly; changing that cadence later is a scheduler change, not
 * a code change.
 *
 * AUTHENTICATION MIRRORS THE RECALCULATION ROUTE EXACTLY (same shared
 * `CRON_SECRET`, same header, same timing-safe comparison) rather than
 * factoring out a shared helper — two three-line functions are cheaper to
 * keep obviously correct than a shared abstraction used by exactly two
 * call sites so far.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

export async function action({ request }: ActionFunctionArgs) {
  // Authenticate BEFORE anything else, so an unauthenticated caller cannot
  // trigger a sweep or cause any work at all.
  if (!isAuthorised(request)) {
    logger.warn("bank_payment.guarantee_sweep_rejected", { reason: "invalid_or_missing_secret" });
    return new Response(null, { status: 401 });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const summary = await runGuaranteeSweep();
  // Counts and a timestamp only — no price, cost or margin value (criterion
  // 30's discipline, applied here even though this route is not itself a
  // pricing surface).
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
