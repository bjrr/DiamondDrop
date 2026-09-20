import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import {
  MissingTriggerActorError,
  runPriceRecalculation,
} from "~/jobs/pricing/runRecalculation.server";
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
 * D15 (owner-resolved 2026-09-17) sets the cadence at DAILY. Twice-daily, or
 * any other schedule, is a scheduler configuration change rather than a code
 * change: nothing here encodes "once a day".
 *
 * D15 also allows staff to trigger an immediate run instead of waiting for the
 * next scheduled one. That arrives on this same endpoint with a JSON body
 * naming the trigger and the person responsible; a scheduled run sends no body.
 * One endpoint rather than two, because the work is identical and only the
 * attribution differs — and a second endpoint would be a second thing to
 * secure.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

/**
 * D15 staff-trigger body. Every field is optional: a scheduled run posts no
 * body at all, which is what keeps the existing cron configuration working
 * unchanged.
 */
interface StaffTriggerBody {
  trigger?: "scheduled" | "staff" | "metal_price_entry";
  triggeredBy?: string;
  reason?: string;
}

const ALLOWED_TRIGGERS = new Set(["scheduled", "staff", "metal_price_entry"]);

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

  let options: StaffTriggerBody = {};
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      options = (await request.json()) as StaffTriggerBody;
    } catch {
      return Response.json({ error: "malformed JSON body" }, { status: 400 });
    }
  }

  // Validated here rather than trusted: this endpoint writes the attribution
  // that a later dispute relies on, so "who asked for this run" must be a real
  // claim from the caller, not a default we invented.
  if (options.trigger !== undefined && !ALLOWED_TRIGGERS.has(options.trigger)) {
    return Response.json({ error: "unknown trigger" }, { status: 400 });
  }
  if (options.trigger !== undefined && options.trigger !== "scheduled" && !options.triggeredBy) {
    return Response.json(
      { error: "triggeredBy is required for a staff-triggered run" },
      { status: 400 }
    );
  }

  try {
    // Slice 2 T1 (criteria 8-9, F-27). The real Shopify-backed port is
    // constructed HERE, via a dynamic import, and only when auto-publish is
    // actually on — never at module scope. See the header comment on
    // app/shopify/admin/productionPriceSyncPort.server.ts for why: importing
    // it unconditionally would make this route (and the whole nightly
    // recalculation) fail to load without Shopify OAuth configured, even
    // though auto-publish defaults off and the route works fine without it.
    const autoPublishEnabled = getEnv().PRICE_AUTO_PUBLISH_ENABLED === "true";
    const productionShopifyModule = autoPublishEnabled
      ? await import("~/shopify/admin/productionPriceSyncPort.server")
      : undefined;
    const syncPort = await productionShopifyModule?.createProductionPriceSyncPort();
    // Stage 2B / R13. Same module, same laziness reasoning as syncPort above
    // — constructed only when auto-publish is actually on, never at module
    // scope. A failure constructing this (e.g. no stored offline session)
    // is as loud as the sync port's own — auto-publish being enabled without
    // a working Shopify connection is a misconfiguration either way.
    const metafields = await productionShopifyModule?.createProductionMetafieldPublishDeps();

    const summary = await runPriceRecalculation({
      trigger: options.trigger,
      triggeredBy: options.triggeredBy,
      reason: options.reason,
      syncPort,
      metafields,
      autoPublishEnabled,
    });
    // Counts and references only — no price, cost or margin values (criterion 30).
    return Response.json(summary, { status: 200 });
  } catch (error) {
    if (error instanceof MissingTriggerActorError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
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
