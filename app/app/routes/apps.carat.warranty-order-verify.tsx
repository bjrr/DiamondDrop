import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import {
  peekWarrantyOrderLookupVerification,
  redeemWarrantyOrderLookupVerification,
} from "~/db/repositories/warrantyOrderLookupVerificationRepository.server";
import { toWarrantyOrderLookupResponseDto } from "~/domain/warranty/orderLookupVerification";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { WarrantyOrderLookupPort, WarrantyOrderLookupSummary } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
import { ShopifyWarrantyOrderLookupAdapter } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/warranty-order-verify — D33 (docs/ARCHITECTURE-MVP1.md).
 * Redeems the single-use token `apps.carat.warranty-order-lookup.tsx` emailed
 * to a guest, and returns the order/line data the customer can then submit to
 * `apps.carat.warranty-claim.tsx`. A RESOURCE ROUTE — no default export, POST
 * only — same reasoning as every other `apps.carat.*` route.
 *
 * ============================================================================
 * WHY THIS MUST BE A POST, AND WHY THE EMAILED LINK MUST NOT POINT HERE
 * ============================================================================
 * The token is single-use by design (see
 * `warrantyOrderLookupVerificationRepository.server.ts`'s `redeemWarrantyOrderLookupVerification`).
 * If the emailed link pointed directly at this endpoint and a mere GET
 * consumed it, an email client's or security gateway's automated link
 * prefetch (a well-documented real-world behaviour — Outlook Safe Links,
 * corporate mail gateways, some antivirus scanners) could silently burn the
 * token before the customer ever opens the email, permanently locking them
 * out with no attacker involved at all.
 *
 * This route is POST-only and expects the token in the JSON body, never the
 * query string, specifically so a bare GET (whether a real click or a
 * scanner's prefetch) cannot trigger redemption. THE EMAILED LINK ITSELF
 * MUST POINT AT A STOREFRONT LANDING PAGE (see `WARRANTY_ORDER_VERIFY_PATH`
 * in `apps.carat.warranty-order-lookup.tsx`), NOT at this endpoint — that
 * page's own script reads `?token=` from its URL and issues the POST here
 * only once its own JavaScript runs, which a passive link-prefetch does not
 * do. Building that landing page is a storefront/theme task, not this one;
 * see this task's handoff for the exact contract it must implement.
 *
 * ============================================================================
 * WHY DISTINGUISHING invalid/expired/already_used HERE IS NOT AN ORACLE
 * ============================================================================
 * Unlike the lookup route, this route is fine returning distinct outcomes
 * for a bad token. Reaching this code at all requires possessing a
 * high-entropy (256-bit) bearer value that was never guessable and was only
 * ever transmitted to the one email address it matched — knowing whether
 * THAT specific token is invalid, expired, or already used reveals nothing
 * about any order or email address anyone else's request may or may not
 * exist for.
 *
 * ============================================================================
 * PEEK, THEN FETCH, THEN CONSUME — WHY THE TOKEN IS NOT SPENT UNTIL SHOPIFY
 * ANSWERS (team-lead review note)
 * ============================================================================
 * An earlier version of this route consumed the token FIRST (`redeemWarrantyOrderLookupVerification`),
 * then re-fetched the order from Shopify. That meant a transient Shopify
 * failure — an outage, a timeout, anything that makes `findOrderByGid` throw
 * or return `null` for a reason that has nothing to do with the order really
 * being gone — permanently stranded the customer: their one-time link was
 * already burned, and the only way forward was contacting support. The
 * storefront landing page correctly offers no retry for exactly this reason,
 * which means the ordering itself was the bug, not the lack of a retry
 * button.
 *
 * This route now: (1) `peekWarrantyOrderLookupVerification` — a READ-ONLY
 * classification that does NOT touch `consumed_at`, just enough to learn
 * which order to ask Shopify about; (2) re-fetches that order from Shopify;
 * (3) ONLY IF that fetch returns a real order does it call
 * `redeemWarrantyOrderLookupVerification` to actually spend the token. A
 * throw OR a `null` from the Shopify fetch leaves the token untouched and
 * still usable — the customer (or their browser, automatically) can simply
 * retry the same POST once Shopify recovers, using the exact same link.
 *
 * THE SINGLE-USE-UNDER-CONCURRENCY GUARANTEE IS UNCHANGED. The ONLY
 * operation that ever sets `consumed_at` is still `redeemWarrantyOrderLookupVerification`'s
 * one conditional UPDATE, and it is still the LAST thing this handler does.
 * Two concurrent requests for the same token can both peek "active" and can
 * both independently re-fetch from Shopify (redundant API calls, but
 * harmless — this route's queries are read-only against Shopify) — but only
 * one of their two `redeemWarrantyOrderLookupVerification` calls can win the
 * UPDATE; the other gets `already_used` at that final step, exactly as
 * before. See the repository function's own comment and the concurrency
 * test proving two simultaneous end-to-end POSTs to THIS route still yield
 * exactly one success.
 */

const bodySchema = z.object({
  token: z.string().min(16).max(512),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function noStoreJson(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

let orderLookupPortOverrideForTests: WarrantyOrderLookupPort | null = null;
export function __setWarrantyOrderVerifyLookupPortForTests(port: WarrantyOrderLookupPort | null): void {
  orderLookupPortOverrideForTests = port;
}

async function createOrderLookupPort(): Promise<WarrantyOrderLookupPort> {
  if (orderLookupPortOverrideForTests) return orderLookupPortOverrideForTests;

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is not configured; the warranty order verify route cannot reach the Shopify Admin API.");
  }
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);
  return new ShopifyWarrantyOrderLookupAdapter(admin);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("warranty_order_verify.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the warranty order verify request contract");
  }

  // STEP 1 — PEEK. Read-only; does not touch consumed_at. See module comment.
  const peeked = await peekWarrantyOrderLookupVerification(parsed.data.token);

  if (peeked.outcome === "invalid") {
    logger.warn("warranty_order_verify.token_invalid", {});
    return noStoreJson({ error: "invalid_token" }, 400);
  }
  if (peeked.outcome === "expired") {
    logger.info("warranty_order_verify.token_expired", {});
    return noStoreJson({ error: "token_expired" }, 410);
  }
  if (peeked.outcome === "already_used") {
    logger.info("warranty_order_verify.token_already_used", {});
    return noStoreJson({ error: "token_already_used" }, 409);
  }

  // STEP 2 — FETCH. Re-fetch the order fresh from Shopify rather than
  // trusting whatever line items existed when the lookup was first
  // requested (see this file's module comment and the repository's own
  // header comment). The token is NOT consumed yet — a failure here leaves
  // it fully usable for a retry.
  let orderLookupPort: WarrantyOrderLookupPort;
  try {
    orderLookupPort = await createOrderLookupPort();
  } catch (error) {
    logger.error("warranty_order_verify.order_lookup_port_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_unavailable" }, { status: 500 });
  }

  let freshOrder: WarrantyOrderLookupSummary | null;
  try {
    freshOrder = await orderLookupPort.findOrderByGid(peeked.orderRef);
  } catch (error) {
    // TOKEN NOT CONSUMED — a transient Shopify failure must not strand the
    // customer's one-time link. See module comment.
    logger.error("warranty_order_verify.order_lookup_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_failed" }, { status: 502 });
  }

  if (!freshOrder) {
    // TOKEN NOT CONSUMED — same reasoning as the throw case above. A `null`
    // here could mean the order genuinely no longer exists, but it could
    // equally mean Shopify-side eventual-consistency lag; either way,
    // leaving the token valid costs nothing (it still expires naturally) and
    // an order that really is gone will simply keep returning this same
    // refusal on any retry, never a false success.
    logger.error("warranty_order_verify.order_no_longer_resolvable", {});
    return noStoreJson({ error: "order_no_longer_resolvable" }, 404);
  }

  // STEP 3 — CONSUME. Only now, having confirmed we can hand back real
  // order data, is the token actually spent. This is the ONLY call in this
  // handler that can set consumed_at (see the repository function's own
  // comment on why the single-use-under-concurrency guarantee is unaffected
  // by moving this call to be last).
  const consumed = await redeemWarrantyOrderLookupVerification(parsed.data.token);
  if (consumed.outcome === "expired") {
    // Lost a narrow race against the clock while the Shopify fetch was in
    // flight — the token expired between the peek and this call.
    logger.info("warranty_order_verify.token_expired_during_fetch", {});
    return noStoreJson({ error: "token_expired" }, 410);
  }
  if (consumed.outcome === "already_used" || consumed.outcome === "invalid") {
    // Lost a narrow race against a CONCURRENT redemption of the same token
    // that reached this step first (`already_used`), or an unreachable
    // defensive case (`invalid` — the peek above already proved the token
    // exists). Either way, this request did not win the token.
    logger.info("warranty_order_verify.token_consumed_by_concurrent_request", { outcome: consumed.outcome });
    return noStoreJson({ error: "token_already_used" }, 409);
  }

  logger.info("warranty_order_verify.redeemed", {});
  return noStoreJson({ resolved: true, order: toWarrantyOrderLookupResponseDto(freshOrder) }, 200);
}
