import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { normalizeOrderNumberForSearch, toWarrantyOrderLookupResponseDto } from "~/domain/warranty/orderLookupVerification";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { WarrantyOrderLookupPort, WarrantyOrderLookupSummary } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
import { ShopifyWarrantyOrderLookupAdapter } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/warranty-order-lookup — D33 (docs/ARCHITECTURE-MVP1.md),
 * RETIRED TO AUTHENTICATED-ONLY per `docs/REQUIRED-CUSTOMER-ACCOUNTS.md`
 * (LOCKED OWNER REQUIREMENT, 2026-09-26), which supersedes D33's original
 * guest order-number + email flow. Lets a signed-in customer identify their
 * own order by the human-readable number Shopify shows them (e.g. "#1001"),
 * rather than requiring the raw `gid://shopify/Order/...` the warranty claim
 * intake route (`apps.carat.warranty-claim.tsx`) needs. A RESOURCE ROUTE —
 * no default export — same reasoning as every other `apps.carat.*` route
 * (see that route's own module comment, and `csrfResourceRouteFence.test.ts`).
 *
 * ============================================================================
 * AUTHENTICATED ONLY — THE GUEST FLOW IS GONE, NOT DISABLED
 * ============================================================================
 * `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` §5-§6: warranty self-service requires
 * an authenticated Shopify customer account; guest order lookup and the
 * emailed single-use verification link are no longer a CaratForUs
 * requirement, and must not be reachable from the customer-facing product.
 * This route's identity comes SOLELY from `verifyAppProxySignature`'s
 * `loggedInCustomerId` — a value Shopify itself signs, so it cannot be
 * spoofed by anything the client sends (see `shopify/proxy/verify.ts`'s own
 * doc comment). There is no email field in the request body at all: §6 is
 * explicit that order information must never be revealed from an order
 * number plus an email address, and removing the field entirely is stronger
 * than merely ignoring it.
 *
 * A signed-out caller is refused outright (401) before any Shopify lookup —
 * there is no generic "maybe it matched" response to construct, because
 * there is no unauthenticated path left to protect the shape of.
 *
 * RESOLUTION: looks the order up by number, then requires
 * `order.customer.id === loggedInCustomerId`. On a match, the order and its
 * line items are returned immediately. On anything else — the order does
 * not exist, OR it exists but belongs to someone else — the response is the
 * SAME generic `{ resolved: false }`. Collapsing "doesn't exist" and "isn't
 * yours" into one outcome still matters for a signed-in caller: without it,
 * a customer could use this endpoint to learn that some OTHER person's
 * order number is valid, merely narrowed from "any anonymous caller" to
 * "any authenticated one," not eliminated.
 *
 * ============================================================================
 * NO NEW SHOPIFY SCOPE
 * ============================================================================
 * See `warrantyOrderLookupAdapter.server.ts`'s own header for why this works
 * by looking up the number and checking ownership, rather than listing
 * "every order for this customer" (which is believed to need
 * `read_customers`, a scope this app does not hold — flagged for the
 * architect rather than silently requested, per CLAUDE.md rule 10).
 */

const requestSchema = z.object({
  orderNumber: z.string().trim().min(1).max(50),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function noStoreJson(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

// ---------------------------------------------------------------------------
// Port wiring — mirrors apps.carat.warranty-claim.tsx's own
// createOrderLookupPort/__setWarrantyClaimOrderLookupPortForTests exactly.
// ---------------------------------------------------------------------------

let orderLookupPortOverrideForTests: WarrantyOrderLookupPort | null = null;
export function __setWarrantyOrderLookupPortForTests(port: WarrantyOrderLookupPort | null): void {
  orderLookupPortOverrideForTests = port;
}

async function createOrderLookupPort(): Promise<WarrantyOrderLookupPort> {
  if (orderLookupPortOverrideForTests) return orderLookupPortOverrideForTests;

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is not configured; the warranty order lookup route cannot reach the Shopify Admin API.");
  }
  // Dynamic import for the same reason apps.carat.warranty-claim.tsx does
  // this — see that route's own comment.
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);
  return new ShopifyWarrantyOrderLookupAdapter(admin);
}

/** `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`, or `null` for a signed-out caller — mirrors apps.carat.warranty-claim.tsx. */
function normalizeCustomerGid(rawId: string | null): string | null {
  if (!rawId) return null;
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("warranty_order_lookup.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const customerGid = normalizeCustomerGid(loggedInCustomerId);
  if (!customerGid) {
    // No guest path exists to fall back to (docs/REQUIRED-CUSTOMER-ACCOUNTS.md
    // §5-§6) — refused before any Shopify lookup or body validation, since
    // there is nothing left this request could legitimately do.
    logger.warn("warranty_order_lookup.login_required", {});
    return Response.json({ error: "login_required" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the warranty order lookup request contract");
  }
  const orderName = normalizeOrderNumberForSearch(parsed.data.orderNumber);

  let orderLookupPort: WarrantyOrderLookupPort;
  try {
    orderLookupPort = await createOrderLookupPort();
  } catch (error) {
    logger.error("warranty_order_lookup.order_lookup_port_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_unavailable" }, { status: 500 });
  }

  let lookupResult: WarrantyOrderLookupSummary | null;
  try {
    lookupResult = await orderLookupPort.findOrderByName(orderName);
  } catch (error) {
    logger.error("warranty_order_lookup.order_lookup_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_failed" }, { status: 502 });
  }

  if (lookupResult && lookupResult.customerGid === customerGid) {
    logger.info("warranty_order_lookup.resolved", {});
    return noStoreJson({ resolved: true, order: toWarrantyOrderLookupResponseDto(lookupResult) }, 200);
  }

  // Same response whether the order does not exist, or exists but belongs to
  // someone else — see module comment.
  logger.info("warranty_order_lookup.not_resolved", {});
  return noStoreJson({ resolved: false }, 200);
}
