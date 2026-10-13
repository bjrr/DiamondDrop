import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import { runGroupBuyBankPaymentInactivationSweep } from "~/jobs/bankpayment/groupBuyBankPaymentInactivationSweep.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

/**
 * POST /internal/jobs/group-buy-bank-payment-window (owner §24: 48h+48h
 * payment window, inactivate after 96h unpaid).
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as
 * `internal.jobs.bank-payment-guarantee.tsx`: `allowedActionOrigins`
 * resolves to an empty array in every production build, so a default
 * export here would 400 the platform scheduler before any of this code
 * runs. `csrfResourceRouteFence.test.ts` enforces this for every
 * `internal.*` route. DO NOT ADD A DEFAULT EXPORT.
 *
 * CADENCE IS A SCHEDULER CONFIGURATION, NOT ENCODED HERE — same discipline
 * as every other `internal.jobs.*` route.
 * `runGroupBuyBankPaymentInactivationSweep` is idempotent under arbitrarily
 * frequent or overlapping invocation, so an hourly cadence (matching the Buy
 * Now guarantee sweep) is a reasonable default, but nothing in this file
 * assumes it.
 *
 * AUTHENTICATION MIRRORS EVERY OTHER `internal.jobs.*` ROUTE EXACTLY (same
 * shared `CRON_SECRET`, same header, same timing-safe comparison) rather
 * than factoring out a shared helper — see
 * `internal.jobs.bank-payment-guarantee.tsx`'s own comment on why that
 * duplication is deliberate.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

export async function action({ request }: ActionFunctionArgs) {
  if (!isAuthorised(request)) {
    logger.warn("group_buy_bank_payment.inactivation_sweep_rejected", { reason: "invalid_or_missing_secret" });
    return new Response(null, { status: 401 });
  }

  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const summary = await runGroupBuyBankPaymentInactivationSweep();
  // Counts and a timestamp only — no price, cost or margin value.
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
