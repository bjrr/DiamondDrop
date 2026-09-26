import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { redeemWarrantyOrderLookupVerification } from "~/db/repositories/warrantyOrderLookupVerificationRepository.server";
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

  const result = await redeemWarrantyOrderLookupVerification(parsed.data.token);

  if (result.outcome === "invalid") {
    logger.warn("warranty_order_verify.token_invalid", {});
    return noStoreJson({ error: "invalid_token" }, 400);
  }
  if (result.outcome === "expired") {
    logger.info("warranty_order_verify.token_expired", {});
    return noStoreJson({ error: "token_expired" }, 410);
  }
  if (result.outcome === "already_used") {
    logger.info("warranty_order_verify.token_already_used", {});
    return noStoreJson({ error: "token_already_used" }, 409);
  }

  // SUCCESS — re-fetch the order fresh from Shopify rather than trusting
  // whatever line items existed when the lookup was first requested (see
  // this file's module comment and the repository's own header comment).
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
    freshOrder = await orderLookupPort.findOrderByGid(result.orderRef);
  } catch (error) {
    logger.error("warranty_order_verify.order_lookup_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_failed" }, { status: 502 });
  }

  if (!freshOrder) {
    // The order existed when the lookup was requested but cannot be
    // re-resolved now — refuse rather than serve stale data. The token is
    // already permanently consumed at this point (by design: a token proves
    // "this inbox was verified for this order," not "this order still
    // exists" — a customer whose order has since vanished still needed to
    // start over with a fresh lookup either way).
    logger.error("warranty_order_verify.order_no_longer_resolvable", {});
    return noStoreJson({ error: "order_no_longer_resolvable" }, 404);
  }

  logger.info("warranty_order_verify.redeemed", {});
  return noStoreJson({ resolved: true, order: toWarrantyOrderLookupResponseDto(freshOrder) }, 200);
}
