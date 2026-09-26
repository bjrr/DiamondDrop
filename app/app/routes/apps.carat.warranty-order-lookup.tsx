import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import {
  performDummyWarrantyOrderLookupRoundTrip,
  createWarrantyOrderLookupVerification,
} from "~/db/repositories/warrantyOrderLookupVerificationRepository.server";
import {
  buildWarrantyOrderVerificationEmail,
  emailsMatch,
  normalizeOrderNumberForSearch,
  toWarrantyOrderLookupResponseDto,
} from "~/domain/warranty/orderLookupVerification";
import { resolveEmailPort as defaultResolveEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { WarrantyOrderLookupPort, WarrantyOrderLookupSummary } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
import { ShopifyWarrantyOrderLookupAdapter } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/warranty-order-lookup — D33 (docs/ARCHITECTURE-MVP1.md).
 * Lets a customer identify their order by the human-readable number Shopify
 * shows them (e.g. "#1001"), rather than requiring the raw
 * `gid://shopify/Order/...` the warranty claim intake route
 * (`apps.carat.warranty-claim.tsx`) needs. A RESOURCE ROUTE — no default
 * export — same reasoning as every other `apps.carat.*` route (see that
 * route's own module comment, and `csrfResourceRouteFence.test.ts`).
 *
 * ============================================================================
 * TWO FLOWS, ONE ENDPOINT, BRANCHED ONLY ON THE SIGNED PROXY IDENTITY
 * ============================================================================
 * D33 draws a hard line: a logged-in customer's identity comes from
 * `verifyAppProxySignature`'s `loggedInCustomerId` — a value Shopify itself
 * signs, so it cannot be spoofed by anything the client sends (see
 * `shopify/proxy/verify.ts`'s own doc comment). A guest has no such identity,
 * so ownership can only be established by proving control of the order's own
 * email inbox.
 *
 * LOGGED-IN: resolves the order by number, then requires
 * `order.customer.id === loggedInCustomerId`. On a match, the order and its
 * line items are returned IMMEDIATELY — no email round trip, because
 * Shopify's own signature already proved who is asking. On anything else —
 * the order does not exist, OR it exists but belongs to someone else — the
 * response is the SAME generic `{ resolved: false }`. Collapsing "doesn't
 * exist" and "isn't yours" into one outcome matters even for an
 * authenticated caller: without it, a logged-in customer could still use
 * this endpoint to learn that some OTHER person's order number is valid,
 * which is exactly the enumeration D33 exists to prevent — just narrowed
 * from "any anonymous caller" to "any logged-in one," not eliminated.
 *
 * GUEST: requires `purchaserEmail`. If the order exists and its email
 * matches (case-insensitively, see `emailsMatch`), a single-use, short-lived
 * verification token is created and a link is emailed to the order's own
 * address — never to whatever the caller typed if it did not match, since
 * nothing is sent on a mismatch at all. Redemption (proof of inbox control)
 * happens at `apps.carat.warranty-order-verify.tsx`. Regardless of match,
 * this route's response to a guest is IDENTICAL: same status, same body.
 *
 * ============================================================================
 * ANTI-ENUMERATION TIMING — A DELIBERATE NARROWING, NOT A CLAIMED EQUALIZATION
 * ============================================================================
 * The dominant cost of every guest request is the Shopify Admin API round
 * trip in `findOrderByName`, below — that happens identically whether or not
 * the order/email end up matching, so the biggest potential timing signal is
 * already shared. Within the match/no-match branches this route additionally:
 *   - never awaits the outbound verification email (fire-and-forget, caught,
 *     logged, and durably audited — see `dispatchVerificationEmail`) — an
 *     SMTP/API provider's latency must never leak into the HTTP response
 *     timing, and a failed send must never look different from a successful
 *     one to the caller;
 *   - has the no-match branch perform `performDummyWarrantyOrderLookupRoundTrip()`
 *     instead of finishing immediately, so it is not trivially, obviously
 *     cheaper than the match branch's one INSERT.
 * BE PRECISE ABOUT WHAT THIS DOES NOT CLAIM. `performDummyWarrantyOrderLookupRoundTrip()`
 * is a `count()` — a read — standing in for an `INSERT`. Those are not the
 * same cost or the same lock/WAL shape at the Postgres level, and the match
 * branch also does a small extra amount of synchronous work the miss branch
 * does not (building the token, calling `resolveEmailPort()`, scheduling the
 * fire-and-forget promise) before either branch returns. This is a
 * deliberate, cheap narrowing of the two most obvious gaps — a skipped
 * network call and a skipped database write — not a claim that the two
 * response paths are timing-equalized. Node's event loop, connection
 * pooling, and GC pauses mean no server-side handler here promises anything
 * close to byte-identical wall-clock timing, and nothing below should be
 * read as asserting otherwise.
 *
 * ============================================================================
 * NO NEW SHOPIFY SCOPE
 * ============================================================================
 * See `warrantyOrderLookupAdapter.server.ts`'s own header for why the
 * logged-in flow works by looking up the number and checking ownership,
 * rather than listing "every order for this customer" (which is believed to
 * need `read_customers`, a scope this app does not hold — flagged for the
 * architect rather than silently requested, per CLAUDE.md rule 10 and the
 * assigning message).
 */

const guestRequestSchema = z.object({
  orderNumber: z.string().trim().min(1).max(50),
  purchaserEmail: z.string().trim().email().max(320).optional(),
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

// React Router calls `action` with exactly one argument (`ActionFunctionArgs`)
// — a second parameter is never populated at runtime, so dependency
// injection for tests uses the same module-level-setter convention as
// `orderLookupPortOverrideForTests` above, not a function parameter.
let resolveEmailPortOverrideForTests: (() => EmailPortResolution) | null = null;
export function __setResolveEmailPortForTests(resolver: (() => EmailPortResolution) | null): void {
  resolveEmailPortOverrideForTests = resolver;
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

/** `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`, or `null` for a guest — mirrors apps.carat.warranty-claim.tsx. */
function normalizeCustomerGid(rawId: string | null): string | null {
  if (!rawId) return null;
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

function buildVerificationUrl(env: ReturnType<typeof getEnv>, token: string): string {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  const path = env.WARRANTY_ORDER_VERIFY_PATH?.trim() || "/pages/warranty-claim-verify";
  const url = new URL(`https://${shopDomain}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Best-effort AUDIT EVENT for a verification-email dispatch outcome — never
 * thrown, same discipline as `luxuryStealOrderHandler.server.ts`'s
 * `recordLuxuryStealOrderAuditEvent`: an audit-write failure must never mask
 * or replace the real outcome, which the caller has already logged via
 * `logger` before calling this. Keyed on the verification row's own id
 * (`entityType: "warranty_order_lookup_verification"`), so
 * `listAuditEventsForEntity` is the one read that answers "did this
 * customer's verification email actually go out."
 */
async function recordVerificationEmailAuditEvent(input: {
  verificationId: string;
  action: string;
  after: Record<string, unknown>;
  reason?: string | null;
}): Promise<void> {
  try {
    await createAuditEvent({
      actorType: "system",
      actorRef: "apps.carat.warranty-order-lookup",
      action: input.action,
      entityType: "warranty_order_lookup_verification",
      entityId: input.verificationId,
      after: input.after,
      reason: input.reason ?? null,
    });
  } catch (auditError) {
    logger.error("warranty_order_lookup.verification_email_audit_event_failed", {
      verificationId: input.verificationId,
      attemptedAction: input.action,
      error: auditError instanceof Error ? auditError.name : "UnknownError",
    });
  }
}

/**
 * Fire-and-forget — see this file's module comment on why the send is never
 * awaited by the caller. Errors are caught and logged here so a rejected
 * promise never becomes an unhandled rejection.
 *
 * DURABLY RECORDED, NOT JUST LOGGED (team-lead review note). Not awaiting the
 * send is right for keeping the HTTP response's timing independent of it —
 * but a silent failure here would otherwise leave a customer waiting on a
 * link that never arrives, with nothing to diagnose. Every outcome
 * (unconfigured, sent, failed) writes one `audit_event` row via
 * `recordVerificationEmailAuditEvent`, mirroring
 * `luxuryStealOrderHandler.server.ts`'s `notifyLuxuryStealOrderHeld`.
 */
async function dispatchVerificationEmail(
  input: { verificationId: string; to: string; orderName: string; verificationUrl: string },
  resolveEmailPort: () => EmailPortResolution
): Promise<void> {
  const resolution = resolveEmailPort();
  if (!resolution.configured) {
    logger.error("warranty_order_lookup.verification_email_unconfigured", { reason: resolution.reason });
    await recordVerificationEmailAuditEvent({
      verificationId: input.verificationId,
      action: "warranty_order_lookup.verification_email_skipped_unconfigured",
      after: { emailDeliveryStatus: "skipped_unconfigured" },
      reason: resolution.reason,
    });
    return;
  }
  const { subject, text } = buildWarrantyOrderVerificationEmail({
    orderName: input.orderName,
    verificationUrl: input.verificationUrl,
  });
  try {
    const sent = await resolution.port.send({ from: resolution.from, to: [input.to], subject, text });
    logger.info("warranty_order_lookup.verification_email_sent", { providerMessageId: sent.providerMessageId });
    await recordVerificationEmailAuditEvent({
      verificationId: input.verificationId,
      action: "warranty_order_lookup.verification_email_sent",
      after: { emailDeliveryStatus: "sent", providerMessageId: sent.providerMessageId },
    });
  } catch (error) {
    // Name only, never the caught error's message — same discipline
    // `dispatchAdminAlert`/`luxuryStealOrderHandler.server.ts` follow.
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("warranty_order_lookup.verification_email_failed", { error: errorName });
    await recordVerificationEmailAuditEvent({
      verificationId: input.verificationId,
      action: "warranty_order_lookup.verification_email_failed",
      after: { emailDeliveryStatus: "failed" },
      reason: errorName,
    });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const resolveEmailPort = resolveEmailPortOverrideForTests ?? defaultResolveEmailPort;

  const url = new URL(request.url);
  const env = getEnv();
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, env.SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("warranty_order_lookup.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = guestRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the warranty order lookup request contract");
  }
  const body = parsed.data;
  const orderName = normalizeOrderNumberForSearch(body.orderNumber);
  const customerGid = normalizeCustomerGid(loggedInCustomerId);

  // Checked BEFORE any Shopify lookup: this is a pure shape requirement that
  // depends only on whether the caller is logged in, never on the order
  // number itself — so refusing it early cannot leak anything about any
  // particular order, and it saves a wasted Admin API round trip.
  if (!customerGid && !body.purchaserEmail) {
    return badRequest("purchaserEmail is required for a guest order lookup");
  }

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

  // -------------------------------------------------------------------------
  // LOGGED-IN FLOW — identity from the signed proxy value only. purchaserEmail
  // is never consulted here, even if the client sent one: trusting a
  // client-supplied email would let a logged-in customer assert someone
  // else's address to reach their order.
  // -------------------------------------------------------------------------
  if (customerGid) {
    if (lookupResult && lookupResult.customerGid === customerGid) {
      logger.info("warranty_order_lookup.logged_in_resolved", {});
      return noStoreJson({ resolved: true, order: toWarrantyOrderLookupResponseDto(lookupResult) }, 200);
    }
    // Same response whether the order does not exist, or exists but belongs
    // to someone else — see module comment.
    logger.info("warranty_order_lookup.logged_in_not_resolved", {});
    return noStoreJson({ resolved: false }, 200);
  }

  // -------------------------------------------------------------------------
  // GUEST FLOW — purchaserEmail's presence was already checked above: since
  // customerGid is falsy here (the logged-in branch already returned), the
  // earlier guard guarantees body.purchaserEmail is defined. TypeScript
  // cannot see across the two separate `if` blocks, hence the assertion.
  // -------------------------------------------------------------------------
  const guestEmail = body.purchaserEmail!;
  const matched = Boolean(lookupResult) && emailsMatch(lookupResult!.orderEmail, guestEmail);

  if (matched && lookupResult) {
    const { id: verificationId, token } = await createWarrantyOrderLookupVerification({
      orderRef: lookupResult.orderGid,
      orderName: lookupResult.orderName,
      purchaserEmail: guestEmail,
    });
    const verificationUrl = buildVerificationUrl(env, token);
    // Deliberately NOT awaited to completion beyond scheduling — see module
    // comment on why the email round trip must never affect response timing.
    // The outcome is still durably recorded — see dispatchVerificationEmail's
    // own comment.
    void dispatchVerificationEmail(
      { verificationId, to: guestEmail, orderName: lookupResult.orderName, verificationUrl },
      resolveEmailPort
    );
    logger.info("warranty_order_lookup.guest_verification_requested", {});
  } else {
    // See module comment — a same-shape Postgres round trip, no write.
    await performDummyWarrantyOrderLookupRoundTrip();
    logger.info("warranty_order_lookup.guest_lookup_no_match", {});
  }

  // IDENTICAL for match and no-match, by construction — see module comment.
  return noStoreJson({ status: "verification_requested" }, 200);
}
