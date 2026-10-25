import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  createRmaRequest,
  RmaInvalidRequestedRemedyError,
  RmaPastReturnWindowError,
  RmaRequiresClaimWorkflowError,
} from "~/db/repositories/rmaRepository.server";
import {
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG,
} from "~/domain/rma/acknowledgmentText";
import { requiresClaimWorkflow, RMA_REASON_CATEGORIES } from "~/domain/rma/eligibility";
import { RMA_REMEDY_KINDS } from "~/domain/rma/remedy";
import { calendarDaysSinceDelivery, classifyReturnWindow, RmaWindowError } from "~/domain/rma/window";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { RmaOrderLookupPort } from "~/shopify/admin/rmaOrderLookupAdapter.server";
import { ShopifyRmaOrderLookupAdapter } from "~/shopify/admin/rmaOrderLookupAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/rma-intake — the Buy Now RMA request intake endpoint
 * (Slice 4, docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md,
 * docs/REQUIRED-CUSTOMER-ACCOUNTS.md, docs/specs/SLICE-4-BUY-NOW-RMA.md
 * criteria 180-191, 198). Mirrors `apps.carat.warranty-claim.tsx` for the
 * conventions that still apply unchanged (App Proxy verification,
 * order/line resolution before any write, acknowledgment-gate-first,
 * closed-allowlist success response) this file does not re-explain — BUT
 * NOT for ownership checking, which this route's own module comment below
 * describes as a HARD requirement, unlike that route's lighter check.
 *
 * A RESOURCE ROUTE — no default export. `allowedActionOrigins` is
 * unconditionally `[]` in every production build, so a default-exported
 * route with an action here would 400 every legitimate storefront caller
 * before any validation runs (enforced mechanically by
 * `csrfResourceRouteFence.test.ts`).
 *
 * ============================================================================
 * ACKNOWLEDGMENT — OWNER-APPROVED 2026-09-26, WIRED IN
 * ============================================================================
 * `~/domain/rma/acknowledgmentText.ts` now pins the owner's own approved
 * text (previously it pinned only a slug — see that module's header history
 * for why inventing binding acknowledgment copy without approval would have
 * been exactly the kind of silent locked-policy decision CLAUDE.md forbids).
 * Migration `20260926040000_rma_return_policy_acknowledgment_version`
 * provisions the `policy_version` row (never `prisma/seed.ts` — see that
 * migration's own header), and the slug/version/text are registered in
 * `REQUIRED_POLICY_VERSIONS` (`~/domain/evidence/requiredPolicyVersions.ts`)
 * in the same change, so `/health` reports any environment missing it.
 *
 * The `503 acknowledgment_copy_pending_approval` branch below is KEPT as a
 * fail-closed guard (never deleted) for a misprovisioned environment where
 * that migration has not run — the same safety net
 * `apps.carat.warranty-claim.tsx` keeps for its own now-approved copy. A
 * structured `logger.error` call on that path is the right amount of
 * alerting for an expected-to-be-unreachable state; see git history on this
 * file for the fuller reasoning recorded while the copy was still pending.
 *
 * ============================================================================
 * REQUIRED CUSTOMER ACCOUNTS — docs/REQUIRED-CUSTOMER-ACCOUNTS.md (LOCKED,
 * approved 2026-09-26). READ THAT DOCUMENT IN FULL BEFORE CHANGING THIS ROUTE.
 * ============================================================================
 * RMA self-service now REQUIRES an authenticated Shopify customer identity.
 * There is NO GUEST PATH ANYWHERE IN THIS ROUTE:
 *   - Identity comes ONLY from the signed App Proxy `logged_in_customer_id`
 *     (Shopify's own signature — see `verifyAppProxySignature`), never from
 *     any client-supplied field. A request with no `logged_in_customer_id`
 *     is refused with `401 authentication_required` BEFORE the body is even
 *     parsed — an anonymous visitor cannot reach any further branch of this
 *     route, including the eligibility pre-checks.
 *   - Ownership of the resolved order is a HARD requirement, not the
 *     "light check" the sibling warranty-claim/luxury-acknowledgment routes
 *     use (those predate this locked decision and are each a separate
 *     agent's concurrent work — not touched here). `resolvedOrder.customerGid`
 *     must equal the authenticated identity exactly; a resolved order with
 *     no customer on file, or with a DIFFERENT customer, is refused with the
 *     SAME generic `order_or_line_unresolved` response as an order that does
 *     not exist at all — collapsing "doesn't exist," "isn't yours," and "has
 *     no customer on file" into one outcome, so this endpoint cannot be used
 *     to enumerate orders or learn anything about one that is not the
 *     caller's own (docs §5, §9 case 5).
 *   - `purchaserEmail` is NOT a client-supplied field. It is taken from the
 *     resolved order's own email (Shopify's record), never from anything the
 *     browser asserts — the doc's "never trust ... an email address ...
 *     supplied only by the browser" instruction, applied here even though
 *     this route uses it as a stored fact rather than a lookup key.
 *   - There was never a guest order-number-plus-email lookup or magic-link
 *     flow built for RMA in this codebase (unlike warranty's now-superseded
 *     D33 design) — so there is no dead guest-verification code to retire
 *     here. Nothing to remove; confirmed explicitly rather than assumed, per
 *     the assigning message.
 *   - A customer who cannot access the purchasing account is directed to
 *     Customer Care (docs §5, §9 case 9) — this route does not, and must
 *     never, offer a self-service bypass for that case.
 *
 * ============================================================================
 * TWO ELIGIBILITY CHECKS, DONE TWICE, ON PURPOSE
 * ============================================================================
 * This route calls the SAME pure functions
 * (`requiresClaimWorkflow`/`classifyReturnWindow`/`calendarDaysSinceDelivery`)
 * `~/db/repositories/rmaRepository.server.ts`'s `createRmaRequest` also
 * calls, BEFORE ever reaching the acknowledgment gate or a Shopify round
 * trip — purely so a customer who cannot use this workflow at all (day 31+,
 * or a reason that routes to the claim/warranty workflow) gets a specific,
 * actionable 422 without this route paying for an Admin API call or an
 * acknowledgment write it will just have to refuse anyway. The repository
 * enforces the SAME rules again, independently, immediately before writing
 * — this route's early check is a UX optimization, never the authority.
 * Personalization is deliberately NOT checked here — see
 * `rmaRepository.server.ts`'s header comment: criterion 183 defers that
 * check to approval, not creation.
 *
 * ============================================================================
 * CRITERION 181 — ORDER/LINE RESOLUTION, AND THE MERCHANDISE AMOUNT
 * ============================================================================
 * `orderRef`/`lineRef` are resolved against Shopify via `RmaOrderLookupPort`.
 * An unresolvable order or line is refused, unwritten (criterion 181).
 * Unlike the warranty lookup, this one also returns the line's own
 * merchandise-only (post-discount, pre-tax) amount — the ONLY source this
 * route uses for `eligibleMerchandiseAmountMinorUnits`; nothing here ever
 * accepts a merchandise amount as a bare client-supplied number.
 *
 * `hasProductSpecificReturnOverride` is not a field in this route's request
 * schema at all — see `rmaRepository.server.ts`'s header for why a customer
 * can never self-assert a return-eligibility override.
 */

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;
const LINE_ITEM_GID_PATTERN = /^gid:\/\/shopify\/LineItem\/\d+$/;

function normalizeOrderGid(raw: string): string {
  return raw.startsWith("gid://") ? raw : `gid://shopify/Order/${raw}`;
}
function normalizeLineItemGid(raw: string): string {
  return raw.startsWith("gid://") ? raw : `gid://shopify/LineItem/${raw}`;
}
function normalizeVariantGid(raw: string): string {
  return raw.startsWith("gid://") ? raw : `gid://shopify/ProductVariant/${raw}`;
}
/**
 * `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`.
 * UNLIKE the sibling warranty/luxury routes, this function's caller in
 * `action` below NEVER accepts a `null` result past the authentication gate
 * — see the REQUIRED CUSTOMER ACCOUNTS module comment. Kept as a function
 * (rather than inlined) only because the normalization logic itself
 * (bare id vs already-a-gid) is identical to those routes'.
 */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, reused
      // here (no RMA-specific gate copy has been separately approved) —
      // flagged in this task's handoff for explicit owner confirmation.
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const bodySchema = z
  .object({
    orderRef: z.string().min(1).max(200),
    lineRef: z.string().min(1).max(200),
    /** Optional — see this file's module comment on why variant resolution never gates request creation, mirroring the warranty route's own treatment. */
    shopifyVariantId: z.string().min(1).max(200).optional(),

    // NO purchaserEmail FIELD. See this file's REQUIRED CUSTOMER ACCOUNTS
    // module comment — the stored purchaser email comes from the resolved
    // order's own Shopify record, never from anything the browser asserts.
    itemConfigurationDescription: z.string().min(1).max(2000),

    carrierConfirmedDeliveryDate: dateOnly,

    reasonCategory: z.enum(RMA_REASON_CATEGORIES),
    reasonExplanation: z.string().min(1).max(5000),

    /** Required if and only if the server computes a `late` window — see this route's two-phase validation. Never trusted as sufficient by itself. */
    requestedRemedyKind: z.enum(RMA_REMEDY_KINDS).optional(),

    confirmsUnwornBeyondInspection: z.boolean(),
    confirmsUndamaged: z.boolean(),
    confirmsUnalteredAfterDelivery: z.boolean(),
    confirmsOriginalPackagingIncluded: z.boolean(),

    isPersonalizedOrAltered: z.boolean(),

    // The ONE required affirmative action (criterion 180). Must be the
    // LITERAL boolean `true` — never a default, never inferred from
    // absence, mirroring `claimAcknowledgmentAccepted` in the warranty route.
    returnPolicyAcknowledgmentAccepted: z.literal(true),
  })
  .strict();

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

// ---------------------------------------------------------------------------
// Order/line lookup port wiring — mirrors `apps.carat.warranty-claim.tsx`'s
// `createOrderLookupPort`/`__setWarrantyClaimOrderLookupPortForTests` exactly.
// ---------------------------------------------------------------------------

let orderLookupPortOverrideForTests: RmaOrderLookupPort | null = null;
export function __setRmaOrderLookupPortForTests(port: RmaOrderLookupPort | null): void {
  orderLookupPortOverrideForTests = port;
}

async function createOrderLookupPort(): Promise<RmaOrderLookupPort> {
  if (orderLookupPortOverrideForTests) return orderLookupPortOverrideForTests;

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is not configured; the RMA intake route cannot reach the Shopify Admin API.");
  }
  // Dynamic import for the same reason `apps.carat.warranty-claim.tsx` does
  // this — importing `~/shopify.server` at module scope would require
  // Shopify OAuth configured merely to LOAD this route file.
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);
  return new ShopifyRmaOrderLookupAdapter(admin);
}

// ---------------------------------------------------------------------------
// Acknowledgment — pinned, owner-approved copy. See this file's module
// comment. Records the policy_version's OWN `.text` (not the in-code
// constant directly) so the evidence row reflects whatever is actually
// provisioned in the database — mirrors `apps.carat.warranty-claim.tsx`'s
// `recordClaimAcknowledgment`. Returns `null` (never throws) if the
// migration has not run in this environment; the caller turns that into the
// fail-closed 503.
// ---------------------------------------------------------------------------

async function recordReturnPolicyAcknowledgment(input: {
  orderRef: string;
  customerRef: string;
  variantRef: string | null;
}): Promise<string | null> {
  const policyVersion = await getLatestPolicyVersion(RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!policyVersion) return null;

  const acknowledgment = await createAcknowledgment({
    exactText: policyVersion.text,
    policyVersionId: policyVersion.id,
    acknowledgedAt: new Date(),
    affirmativeActionLabel: RMA_RETURN_POLICY_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
    customerRef: input.customerRef,
    orderRef: input.orderRef,
    variantRef: input.variantRef ?? undefined,
  });
  return acknowledgment.id;
}

// ---------------------------------------------------------------------------
// Success response — CLOSED allow-list. A freshly created RMA is always
// `submitted`; nothing in this DTO could ever leak return-shipping
// instructions because none exist yet (criterion 199 — those fields are
// never set at creation).
// ---------------------------------------------------------------------------

function buildConfirmationDto(rma: {
  id: string;
  rmaReference: string;
  status: string;
  windowKind: string;
  requestedRemedyKind: string | null;
}) {
  return {
    rmaId: rma.id,
    rmaReference: rma.rmaReference,
    status: rma.status,
    windowKind: rma.windowKind,
    requestedRemedyKind: rma.requestedRemedyKind,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("rma_intake.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md — checked BEFORE the body is even
  // parsed. An anonymous visitor (no `logged_in_customer_id` in the signed
  // App Proxy params) gets refused here, unconditionally; there is no
  // downstream branch of this route an anonymous caller can reach.
  if (!loggedInCustomerId) {
    logger.warn("rma_intake.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerRef = normalizeCustomerGid(loggedInCustomerId);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the RMA intake request contract");
  }
  const body = parsed.data;

  const orderGid = normalizeOrderGid(body.orderRef);
  const lineGid = normalizeLineItemGid(body.lineRef);
  if (!ORDER_GID_PATTERN.test(orderGid) || !LINE_ITEM_GID_PATTERN.test(lineGid)) {
    return badRequest("orderRef/lineRef do not look like Shopify order/line-item identifiers");
  }

  // -------------------------------------------------------------------------
  // PHASE 1 — cheap, local, no I/O. See module comment: same pure functions
  // `createRmaRequest` will call again, right before writing.
  // -------------------------------------------------------------------------
  const requestedAt = new Date();
  let calendarDays: number;
  try {
    calendarDays = calendarDaysSinceDelivery(body.carrierConfirmedDeliveryDate, requestedAt);
  } catch (error) {
    if (error instanceof RmaWindowError) {
      return badRequest("carrierConfirmedDeliveryDate cannot be after the current request time");
    }
    throw error;
  }

  if (requiresClaimWorkflow(body.reasonCategory)) {
    logger.info("rma_intake.requires_claim_workflow", { reasonCategory: body.reasonCategory });
    return Response.json(
      { error: "requires_claim_workflow", reasonCategory: body.reasonCategory },
      { status: 422 }
    );
  }

  const windowClassification = classifyReturnWindow(calendarDays);
  if (windowClassification === "ineligible") {
    logger.info("rma_intake.past_return_window", { calendarDaysSinceDelivery: calendarDays });
    return Response.json({ error: "past_return_window", calendarDaysSinceDelivery: calendarDays }, { status: 422 });
  }
  if (windowClassification === "late" && !body.requestedRemedyKind) {
    return Response.json(
      { error: "remedy_choice_required", windowKind: "late", calendarDaysSinceDelivery: calendarDays },
      { status: 422 }
    );
  }
  if (windowClassification === "standard" && body.requestedRemedyKind) {
    return badRequest("requestedRemedyKind is not accepted in the standard (days 0-7) window");
  }

  // -------------------------------------------------------------------------
  // PHASE 2 — acknowledgment gate. `customerRef` was already established by
  // the authentication gate above, before the body was even parsed.
  // -------------------------------------------------------------------------
  const acknowledgmentId = await recordReturnPolicyAcknowledgment({
    orderRef: orderGid,
    customerRef,
    variantRef: body.shopifyVariantId ? normalizeVariantGid(body.shopifyVariantId) : null,
  });
  if (!acknowledgmentId) {
    logger.error("rma_intake.acknowledgment_copy_pending_approval", {});
    return Response.json({ error: "acknowledgment_copy_pending_approval" }, { status: 503 });
  }

  // -------------------------------------------------------------------------
  // PHASE 3 — criterion 181's order/line resolution + the authoritative
  // merchandise amount (criteria 189-191).
  // -------------------------------------------------------------------------
  let orderLookupPort: RmaOrderLookupPort;
  try {
    orderLookupPort = await createOrderLookupPort();
  } catch (error) {
    logger.error("rma_intake.order_lookup_port_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_unavailable" }, { status: 500 });
  }

  let resolvedOrder;
  try {
    resolvedOrder = await orderLookupPort.resolveOrderLine({ orderGid, lineItemGid: lineGid });
  } catch (error) {
    logger.error("rma_intake.order_lookup_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "order_lookup_failed" }, { status: 502 });
  }
  if (!resolvedOrder) {
    logger.warn("rma_intake.order_or_line_unresolved", {});
    return Response.json({ error: "order_or_line_unresolved" }, { status: 422 });
  }

  // HARD ownership requirement (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5, §9
  // case 5) — NOT the "light check" the pre-existing sibling routes use.
  // An order with no customer on file, or with a DIFFERENT customer, is
  // refused with the SAME generic response as an order that does not exist
  // at all, so this endpoint cannot be used to enumerate orders or learn
  // anything about one that is not the caller's own.
  if (resolvedOrder.customerGid !== customerRef) {
    logger.warn("rma_intake.order_customer_mismatch", {});
    return Response.json({ error: "order_or_line_unresolved" }, { status: 422 });
  }

  // The stored purchaser email is the ORDER's own email (Shopify's record),
  // never a client-supplied field — see this file's REQUIRED CUSTOMER
  // ACCOUNTS module comment. An order Shopify cannot supply an email for is
  // refused rather than guessed.
  if (!resolvedOrder.orderEmail) {
    logger.error("rma_intake.order_email_unavailable", {});
    return Response.json({ error: "order_email_unavailable" }, { status: 502 });
  }

  // MasterVariant resolution — best-effort, never gates creation (same as warranty).
  let masterVariantId: string | null = null;
  if (body.shopifyVariantId) {
    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: normalizeVariantGid(body.shopifyVariantId) },
      select: { id: true },
    });
    masterVariantId = variant?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // PHASE 4 — create. The repository re-derives and re-enforces every check
  // phase 1 already ran, independently (defense in depth, not trust).
  // -------------------------------------------------------------------------
  try {
    const rma = await createRmaRequest({
      orderRef: orderGid,
      lineRef: lineGid,
      customerRef,
      masterVariantId,
      itemConfigurationDescription: body.itemConfigurationDescription,
      purchaserEmail: resolvedOrder.orderEmail,
      carrierConfirmedDeliveryDate: body.carrierConfirmedDeliveryDate,
      requestedAt,
      reasonCategory: body.reasonCategory,
      reasonExplanation: body.reasonExplanation,
      requestedRemedyKind: body.requestedRemedyKind ?? null,
      confirmsUnwornBeyondInspection: body.confirmsUnwornBeyondInspection,
      confirmsUndamaged: body.confirmsUndamaged,
      confirmsUnalteredAfterDelivery: body.confirmsUnalteredAfterDelivery,
      confirmsOriginalPackagingIncluded: body.confirmsOriginalPackagingIncluded,
      isPersonalizedOrAltered: body.isPersonalizedOrAltered,
      returnPolicyAcknowledgmentId: acknowledgmentId,
      eligibleMerchandiseAmountMinorUnits: resolvedOrder.eligibleMerchandiseAmountMinorUnits,
      eligibleMerchandiseAmountCurrency: resolvedOrder.eligibleMerchandiseAmountCurrency,
      actor: { actorType: "customer", actorRef: customerRef, reason: "RMA requested via intake form" },
    });

    logger.info("rma_intake.submitted", { rmaId: rma.id });
    return Response.json(buildConfirmationDto(rma), { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    // These three are the exact refusals PHASE 1 already tried to pre-empt —
    // reaching them here means the world changed between phase 1 and now
    // (e.g. a slow request straddling a day boundary), not a bug. Still
    // reported with the same shape phase 1 would have used.
    if (error instanceof RmaRequiresClaimWorkflowError) {
      return Response.json({ error: "requires_claim_workflow", reasonCategory: error.reasonCategory }, { status: 422 });
    }
    if (error instanceof RmaPastReturnWindowError) {
      return Response.json(
        { error: "past_return_window", calendarDaysSinceDelivery: error.calendarDaysSinceDelivery },
        { status: 422 }
      );
    }
    if (error instanceof RmaInvalidRequestedRemedyError) {
      return Response.json({ error: "invalid_requested_remedy", reason: error.reason }, { status: 422 });
    }
    logger.error("rma_intake.create_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}
