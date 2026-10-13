import { z } from "zod";

import { prisma } from "~/db/client.server";
import { getAcknowledgmentById } from "~/db/repositories/acknowledgmentRepository.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { isMasterVariantLuxurySteal, recordLuxuryStealOrderCheck } from "~/db/repositories/luxuryStealRepository.server";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import { resolveEmailPort as defaultResolveEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import { logger } from "~/lib/logger.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import {
  buildLuxuryStealHoldHandle,
  ShopifyLuxuryStealOrderReviewAdapter,
  type FulfillmentOrderSummary,
  type LuxuryStealOrderReviewPort,
} from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * `orders/create` verification — the enforcement that actually binds (D6,
 * criteria 137-140, docs/specs/SLICE-3-LUXURY-STEALS.md §4.4/§D28, task 3-4,
 * D28 owner ruling 2026-09-24). Verifies every Luxury Steal line, then puts
 * the Shopify order itself into a state staff can see and (for an unverified
 * line) that fulfillment cannot progress past: a tag always, and for an
 * unverified line, a real fulfillment hold.
 *
 * WHY THIS EXISTS AT ALL. D6 ships no Cart/Checkout Validation Function for
 * MVP1. Nothing inside Shopify's own checkout can refuse an un-acknowledged
 * Luxury Steal line, so a customer who POSTs directly to `/cart/add` reaches
 * checkout regardless of what the storefront gate (task 3-5) does. This
 * handler is therefore not a consistency check — it is the only thing that
 * can still catch a bypass, after the fact, before the order is fulfilled.
 * D28 closes the gap a QA review found in the ORIGINAL version of this file:
 * evidence plus a best-effort email is a DETECTIVE control only — nothing
 * stopped the order being picked and shipped if the email bounced and nobody
 * opened the held-orders page. A real fulfillment hold is a BINDING control.
 *
 * CRITERION 150 / 127 — POSTGRES ONLY. Every Luxury Steal determination below
 * goes through `isMasterVariantLuxurySteal`, task 3-1's direct read of
 * `master_variant.is_luxury_steal`. Nothing here reads a metafield, a tag, a
 * line item property, or any other client-supplied flag to decide whether a
 * line NEEDS verification — only to decide whether one PASSES it. (See
 * `app/domain/luxurysteals/metafieldEligibilityFence.test.ts`, which pins
 * this file to exactly that.)
 *
 * THE ACKNOWLEDGMENT PROPERTY IS A LOOKUP KEY, NOT PROOF. Task 3-5 attaches
 * the `Acknowledgment` id task 3-3's capture endpoint returned to the cart
 * line as a line item property named `_carat_ls_ack` (leading underscore —
 * Shopify hides `_`-prefixed properties from the customer-visible cart/
 * checkout/order confirmation while still persisting them on the order line).
 * That value is client-supplied and tamperable: a customer (or a bypassed
 * storefront) could copy ANY valid acknowledgment id from anywhere. So a
 * match requires two things, not one — (1) the id resolves to a real,
 * stored `Acknowledgment` row, AND (2) that row's own `variantRef` (the
 * Shopify variant gid it was captured against — see
 * `apps.carat.luxury-acknowledgment.tsx`) equals THIS line's variant. An id
 * that resolves to nothing, or resolves to a different variant's
 * acknowledgment, is `unmatched` — the tamper case task 3-4's assigning
 * message calls out as the one that matters most.
 *
 * 64-BIT IDS, AGAIN (R14/R17's hazard, at the order-line grain this time).
 * `line_items[].variant_id` and `.id` are Shopify's usual int64 identifiers.
 * `receive.server.ts` has already run `event.rawBody` through `JSON.parse`
 * once (to build `event.payload`) before this handler is ever called, which
 * proves the body is syntactically valid JSON — but that parse is exactly
 * as lossy for a >2^53 field as it always is, so `event.payload` is never
 * read here. Instead `preserveShopifyBigIntIds` rewrites the handful of
 * known id-bearing keys (`id`, `variant_id`, `product_id`, `order_id`) from
 * bare numeric JSON tokens to quoted strings BEFORE this module's own
 * `JSON.parse`, so every id downstream is a digit-for-digit-exact string
 * from the moment it exists as a JS value at all — never a `number` at any
 * point. This is the multi-field generalization of
 * `extractInventoryItemGidFromRawBody`'s single-field regex approach in
 * `inventoryPurchasabilityHandler.server.ts`; a whole `line_items` array of
 * objects cannot be pulled out of raw text with one targeted regex the way a
 * single scalar field can, so the rewrite runs across the whole body and the
 * result is parsed normally.
 *
 * D28 — WHAT THIS HANDLER NOW DOES, AND STILL DOES NOT DO. It never cancels
 * an order and never invents an automatic remedy for an unmatched line —
 * resolution is an explicit staff-review action (release the hold, refund,
 * or otherwise), never something this webhook decides on its own. Every
 * Luxury Steal order (verified or not) is tagged; an unverified one ALSO
 * gets a real fulfillment hold on every affected fulfillment order, via
 * `LuxuryStealOrderReviewPort` (`~/shopify/admin/
 * luxuryStealOrderReviewAdapter.server.ts` — READ THAT FILE'S DOC COMMENT
 * before touching the mutation shapes it sends; the core hold shape,
 * including the `handle` field and its `DUPLICATE_FULFILLMENT_HOLD_HANDLE`
 * idempotency code, is live-verified by introspection against
 * `caratforus-dev` as of 2026-09-24 — that adapter explains exactly what is
 * confirmed, what still is not, and why). D28 explicitly forbids writing to
 * `Order.note` (a single shared field a webhook retry could clobber);
 * `FulfillmentOrderHoldInput.reasonNotes` is this app's own field and carries
 * the staff-facing explanation instead — see `buildHoldReasonNotes`.
 *
 * TAG/HOLD IDEMPOTENCY IS DELIBERATELY NOT GATED ON `created` THE WAY THE
 * EMAIL ALERT IS. The email is gated on "at least one NEWLY created
 * unmatched row this delivery" specifically to avoid re-sending a human a
 * notification they already read. Tagging and holding carry no such spam
 * cost — `tagsAdd` is a no-op on a tag the order already has, and
 * `holdFulfillmentOrder` recognises a fulfillment order this app already
 * holds as success, primarily via Shopify's own typed
 * `DUPLICATE_FULFILLMENT_HOLD_HANDLE` code and secondarily via a `status`
 * re-check (see that adapter) — so this handler instead ALWAYS reconciles
 * Shopify's tag/hold state for the order whenever
 * it has at least one Luxury Steal line, on every delivery including a
 * redelivery. This is deliberately the MORE ROBUST choice, not merely the
 * simpler one: gating on `created` would mean a delivery that recorded every
 * check row successfully but then crashed before reaching Shopify would
 * NEVER retry the tag/hold on redelivery (every line would come back
 * `created: false`), which is exactly the "unheld unverified order" D28
 * exists to prevent. A handful of extra idempotent Admin API calls on a
 * redelivered event is the accepted cost of that safety property.
 *
 * TAG/HOLD FAILURES PROPAGATE (throw), UNLIKE THE EMAIL. The email failure
 * path is caught and never rethrown because retrying it cannot help (see
 * that function's own doc comment). The tag/hold path is the opposite: a
 * failure here CAN be fixed by a retry (see the paragraph above), and
 * "loudly visible" per the architect's assigning message means marking the
 * whole webhook delivery FAILED (`webhook_event.error`, a 5xx, Shopify's own
 * retry schedule) — not merely logging and moving on. Postgres work (the
 * evidence rows) always happens FIRST and commits independently, so a
 * later Shopify-side throw here never loses evidence already written.
 */

const ACKNOWLEDGMENT_PROPERTY_NAME = "_carat_ls_ack";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact set of Shopify order-webhook keys known to carry an int64 identifier as a bare JSON number. Deliberately narrow — see the module doc comment. */
const ID_LIKE_KEY_PATTERN = /"(id|variant_id|product_id|order_id|line_item_id)"(\s*):(\s*)(-?\d+)(?=[,}\s])/g;

/**
 * PURE — no I/O. Rewrites bare-numeric values of known id-bearing keys to
 * quoted strings, preserving JSON validity (quoting a number is always still
 * valid JSON) and exact digit sequence (never routes through a JS number).
 * Only matches a value that is NOT already quoted, so it cannot double-quote
 * a field Shopify already sends as a string (e.g. `admin_graphql_api_id`).
 */
export function preserveShopifyBigIntIds(rawBody: string): string {
  return rawBody.replace(ID_LIKE_KEY_PATTERN, (_match, key, sp1, sp2, digits) => `"${key}"${sp1}:${sp2}"${digits}"`);
}

const orderLinePropertySchema = z
  .object({
    name: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  })
  .passthrough();

const orderLineItemSchema = z
  .object({
    id: z.string(),
    admin_graphql_api_id: z.string().optional(),
    /** Absent/null for a custom (manual, non-catalog) line item — never a Luxury Steal, since it has no variant to check. */
    variant_id: z.string().nullable().optional(),
    properties: z.array(orderLinePropertySchema).optional(),
  })
  .passthrough();

const orderPayloadSchema = z
  .object({
    id: z.string().optional(),
    admin_graphql_api_id: z.string().optional(),
    line_items: z.array(orderLineItemSchema).optional(),
  })
  .passthrough();

export type OrderPayload = z.infer<typeof orderPayloadSchema>;
export type OrderLineItem = z.infer<typeof orderLineItemSchema>;

/**
 * PURE — no I/O. Re-derives the order payload from the RAW body, never from
 * `event.payload` (see module doc comment). Throws (SyntaxError from
 * `JSON.parse`, or `ZodError` from schema validation) on a body that does not
 * match Shopify's documented `orders/create` resource shape — deliberately
 * NOT swallowed, unlike an unresolved-but-well-formed identifier elsewhere in
 * this module. A genuinely malformed delivery from Shopify itself would be
 * abnormal on this topic; the exception propagates to `receiveShopifyWebhook`,
 * which records it on the `webhook_event` row and 500s for retry — an
 * existing, already-audited failure path, rather than a second one invented
 * here.
 */
export function parseOrderPayload(rawBody: string): OrderPayload {
  const doctored = preserveShopifyBigIntIds(rawBody);
  const json: unknown = JSON.parse(doctored);
  return orderPayloadSchema.parse(json);
}

/** PURE. Prefers the GID Shopify already sends; falls back to constructing one from the (now string-exact) legacy id. */
export function extractOrderRef(payload: OrderPayload): string {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload.id) return `gid://shopify/Order/${payload.id}`;
  throw new Error("orders/create payload has neither admin_graphql_api_id nor id");
}

/** PURE. Same preference order as `extractOrderRef`, at the line grain. */
export function extractLineRef(line: OrderLineItem): string {
  if (line.admin_graphql_api_id) return line.admin_graphql_api_id;
  return `gid://shopify/LineItem/${line.id}`;
}

/** PURE. `null` for a custom/manual line item with no `variant_id` — cannot be a Luxury Steal. */
export function extractLineVariantGid(line: OrderLineItem): string | null {
  if (!line.variant_id) return null;
  return normalizeShopifyVariantGid(line.variant_id);
}

/**
 * PURE. Finds the `_carat_ls_ack` line item property task 3-5 attaches at
 * add-to-cart time and returns its value as a trimmed string, or `null` if
 * absent/empty. Coerces a non-string property value (Shopify's cart API
 * ordinarily sends string properties, but the schema stays tolerant of a
 * number/boolean rather than throwing on an edge case) — this value is a
 * LOOKUP KEY only, never trusted further than "look this id up," so a
 * best-effort string coercion costs nothing in safety.
 */
export function extractAcknowledgmentPropertyValue(line: OrderLineItem): string | null {
  const match = line.properties?.find((property) => property.name === ACKNOWLEDGMENT_PROPERTY_NAME);
  if (!match || match.value === null || match.value === undefined) return null;
  const value = String(match.value).trim();
  return value.length > 0 ? value : null;
}

export interface LuxuryStealOrderLineResult {
  readonly lineRef: string;
  readonly masterVariantId: string;
  readonly outcome: "matched" | "unmatched";
  /** False when this (orderRef, lineRef) had already been recorded by a prior delivery — see `recordLuxuryStealOrderCheck`. */
  readonly created: boolean;
}

/**
 * Resolves the acknowledgment id a line's `_carat_ls_ack` property names (if
 * any) into a matched acknowledgment id, or `null`. Returns `null` for: no
 * property, a value that is not syntactically a UUID (never queried — the
 * column is `@db.Uuid`, and a malformed value can never be a real id), an id
 * that does not exist, and — THE TAMPER CASE — an id that exists but was
 * captured against a DIFFERENT variant than this order line's own.
 */
async function resolveMatchedAcknowledgmentId(
  line: OrderLineItem,
  lineVariantGid: string,
  context: { orderRef: string; lineRef: string }
): Promise<string | null> {
  const ackId = extractAcknowledgmentPropertyValue(line);
  if (!ackId || !UUID_PATTERN.test(ackId)) return null;

  const acknowledgment = await getAcknowledgmentById(ackId);
  if (!acknowledgment) return null;

  if (acknowledgment.variantRef !== lineVariantGid) {
    logger.warn("luxury_steal_order.acknowledgment_variant_mismatch", {
      orderRef: context.orderRef,
      lineRef: context.lineRef,
      acknowledgmentId: acknowledgment.id,
      acknowledgmentVariantRef: acknowledgment.variantRef,
      orderLineVariantGid: lineVariantGid,
    });
    return null;
  }

  return acknowledgment.id;
}

/**
 * The one write path to `audit_event` for everything this handler records
 * about the Shopify-facing side (email, tag, hold) — always
 * `entityType: "luxury_steal_order"`, `entityId: orderRef`, per the
 * architect's instruction, so `listAuditEventsForEntity("luxury_steal_order",
 * orderRef)` is the single read that answers "what happened for this order."
 *
 * DEFENSIVE BY DESIGN: caught and logged, never rethrown. An audit-write
 * failure must never mask or replace the REAL outcome it was trying to
 * record — the caller has already logged that outcome via `logger` before
 * calling this, and (for the tag/hold path) already decided independently
 * whether the underlying action itself succeeded, which is what drives retry
 * via `failures` in `reconcileShopifyOrderReviewState`. Letting THIS throw
 * too would just make one problem look like two.
 */
async function recordLuxuryStealOrderAuditEvent(input: {
  orderRef: string;
  action: string;
  after: Record<string, unknown>;
  reason?: string | null;
}): Promise<void> {
  try {
    await createAuditEvent({
      actorType: "system",
      actorRef: "shopify-webhook:orders/create",
      action: input.action,
      entityType: "luxury_steal_order",
      entityId: input.orderRef,
      after: input.after,
      reason: input.reason ?? null,
    });
  } catch (auditError) {
    logger.error("luxury_steal_order.audit_event_failed", {
      orderRef: input.orderRef,
      attemptedAction: input.action,
      error: auditError instanceof Error ? auditError.name : "UnknownError",
    });
  }
}

/**
 * Best-effort EMAIL, but a DURABLY RECORDED outcome, for a newly-discovered
 * hold. Deliberately not `dispatchAdminAlert`/`AdminAlertNotification` —
 * that table's `AdminAlertSourceKind` enum is schema-closed to the three
 * price-failure kinds, keyed on a single required `masterVariantId`, and
 * shaped around a recurring per-variant episode with open/suspend/resolve
 * transitions. A Luxury Steal order hold is order-grained (potentially
 * several variants) and one-shot (no reopen/resolve lifecycle), and adding a
 * 4th enum member would mean a `prisma/schema.prisma` migration this task's
 * scope does not include.
 *
 * `luxury_steal_order_check` (M12) cannot carry the notification outcome: it
 * is append-only, its columns already have fixed meanings (matched
 * acknowledgment id, outcome, checked-at), and the notification decision is
 * an ORDER-level aggregate made only after every line's row is already
 * written, so there is no row left to attach a delivery outcome to even if a
 * column existed. `AuditEvent` (`audit_event`, spec §0.5) already exists —
 * shipped, generic, append-only — and `verification.server.ts` /
 * `complianceHandlers.server.ts` already write to it for exactly this kind
 * of "an attempt happened and here is how it went" record. Every outcome
 * below (unconfigured / sent / failed) writes one `audit_event` row via
 * `recordLuxuryStealOrderAuditEvent`, so a bounced or unconfigured send is
 * durably visible and queryable even if the process crashes immediately
 * after.
 *
 * NEVER RETHROWN (unlike the tag/hold path below — see the module doc
 * comment for the deliberate asymmetry): the alert-dispatch gate only fires
 * for a NEWLY created unmatched check row, so a redelivery after this point
 * would never re-enter this function at all, and a retry that cannot help is
 * just noise.
 */
async function notifyLuxuryStealOrderHeld(
  input: { orderRef: string; heldLines: readonly { lineRef: string; masterVariantId: string }[] },
  resolveEmailPort: () => EmailPortResolution
): Promise<void> {
  const resolution = resolveEmailPort();
  const lineRefs = input.heldLines.map((line) => line.lineRef);

  if (!resolution.configured) {
    logger.error("luxury_steal_order.alert_email_unconfigured", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      reason: resolution.reason,
    });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.alert_email_skipped_unconfigured",
      after: { heldLineCount: input.heldLines.length, lineRefs, emailDeliveryStatus: "skipped_unconfigured" },
      reason: resolution.reason,
    });
    return;
  }

  const lineSummary = input.heldLines
    .map((line) => `variant ${line.masterVariantId} (line ${line.lineRef})`)
    .join("; ");
  const subject = `Luxury Steal order held for review — ${input.orderRef}`;
  const text =
    `Order ${input.orderRef} has ${input.heldLines.length} Luxury Steal line item(s) with no ` +
    `matching, variant-verified Final Sale acknowledgment: ${lineSummary}. ` +
    "This order has NOT been cancelled. Verify the customer's acknowledgment manually in Shopify " +
    "admin — the affected fulfillment order(s) are already on hold pending that review.";

  try {
    const sent = await resolution.port.send({ from: resolution.from, to: resolution.recipients, subject, text });
    logger.info("luxury_steal_order.alert_email_sent", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      providerMessageId: sent.providerMessageId,
    });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.alert_email_sent",
      after: {
        heldLineCount: input.heldLines.length,
        lineRefs,
        emailDeliveryStatus: "sent",
        providerMessageId: sent.providerMessageId,
      },
    });
  } catch (error) {
    // Name only, never the caught error's message — same discipline
    // `dispatchAdminAlert` follows (criterion 30).
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("luxury_steal_order.alert_email_failed", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      error: errorName,
    });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.alert_email_failed",
      after: { heldLineCount: input.heldLines.length, lineRefs, emailDeliveryStatus: "failed" },
      reason: errorName,
    });
  }
}

/** Applied to EVERY Luxury Steal order once every line's acknowledgment is verified — staff visibility only, per D28. */
const LUXURY_STEAL_VERIFIED_TAG = "Luxury Steal";
/** Applied instead of the tag above when at least one Luxury Steal line is unmatched — deliberately distinct wording so it reads as actionable, not merely informational. Not owner-pinned copy (unlike customer-facing acknowledgment/disclosure text): staff-only, open to adjustment. */
const LUXURY_STEAL_REVIEW_TAG = "Luxury Steal: Needs Review";

/**
 * The ONLY place the staff-facing explanation for a hold can go (D28: never
 * `Order.note`). Deliberately carries no cost, margin or other admin-only
 * pricing data — `reasonNotes` is visible to any Shopify admin user with
 * fulfillment-order access, not gated by this app's own access control.
 */
function buildHoldReasonNotes(orderRef: string, unmatchedLineRefs: readonly string[]): string {
  return (
    `CaratForUs: Luxury Steal Final Sale acknowledgment missing, invalid or does not match the ` +
    `purchased variant for line item(s) ${unmatchedLineRefs.join(", ")} on order ${orderRef}. ` +
    "Placed automatically by the orders/create verification webhook. Verify the customer's " +
    "acknowledgment (see the Luxury Steal held-orders admin page) before releasing this hold. " +
    "Do not release automatically."
  );
}

/**
 * Reconciles the Shopify order's tag and (for an unverified order) hold
 * state against what Postgres already knows — see the module doc comment
 * for why this always runs (no `created`-based gate) and why a failure here
 * propagates rather than being swallowed.
 *
 * Processes every affected fulfillment order even after one fails — "make
 * partial failure explicit rather than silent" (architect's own words) means
 * every fulfillment order gets its OWN audit event and its OWN chance to
 * succeed, and the aggregate throw at the end names every failure, not just
 * the first.
 */
async function reconcileShopifyOrderReviewState(
  input: {
    orderRef: string;
    heldLines: readonly { lineRef: string; masterVariantId: string }[];
    shopDomain: string | null;
  },
  resolveReviewPort: (shopDomain: string) => Promise<LuxuryStealOrderReviewPort>
): Promise<void> {
  if (!input.shopDomain) {
    // Should not happen for a real Shopify delivery (X-Shopify-Shop-Domain is
    // always present) — thrown, not swallowed, because silently skipping the
    // tag/hold here is exactly the "unheld unverified order" D28 exists to
    // prevent, and a thrown error is visible (webhook_event.error) and
    // retryable, unlike a silent no-op.
    throw new Error(
      `luxury_steal_order: cannot reconcile Shopify order ${input.orderRef} state — the webhook delivery carried no shop domain`
    );
  }

  const verified = input.heldLines.length === 0;
  const tag = verified ? LUXURY_STEAL_VERIFIED_TAG : LUXURY_STEAL_REVIEW_TAG;
  const failures: string[] = [];

  const port = await resolveReviewPort(input.shopDomain);

  try {
    await port.addOrderTags({ orderGid: input.orderRef, tags: [tag] });
    logger.info("luxury_steal_order.tag_applied", { orderRef: input.orderRef, tag, verified });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.tag_applied",
      after: { tag, verified },
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("luxury_steal_order.tag_failed", { orderRef: input.orderRef, tag, verified, error: errorName });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.tag_failed",
      after: { tag, verified },
      reason: errorName,
    });
    failures.push(`tag "${tag}"`);
  }

  if (verified) {
    // D28: "no fulfilment hold; normal fulfilment may continue." Nothing
    // further to do — in particular, this handler never RELEASES a hold; see
    // the module doc comment on why that stays an explicit staff action.
    if (failures.length > 0) {
      throw new Error(
        `luxury_steal_order: order ${input.orderRef} review-state reconciliation incomplete — failed: ${failures.join("; ")}`
      );
    }
    return;
  }

  const reasonNotes = buildHoldReasonNotes(
    input.orderRef,
    input.heldLines.map((line) => line.lineRef)
  );

  let fulfillmentOrders: FulfillmentOrderSummary[] = [];
  try {
    fulfillmentOrders = await port.listFulfillmentOrders(input.orderRef);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("luxury_steal_order.fulfillment_orders_lookup_failed", {
      orderRef: input.orderRef,
      error: errorName,
    });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.fulfillment_orders_lookup_failed",
      after: {},
      reason: errorName,
    });
    failures.push("fulfillment order lookup");
    fulfillmentOrders = [];
  }

  if (fulfillmentOrders.length === 0 && !failures.includes("fulfillment order lookup")) {
    // The lookup itself succeeded but returned nothing to hold — e.g. not
    // yet propagated at Shopify's end. An unverified order with NO held
    // fulfillment order is exactly the unsafe state D28 exists to close, so
    // this counts as a failure (visible, retried) rather than a quiet no-op.
    logger.error("luxury_steal_order.no_fulfillment_orders_found", { orderRef: input.orderRef });
    await recordLuxuryStealOrderAuditEvent({
      orderRef: input.orderRef,
      action: "luxury_steal_order.no_fulfillment_orders_found",
      after: {},
    });
    failures.push("no fulfillment orders found to hold");
  }

  for (const fulfillmentOrder of fulfillmentOrders) {
    if (fulfillmentOrder.status === "ON_HOLD") {
      // Cheap, obvious short-circuit — no call needed. Not treated as a
      // failure, an application, or a retry target.
      await recordLuxuryStealOrderAuditEvent({
        orderRef: input.orderRef,
        action: "luxury_steal_order.fulfillment_hold_already_in_place",
        after: { fulfillmentOrderGid: fulfillmentOrder.id, status: fulfillmentOrder.status },
      });
      continue;
    }

    try {
      const result = await port.holdFulfillmentOrder({
        fulfillmentOrderGid: fulfillmentOrder.id,
        reasonNotes,
        // Caller-supplied, now that `holdFulfillmentOrder` is reused by more
        // than one consumer (see that method's own doc comment) — this is
        // the SAME handle this file always sent, just no longer computed
        // inside the adapter.
        handle: buildLuxuryStealHoldHandle(fulfillmentOrder.id),
      });
      // Three distinct outcomes, per `HoldFulfillmentOrderResult`'s own doc
      // comment (live-verified 2026-09-24): "applied" is fresh,
      // "duplicate_handle" is Shopify's own typed confirmation that WE
      // already hold it (the precise, primary idempotency signal),
      // "status_fallback" is the weaker "something holds it" case a
      // recognised-but-different userError code (e.g.
      // FULFILLMENT_ORDER_HOLD_LIMIT_REACHED, TAKEN) falls back to.
      // `userErrorCodes` is ALWAYS included so neither of those two specific
      // codes is ever silently indistinguishable from an unrecognised one.
      const action =
        result.recognizedVia === "applied"
          ? "luxury_steal_order.fulfillment_hold_applied"
          : result.recognizedVia === "duplicate_handle"
            ? "luxury_steal_order.fulfillment_hold_already_applied"
            : "luxury_steal_order.fulfillment_hold_recognized_via_status";
      logger.info(action, {
        orderRef: input.orderRef,
        fulfillmentOrderGid: fulfillmentOrder.id,
        status: result.status,
        userErrorCodes: result.userErrorCodes,
      });
      await recordLuxuryStealOrderAuditEvent({
        orderRef: input.orderRef,
        action,
        after: { fulfillmentOrderGid: fulfillmentOrder.id, status: result.status, userErrorCodes: result.userErrorCodes },
      });
    } catch (error) {
      // WHY THE MESSAGE AND NOT JUST THE NAME.
      //
      // This previously recorded `error.name`, which for a plain `Error` is
      // the literal string "Error" — and that is exactly what the first live
      // gate produced: a hold that failed, correctly flagged as failed, with
      // no way to find out why. Investigating it took a direct Admin API
      // probe against the affected fulfilment order, which is not available
      // to staff looking at a held order weeks later.
      //
      // A failed hold is the single worst outcome in this handler: the order
      // is unverified AND unprotected. It is the last place where the reason
      // should be discarded. AdminApiError already formats Shopify's own
      // userErrors into its message and carries them individually on
      // `problems`, so both are recorded — nothing here is a secret, and
      // CLAUDE.md's logging rule excludes secrets and payment data, not
      // diagnostic detail.
      const detail =
        error instanceof AdminApiError
          ? { name: error.name, message: error.message, problems: [...error.problems] }
          : error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "UnknownError", message: String(error) };

      logger.error("luxury_steal_order.fulfillment_hold_failed", {
        orderRef: input.orderRef,
        fulfillmentOrderGid: fulfillmentOrder.id,
        ...detail,
      });
      await recordLuxuryStealOrderAuditEvent({
        orderRef: input.orderRef,
        action: "luxury_steal_order.fulfillment_hold_failed",
        after: { fulfillmentOrderGid: fulfillmentOrder.id, ...detail },
        reason: detail.message,
      });
      failures.push(`hold on fulfillment order ${fulfillmentOrder.id}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `luxury_steal_order: order ${input.orderRef} review-state reconciliation incomplete — failed: ${failures.join("; ")}`
    );
  }
}

async function defaultResolveReviewPort(shopDomain: string): Promise<LuxuryStealOrderReviewPort> {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  return new ShopifyLuxuryStealOrderReviewAdapter(admin as AdminGraphqlClient);
}

export interface HandleLuxuryStealOrderCreateWebhookDeps {
  resolveEmailPort?: () => EmailPortResolution;
  resolveReviewPort?: (shopDomain: string) => Promise<LuxuryStealOrderReviewPort>;
}

/**
 * The handler `webhooks.carat.orders-create.tsx` wires to `receiveShopifyWebhook`.
 * For every line: resolve whether its variant is (right now, in Postgres) a
 * Luxury Steal; if so, verify its acknowledgment and record the outcome
 * either way (criterion 140). Once every line is processed, the order's
 * Shopify-facing state is reconciled (D28): tagged always, and for any
 * unmatched line, held on every affected fulfillment order — never silently
 * fulfilled, never auto-cancelled (criterion 138), and never auto-released
 * (D28's explicit "do not invent an automatic remedy").
 *
 * IDEMPOTENT UNDER REDELIVERY (criterion 139) BY CONSTRUCTION, NOT BY A
 * SEPARATE CHECK, for the Postgres evidence: `recordLuxuryStealOrderCheck`
 * is race-safe per (orderRef, lineRef) and reports `created: false` for a
 * row that already existed. The EMAIL alert is additionally gated on at
 * least one NEWLY created unmatched row, so a pure redelivery sends no
 * second alert. The Shopify TAG/HOLD reconciliation is NOT gated the same
 * way — see its own function's doc comment for why always-reconcile is the
 * more robust choice for that specific action.
 *
 * A non-Luxury-Steal line, and a line whose variant this catalogue does not
 * recognise at all, produce NO evidence row and are otherwise untouched —
 * only Luxury Steal lines are ever checked (criterion 150 applied per line).
 * An order with no Luxury Steal line at all never reaches the tag/hold
 * reconciliation step (`lsLineCount` stays 0).
 */
export async function handleLuxuryStealOrderCreateWebhook(
  event: ReceivedWebhookEvent,
  deps: HandleLuxuryStealOrderCreateWebhookDeps = {}
): Promise<void> {
  const resolveEmailPort = deps.resolveEmailPort ?? defaultResolveEmailPort;
  const resolveReviewPort = deps.resolveReviewPort ?? defaultResolveReviewPort;

  const payload = parseOrderPayload(event.rawBody);
  const orderRef = extractOrderRef(payload);

  const heldLines: { lineRef: string; masterVariantId: string }[] = [];
  const newlyHeldLines: { lineRef: string; masterVariantId: string }[] = [];
  let lsLineCount = 0;

  for (const line of payload.line_items ?? []) {
    const lineVariantGid = extractLineVariantGid(line);
    if (!lineVariantGid) continue; // custom/manual line item — no variant, cannot be a Luxury Steal

    const lineRef = extractLineRef(line);

    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: lineVariantGid },
      select: { id: true },
    });
    if (!variant) {
      // Not necessarily a bug — same reasoning as
      // `inventoryPurchasabilityHandler.server.ts`'s unresolved-identifier
      // case: a variant genuinely outside our catalogue produces no evidence
      // row, because there is nothing in Postgres to check it against.
      logger.warn("luxury_steal_order.unresolved_variant", { orderRef, lineRef, variantGid: lineVariantGid });
      continue;
    }

    // CRITERION 150/127 — the only question asked of Postgres, never a
    // metafield or client-supplied flag.
    const isLuxurySteal = await isMasterVariantLuxurySteal(variant.id);
    if (!isLuxurySteal) continue; // an ordinary line — no evidence row, order untouched

    lsLineCount += 1;

    const matchedAcknowledgmentId = await resolveMatchedAcknowledgmentId(line, lineVariantGid, {
      orderRef,
      lineRef,
    });

    const result = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef: variant.id,
      matchedAcknowledgmentId,
    });

    if (result.outcome === "unmatched") {
      heldLines.push({ lineRef, masterVariantId: variant.id });
      if (result.created) newlyHeldLines.push({ lineRef, masterVariantId: variant.id });
    }
  }

  if (heldLines.length > 0) {
    logger.error("luxury_steal_order.held_for_review", {
      orderRef,
      heldLineCount: heldLines.length,
      lineRefs: heldLines.map((line) => line.lineRef),
    });
  }

  if (newlyHeldLines.length > 0) {
    await notifyLuxuryStealOrderHeld({ orderRef, heldLines }, resolveEmailPort);
  }

  if (lsLineCount > 0) {
    // POSTGRES FIRST, SHOPIFY AFTER (architect's instruction) — every check
    // row above is already committed by this point, so a throw from here
    // never loses evidence.
    await reconcileShopifyOrderReviewState({ orderRef, heldLines, shopDomain: event.shopDomain }, resolveReviewPort);
  }
}
