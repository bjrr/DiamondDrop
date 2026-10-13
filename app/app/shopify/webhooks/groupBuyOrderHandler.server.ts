import { z } from "zod";

import { prisma } from "~/db/client.server";
import { getAcknowledgmentById } from "~/db/repositories/acknowledgmentRepository.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { recordGroupBuyOrderCancellationCheck } from "~/db/repositories/groupBuyOrderCancellationCheckRepository.server";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
import { buildGroupBuyCancellationHoldHandle } from "~/domain/groupbuy/cancellationHoldHandle";
import {
  verifyCancellationAcknowledgment,
  type CandidateCancellationAcknowledgment,
  type ExpectedCancellationAcknowledgmentContext,
} from "~/domain/groupbuy/cancellationOrderCheck";
import {
  CampaignNotOpenError,
  recordUnitEvent,
  VariantNotEligibleError,
} from "~/jobs/groupbuy/unitLedger.server";
import { ensureGroupBuyCampaignSyncedToCurrentTier } from "~/jobs/groupbuy/tierPriceSync.server";
import { resolveEmailPort as defaultResolveEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { logger } from "~/lib/logger.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { createProductionPriceSyncPort } from "~/shopify/admin/productionPriceSyncPort.server";
import {
  ShopifyLuxuryStealOrderReviewAdapter,
  type FulfillmentOrderSummary,
  type LuxuryStealOrderReviewPort,
} from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";

import { preserveShopifyBigIntIds } from "./luxuryStealOrderHandler.server";
import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * `orders/create` — Group Buy participation AND order-time cancellation
 * -acknowledgment verification (owner spec 2026-09-27/28,
 * docs/ARCHITECTURE-MVP1.md §6.2, README "Group Buy — Locked MVP1
 * Direction").
 *
 * ============================================================================
 * WHY THIS FILE WAS REWRITTEN, NOT MERELY EXTENDED
 * ============================================================================
 * The ORIGINAL version of this handler recorded a qualifying unit for every
 * Group Buy line unconditionally — no acknowledgment check existed at all.
 * That is a real gap AS COMMITTED: a direct `/cart/add` POST (bypassing the
 * storefront checkbox entirely) counted toward public campaign progress
 * exactly like a legitimate order. The owner's own words on why this had to
 * be fixed at THIS layer, not only at the storefront:
 *
 *   "The line-item acknowledgment ID is only a reference, not proof by
 *   itself." An id that resolves to a REAL `Acknowledgment` row is
 *   necessary but not sufficient — see
 *   `~/domain/groupbuy/cancellationOrderCheck.ts`'s own header comment for
 *   the full reasoning and the exact fields checked (customer, campaign,
 *   text, label, policy version).
 *
 * ============================================================================
 * THE CRITICAL ORDERING — VERIFY BEFORE COUNTING, NEVER AFTER
 * ============================================================================
 * THIS IS THE ONE RULE THAT MUST NEVER BE "TIDIED" BACK TO LUXURY STEALS'
 * SHAPE. Luxury Steals counts/ships an order regardless of verification and
 * uses the hold as the REMEDY — nothing ships unacknowledged, but the order
 * itself is not otherwise changed. Group Buy is different in one respect
 * that makes that shape actively dangerous here: public campaign progress
 * (`~/domain/groupbuy/qualifyingUnits.ts`) is MONOTONIC AND
 * NON-DECREMENTABLE BY DESIGN (locked policy, not an implementation detail).
 * A unit recorded from an UNVERIFIED line permanently inflates the count and
 * can unlock a tier for every legitimate participant — canceling or holding
 * the offending ORDER afterward does not undo it, because nothing in this
 * system ever subtracts a counted unit for that reason. The concrete attack
 * this closes: bypass the storefront, POST directly to `/cart/add` with a
 * missing or copied acknowledgment id, and artificially cross a tier
 * threshold that then applies to every other participant's price.
 *
 * So the sequence below is, for every Group Buy line/campaign pair:
 *   1. resolve the candidate acknowledgment the line's property names (if
 *      any) — a lookup key only, never trusted further than "look this up";
 *   2. VERIFY it (`verifyCancellationAcknowledgment`) against THIS order's
 *      own authenticated customer, THIS campaign, and the CURRENT required
 *      policy text/label/version;
 *   3. record the check EITHER WAY (evidence, not just a log line);
 *   4. record a qualifying unit ONLY when verification succeeded. A failed
 *      verification creates ZERO units for that line — never a delayed or
 *      compensating adjustment, because none is possible once counted.
 * Tag/hold reconciliation (order-wide, per the owner's own simplification —
 * see RECONCILIATION below) happens AFTER every line has been checked, using
 * what was actually recorded, never a shortcut computed ahead of it.
 *
 * ============================================================================
 * VERIFICATION IS PER (LINE, CAMPAIGN) — RECONCILIATION IS PER ORDER
 * ============================================================================
 * Owner: "because Group Buy items cannot share an order with Buy Now items,
 * holding the affected order is acceptable — so you do not need line-level
 * surgery." That simplification is about the REMEDY only. Verification
 * itself stays at the same grain as Luxury Steals (per line, since the
 * acknowledgment property travels per line item) — a legitimate,
 * fully-verified line's unit is still recorded even if ANOTHER line on the
 * SAME order fails verification; only the failing line is denied a unit.
 * The HOLD, however, is applied to every fulfilment order on the Shopify
 * order as a whole the moment ANY line fails — no attempt is made to hold
 * only the specific fulfilment order containing the bad line.
 *
 * ============================================================================
 * REUSING THE PROVEN D28 MACHINERY, NOT A SECOND HOLD/IDEMPOTENCY SYSTEM
 * ============================================================================
 * Tag/hold reconciliation reuses `LuxuryStealOrderReviewPort` and
 * `ShopifyLuxuryStealOrderReviewAdapter` VERBATIM (same mutations, same
 * `DUPLICATE_FULFILLMENT_HOLD_HANDLE` idempotency signal, same
 * applied/duplicate_handle/status_fallback recognition) — the only thing
 * this file supplies of its own is a DIFFERENT, namespaced hold `handle`
 * (`buildGroupBuyCancellationHoldHandle`, `~/domain/groupbuy/
 * cancellationHoldHandle.ts`) so a Group Buy hold is never mistaken for a
 * Luxury Steal one. See `holdFulfillmentOrder`'s own doc comment in that
 * adapter for why `handle` became a caller-supplied parameter.
 *
 * ============================================================================
 * CLIENT-SIDE GATING IS NOT ENFORCEMENT — THIS HANDLER IS
 * ============================================================================
 * The theme's checkbox/gate (task 5, `group-buy-cancellation-gate.js`) is a
 * UX affordance and an evidence-CAPTURE mechanism; it cannot refuse a direct
 * `/cart/add` POST that skips it entirely. THIS handler is what makes an
 * unacknowledged Group Buy order's participation impossible to count and its
 * fulfilment impossible to proceed unreviewed — the owner asked for that
 * distinction to be recorded in code, not only in chat, because a prior
 * mistake elsewhere in this codebase conflated the two.
 *
 * ============================================================================
 * IDEMPOTENCY — CHECK, TAG/HOLD, AND UNITS EACH CARRY THEIR OWN, INDEPENDENTLY
 * ============================================================================
 *   - The check: `@@unique([orderRef, lineRef, campaignRef])` on
 *     `group_buy_order_cancellation_check` (see that repository's own doc
 *     comment) — a redelivery reads back the SAME recorded outcome rather
 *     than re-deciding it.
 *   - Units: `recordUnitEvent`'s own pre-existing `(campaignId, externalRef)`
 *     uniqueness — untouched by this rewrite, still the sole authority on
 *     whether a given line has already contributed a unit.
 *   - Tag/hold: reconciled UNCONDITIONALLY on every delivery that touched at
 *     least one Group Buy line (same "always reconcile, never gate on
 *     `created`" reasoning as `luxuryStealOrderHandler.server.ts`'s own
 *     `reconcileShopifyOrderReviewState` — a delivery that wrote every check
 *     row but crashed before reaching Shopify must still retry the tag/hold
 *     on redelivery). `DUPLICATE_FULFILLMENT_HOLD_HANDLE` is what makes a
 *     REPEATED hold attempt a safe no-op rather than a duplicate.
 *
 * BIG-INT IDS, AGAIN — see `preserveShopifyBigIntIds`'s own doc comment
 * (shared with the Luxury Steal handler, a pure generic string rewrite).
 * `payload.customer.id` needs the SAME protection as every other Shopify
 * identifier here, which is exactly why `ID_LIKE_KEY_PATTERN`'s bare `"id"`
 * key match (not scoped to `line_items`) already covers it with no changes
 * to that shared function.
 */

// Re-exported under the handler's own short local name purely so the read
// site below stays readable. The VALUE now comes from the domain module, which
// is also what the two writing paths (storefront cart gate, Bank Payment
// draft order) import — see that constant's own comment for why a private
// copy here was the reason the Bank Payment path silently had no property at
// all.
const ACKNOWLEDGMENT_PROPERTY_NAME = GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const orderLinePropertySchema = z
  .object({
    name: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  })
  .passthrough();

const orderCustomerSchema = z
  .object({
    id: z.string().optional(),
    admin_graphql_api_id: z.string().optional(),
  })
  .passthrough();

const orderLineItemSchema = z
  .object({
    id: z.string(),
    admin_graphql_api_id: z.string().optional(),
    /** Absent/null for a custom (manual, non-catalog) line item — never Group Buy eligible, since it has no variant. */
    variant_id: z.string().nullable().optional(),
    /**
     * OPTIONAL, not required. A genuine Shopify order line always carries
     * `quantity`, but this schema must not let a malformed/legacy line (or,
     * concretely, a hand-built test fixture written for a DIFFERENT handler
     * on this same shared topic — see `luxuryStealOrderHandler.server.ts`'s
     * own raw-body builder, which never sets it) fail parsing for the WHOLE
     * payload. `receiveShopifyWebhook` runs both `orders/create` handlers
     * against the identical raw body in one delivery
     * (`webhooks.carat.orders-create.tsx`); a thrown `ZodError` here would
     * mark the entire delivery failed and block the Luxury Steal handler's
     * evidence-writing too, over a field this handler's own line-eligibility
     * check (see `handleGroupBuyOrderCreateWebhook`) already treats as "skip
     * this line" when absent.
     */
    quantity: z.number().int().nonnegative().optional(),
    properties: z.array(orderLinePropertySchema).optional(),
  })
  .passthrough();

const orderPayloadSchema = z
  .object({
    id: z.string().optional(),
    admin_graphql_api_id: z.string().optional(),
    /** When the order happened at Shopify — used as the ledger event's `occurredAt`, never "now". */
    created_at: z.string().optional(),
    /** The order's own Shopify customer, if any — null/absent for a guest checkout. THE authorization basis for verification; never a client-supplied field elsewhere in this payload. */
    customer: orderCustomerSchema.nullable().optional(),
    line_items: z.array(orderLineItemSchema).optional(),
  })
  .passthrough();

export type GroupBuyOrderPayload = z.infer<typeof orderPayloadSchema>;
export type GroupBuyOrderLineItem = z.infer<typeof orderLineItemSchema>;

/** PURE — no I/O. Same big-int-preserving re-parse `luxuryStealOrderHandler.server.ts` uses, against this handler's own (narrower) schema. */
export function parseGroupBuyOrderPayload(rawBody: string): GroupBuyOrderPayload {
  const doctored = preserveShopifyBigIntIds(rawBody);
  const json: unknown = JSON.parse(doctored);
  return orderPayloadSchema.parse(json);
}

/** PURE. */
export function extractGroupBuyOrderRef(payload: GroupBuyOrderPayload): string {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload.id) return `gid://shopify/Order/${payload.id}`;
  throw new Error("orders/create payload has neither admin_graphql_api_id nor id");
}

/** PURE. */
export function extractGroupBuyLineRef(line: GroupBuyOrderLineItem): string {
  if (line.admin_graphql_api_id) return line.admin_graphql_api_id;
  return `gid://shopify/LineItem/${line.id}`;
}

/** PURE. `null` for a custom/manual line item with no `variant_id` — cannot be Group Buy eligible. */
export function extractGroupBuyLineVariantGid(line: GroupBuyOrderLineItem): string | null {
  if (!line.variant_id) return null;
  return normalizeShopifyVariantGid(line.variant_id);
}

/**
 * PURE. The order's own AUTHENTICATED Shopify customer gid, or `null` for a
 * guest checkout (which, under docs/REQUIRED-CUSTOMER-ACCOUNTS.md, should
 * never legitimately happen for Group Buy — but this handler does not ASSUME
 * that; a `null` here simply means no candidate acknowledgment can ever
 * verify against it, which is the correct, fail-closed consequence, not a
 * special case this function needs to know about).
 */
export function extractGroupBuyOrderCustomerGid(payload: GroupBuyOrderPayload): string | null {
  const customer = payload.customer;
  if (!customer) return null;
  if (customer.admin_graphql_api_id) return customer.admin_graphql_api_id;
  if (customer.id) return `gid://shopify/Customer/${customer.id}`;
  return null;
}

/**
 * PURE. Finds the `_carat_gb_cancel_ack` line item property task 11's gate
 * attaches at add-to-cart time and returns its value as a trimmed string, or
 * `null` if absent/empty. Mirrors
 * `extractAcknowledgmentPropertyValue` in `luxuryStealOrderHandler.server.ts`
 * exactly, restated under this handler's own property name rather than
 * imported, since the two are independent evidence properties for
 * independent programs and must never be confused with one another.
 */
export function extractGroupBuyCancellationAcknowledgmentPropertyValue(line: GroupBuyOrderLineItem): string | null {
  const match = line.properties?.find((property) => property.name === ACKNOWLEDGMENT_PROPERTY_NAME);
  if (!match || match.value === null || match.value === undefined) return null;
  const value = String(match.value).trim();
  return value.length > 0 ? value : null;
}

/**
 * Resolves the line's acknowledgment property (if any) into a full
 * `CandidateCancellationAcknowledgment`, or `null` — never trusting the
 * property value further than "look this id up." A syntactically invalid
 * (non-UUID) value or one that resolves to no stored row both collapse to
 * `null`, which `verifyCancellationAcknowledgment` treats as `no_candidate`.
 */
async function resolveCandidateAcknowledgment(
  line: GroupBuyOrderLineItem
): Promise<CandidateCancellationAcknowledgment | null> {
  const ackId = extractGroupBuyCancellationAcknowledgmentPropertyValue(line);
  if (!ackId || !UUID_PATTERN.test(ackId)) return null;

  const acknowledgment = await getAcknowledgmentById(ackId);
  if (!acknowledgment) return null;

  return {
    id: acknowledgment.id,
    exactText: acknowledgment.exactText,
    affirmativeActionLabel: acknowledgment.affirmativeActionLabel,
    customerRef: acknowledgment.customerRef,
    campaignRef: acknowledgment.campaignRef,
    policyVersionSlug: acknowledgment.policyVersion.slug,
    policyVersionVersion: acknowledgment.policyVersion.version,
  };
}

/**
 * The CURRENT required context every candidate is checked against — built
 * from the order's own authenticated customer (never a client-supplied
 * field) and the pinned constants (never a database round trip: the
 * migration + `REQUIRED_POLICY_VERSIONS` registry guarantee these are what
 * is actually provisioned — see `cancellationAcknowledgmentText.ts`'s own
 * header comment).
 */
function buildExpectedContext(input: {
  orderCustomerGid: string | null;
  campaignCode: string;
}): ExpectedCancellationAcknowledgmentContext {
  return {
    // A sentinel that can never equal a real stored customerRef (which is
    // always a `gid://shopify/Customer/<id>` string) — a guest order (no
    // Shopify customer at all) can therefore never verify, without this
    // function needing a separate "no customer" branch of its own.
    customerRef: input.orderCustomerGid ?? "(no-shopify-customer-on-order)",
    campaignRef: input.campaignCode,
    requiredText: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
    requiredLabel: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
    requiredPolicySlug: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
    requiredPolicyVersion: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation — order-wide tag/hold, reusing the D28 machinery.
// ---------------------------------------------------------------------------

/** Applied to every Group Buy order once every checked line's acknowledgment verified — staff visibility only. */
const GROUP_BUY_VERIFIED_TAG = "Group Buy";
/** Applied instead when at least one line failed verification — staff-only wording, open to adjustment (not owner-pinned customer-facing copy). */
const GROUP_BUY_REVIEW_TAG = "Group Buy: Needs Review";

function buildGroupBuyHoldReasonNotes(orderRef: string, unmatchedLineRefs: readonly string[]): string {
  return (
    "CaratForUs: Group Buy cancellation-acknowledgment verification failed for line item(s) " +
    `${unmatchedLineRefs.join(", ")} on order ${orderRef}. Placed automatically by the orders/create ` +
    "verification webhook. This order's Group Buy line(s) were NOT counted toward campaign progress " +
    "(monotonic progress cannot be safely un-counted after the fact). Verify the customer's " +
    "acknowledgment before releasing this hold. Do not release automatically."
  );
}

async function recordGroupBuyOrderAuditEvent(input: {
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
      entityType: "group_buy_order",
      entityId: input.orderRef,
      after: input.after,
      reason: input.reason ?? null,
    });
  } catch (auditError) {
    logger.error("group_buy_order.audit_event_failed", {
      orderRef: input.orderRef,
      attemptedAction: input.action,
      error: auditError instanceof Error ? auditError.name : "UnknownError",
    });
  }
}

/**
 * Best-effort email, durably recorded either way — mirrors
 * `notifyLuxuryStealOrderHeld` exactly, restated (not imported — see this
 * file's own module comment on why the two handlers stay independent) under
 * this handler's own entity type.
 */
async function notifyGroupBuyOrderHeld(
  input: { orderRef: string; heldLines: readonly { lineRef: string; masterVariantId: string }[] },
  resolveEmailPort: () => EmailPortResolution
): Promise<void> {
  const resolution = resolveEmailPort();
  const lineRefs = input.heldLines.map((line) => line.lineRef);

  if (!resolution.configured) {
    logger.error("group_buy_order.alert_email_unconfigured", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      reason: resolution.reason,
    });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.alert_email_skipped_unconfigured",
      after: { heldLineCount: input.heldLines.length, lineRefs, emailDeliveryStatus: "skipped_unconfigured" },
      reason: resolution.reason,
    });
    return;
  }

  const lineSummary = input.heldLines
    .map((line) => `variant ${line.masterVariantId} (line ${line.lineRef})`)
    .join("; ");
  const subject = `Group Buy order held for review — ${input.orderRef}`;
  const text =
    `Order ${input.orderRef} has ${input.heldLines.length} Group Buy line item(s) with no verified ` +
    `cancellation acknowledgment: ${lineSummary}. This order has NOT been cancelled and its Group Buy ` +
    "line(s) were NOT counted toward campaign progress. Verify the customer's acknowledgment manually in " +
    "Shopify admin — the affected fulfillment order(s) are already on hold pending that review.";

  try {
    const sent = await resolution.port.send({ from: resolution.from, to: resolution.recipients, subject, text });
    logger.info("group_buy_order.alert_email_sent", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      providerMessageId: sent.providerMessageId,
    });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.alert_email_sent",
      after: {
        heldLineCount: input.heldLines.length,
        lineRefs,
        emailDeliveryStatus: "sent",
        providerMessageId: sent.providerMessageId,
      },
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("group_buy_order.alert_email_failed", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      error: errorName,
    });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.alert_email_failed",
      after: { heldLineCount: input.heldLines.length, lineRefs, emailDeliveryStatus: "failed" },
      reason: errorName,
    });
  }
}

/**
 * Reconciles the Shopify order's tag and (for a failed line) hold state —
 * mirrors `reconcileShopifyOrderReviewState` in
 * `luxuryStealOrderHandler.server.ts` (same "always reconcile, no `created`
 * gate" reasoning, same three-outcome hold recognition), restated under this
 * handler's own tag constants/reason copy/hold handle rather than shared,
 * because the two handlers must stay independently correct — a future change
 * to one must not silently change the other's staff-facing wording.
 */
async function reconcileGroupBuyOrderReviewState(
  input: {
    orderRef: string;
    heldLines: readonly { lineRef: string; masterVariantId: string }[];
    shopDomain: string | null;
  },
  resolveReviewPort: (shopDomain: string) => Promise<LuxuryStealOrderReviewPort>
): Promise<void> {
  if (!input.shopDomain) {
    throw new Error(
      `group_buy_order: cannot reconcile Shopify order ${input.orderRef} state — the webhook delivery carried no shop domain`
    );
  }

  const verified = input.heldLines.length === 0;
  const tag = verified ? GROUP_BUY_VERIFIED_TAG : GROUP_BUY_REVIEW_TAG;
  const failures: string[] = [];

  const port = await resolveReviewPort(input.shopDomain);

  try {
    await port.addOrderTags({ orderGid: input.orderRef, tags: [tag] });
    logger.info("group_buy_order.tag_applied", { orderRef: input.orderRef, tag, verified });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.tag_applied",
      after: { tag, verified },
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("group_buy_order.tag_failed", { orderRef: input.orderRef, tag, verified, error: errorName });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.tag_failed",
      after: { tag, verified },
      reason: errorName,
    });
    failures.push(`tag "${tag}"`);
  }

  if (verified) {
    if (failures.length > 0) {
      throw new Error(
        `group_buy_order: order ${input.orderRef} review-state reconciliation incomplete — failed: ${failures.join("; ")}`
      );
    }
    return;
  }

  const reasonNotes = buildGroupBuyHoldReasonNotes(
    input.orderRef,
    input.heldLines.map((line) => line.lineRef)
  );

  let fulfillmentOrders: FulfillmentOrderSummary[] = [];
  try {
    fulfillmentOrders = await port.listFulfillmentOrders(input.orderRef);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    logger.error("group_buy_order.fulfillment_orders_lookup_failed", { orderRef: input.orderRef, error: errorName });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.fulfillment_orders_lookup_failed",
      after: {},
      reason: errorName,
    });
    failures.push("fulfillment order lookup");
    fulfillmentOrders = [];
  }

  if (fulfillmentOrders.length === 0 && !failures.includes("fulfillment order lookup")) {
    logger.error("group_buy_order.no_fulfillment_orders_found", { orderRef: input.orderRef });
    await recordGroupBuyOrderAuditEvent({
      orderRef: input.orderRef,
      action: "group_buy_order.no_fulfillment_orders_found",
      after: {},
    });
    failures.push("no fulfillment orders found to hold");
  }

  for (const fulfillmentOrder of fulfillmentOrders) {
    if (fulfillmentOrder.status === "ON_HOLD") {
      await recordGroupBuyOrderAuditEvent({
        orderRef: input.orderRef,
        action: "group_buy_order.fulfillment_hold_already_in_place",
        after: { fulfillmentOrderGid: fulfillmentOrder.id, status: fulfillmentOrder.status },
      });
      continue;
    }

    try {
      const result = await port.holdFulfillmentOrder({
        fulfillmentOrderGid: fulfillmentOrder.id,
        reasonNotes,
        // Group Buy's OWN namespaced handle — never the Luxury Steal one —
        // see `buildGroupBuyCancellationHoldHandle`'s own doc comment.
        handle: buildGroupBuyCancellationHoldHandle(fulfillmentOrder.id),
      });
      const action =
        result.recognizedVia === "applied"
          ? "group_buy_order.fulfillment_hold_applied"
          : result.recognizedVia === "duplicate_handle"
            ? "group_buy_order.fulfillment_hold_already_applied"
            : "group_buy_order.fulfillment_hold_recognized_via_status";
      logger.info(action, {
        orderRef: input.orderRef,
        fulfillmentOrderGid: fulfillmentOrder.id,
        status: result.status,
        userErrorCodes: result.userErrorCodes,
      });
      await recordGroupBuyOrderAuditEvent({
        orderRef: input.orderRef,
        action,
        after: { fulfillmentOrderGid: fulfillmentOrder.id, status: result.status, userErrorCodes: result.userErrorCodes },
      });
    } catch (error) {
      const detail =
        error instanceof AdminApiError
          ? { name: error.name, message: error.message, problems: [...error.problems] }
          : error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "UnknownError", message: String(error) };

      logger.error("group_buy_order.fulfillment_hold_failed", {
        orderRef: input.orderRef,
        fulfillmentOrderGid: fulfillmentOrder.id,
        ...detail,
      });
      await recordGroupBuyOrderAuditEvent({
        orderRef: input.orderRef,
        action: "group_buy_order.fulfillment_hold_failed",
        after: { fulfillmentOrderGid: fulfillmentOrder.id, ...detail },
        reason: detail.message,
      });
      failures.push(`hold on fulfillment order ${fulfillmentOrder.id}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `group_buy_order: order ${input.orderRef} review-state reconciliation incomplete — failed: ${failures.join("; ")}`
    );
  }
}

async function defaultResolveReviewPort(shopDomain: string): Promise<LuxuryStealOrderReviewPort> {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  return new ShopifyLuxuryStealOrderReviewAdapter(admin);
}

export interface HandleGroupBuyOrderCreateWebhookDeps {
  /** Injected in tests. Production default lazily creates the real Admin API-backed port — see `createProductionPriceSyncPort`'s own doc comment for why that creation is deferred rather than imported eagerly. */
  resolveSyncPort?: () => Promise<ShopifyPriceSyncPort>;
  resolveReviewPort?: (shopDomain: string) => Promise<LuxuryStealOrderReviewPort>;
  resolveEmailPort?: () => EmailPortResolution;
}

/**
 * The handler `webhooks.carat.orders-create.tsx` wires to `receiveShopifyWebhook`
 * alongside the Luxury Steal handler. See this file's own module comment for
 * the full design — in short: for every Group Buy line, VERIFY its
 * cancellation acknowledgment BEFORE recording any qualifying unit, record
 * the check either way, count a unit only on success, and reconcile an
 * order-wide tag/hold once every line has been checked.
 */
export async function handleGroupBuyOrderCreateWebhook(
  event: ReceivedWebhookEvent,
  deps: HandleGroupBuyOrderCreateWebhookDeps = {}
): Promise<void> {
  const resolveSyncPort = deps.resolveSyncPort ?? createProductionPriceSyncPort;
  const resolveReviewPort = deps.resolveReviewPort ?? defaultResolveReviewPort;
  const resolveEmailPort = deps.resolveEmailPort ?? defaultResolveEmailPort;

  const payload = parseGroupBuyOrderPayload(event.rawBody);
  const orderRef = extractGroupBuyOrderRef(payload);
  const occurredAt = payload.created_at ? new Date(payload.created_at) : new Date();
  const orderCustomerGid = extractGroupBuyOrderCustomerGid(payload);

  const touchedCampaignIds = new Set<string>();
  const heldLines: { lineRef: string; masterVariantId: string }[] = [];
  const newlyHeldLines: { lineRef: string; masterVariantId: string }[] = [];
  let gbLineCheckedCount = 0;

  for (const line of payload.line_items ?? []) {
    const lineVariantGid = extractGroupBuyLineVariantGid(line);
    if (!lineVariantGid) continue; // custom/manual line item — no variant, cannot be Group Buy eligible
    // `quantity` is optional in the schema (see its own doc comment) —
    // absent or non-positive both mean "nothing purchased on this line".
    if (!line.quantity || line.quantity <= 0) continue;

    const lineRef = extractGroupBuyLineRef(line);

    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: lineVariantGid },
      select: { id: true },
    });
    if (!variant) {
      // A variant genuinely outside our catalogue — nothing to check it
      // against, and not necessarily a bug (same reasoning the Luxury Steal
      // handler and `inventoryPurchasabilityHandler.server.ts` already use).
      logger.warn("groupbuy_order.unresolved_variant", { orderRef, lineRef, variantGid: lineVariantGid });
      continue;
    }

    // Only OPEN campaigns. A variant that once belonged to a now-closed
    // campaign, or that was never added to any campaign, is simply not
    // Group Buy eligible for this order.
    const eligibleCampaigns = await prisma.groupBuyCampaignVariant.findMany({
      where: { masterVariantId: variant.id, campaign: { status: "open" } },
      select: { campaignId: true, campaign: { select: { code: true } } },
    });

    // Resolved ONCE per line — the SAME candidate is checked against every
    // campaign this line is eligible for (ordinarily exactly one; see this
    // file's own module comment for why more than one is possible in
    // principle and how the check table's own uniqueness handles it).
    const candidate = await resolveCandidateAcknowledgment(line);

    for (const { campaignId, campaign } of eligibleCampaigns) {
      gbLineCheckedCount += 1;

      const expected = buildExpectedContext({ orderCustomerGid, campaignCode: campaign.code });
      const verification = verifyCancellationAcknowledgment(candidate, expected);

      // STEP: record the check — EITHER WAY, and BEFORE any unit is ever
      // considered (evidence exists independent of what happens next).
      // `created` distinguishes a genuinely NEW finding from a redelivery
      // that already recorded this exact (order, line, campaign) outcome —
      // same idempotency idiom `luxuryStealOrderHandler.server.ts` uses to
      // decide whether to send a second alert email (it must not).
      const checkResult = await recordGroupBuyOrderCancellationCheck({
        orderRef,
        lineRef,
        campaignRef: campaign.code,
        masterVariantId: variant.id,
        matchedAcknowledgmentId: verification.matchedAcknowledgmentId,
        mismatchReason: verification.mismatchReason,
      });

      if (verification.outcome === "unmatched") {
        logger.error("groupbuy_order.cancellation_acknowledgment_unmatched", {
          orderRef,
          lineRef,
          campaignId,
          mismatchReason: verification.mismatchReason,
        });
        heldLines.push({ lineRef, masterVariantId: variant.id });
        if (checkResult.created) newlyHeldLines.push({ lineRef, masterVariantId: variant.id });
        // ZERO UNITS for this line — see this file's own module comment on
        // why this is the actual protection, not the hold below.
        continue;
      }

      // STEP: verification succeeded — ONLY NOW is a qualifying unit ever
      // considered for this line.
      try {
        await recordUnitEvent({
          campaignId,
          masterVariantId: variant.id,
          kind: "purchased",
          quantity: line.quantity,
          orderRef,
          lineRef,
          externalRef: lineRef,
          occurredAt,
          recordedBy: "system:shopify-webhook:orders/create",
        });
        touchedCampaignIds.add(campaignId);
      } catch (error) {
        if (error instanceof CampaignNotOpenError) {
          // Closed between our eligibility read above and this write — the
          // ledger correctly refuses new units for a campaign no longer
          // running. Not a bug, and not something a retry can fix.
          logger.warn("groupbuy_order.campaign_closed_before_record", { orderRef, lineRef, campaignId });
          continue;
        }
        if (error instanceof VariantNotEligibleError) {
          logger.warn("groupbuy_order.variant_no_longer_eligible", { orderRef, lineRef, campaignId });
          continue;
        }
        throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // RECONCILIATION — order-wide, unconditional, reusing D28's machinery. Runs
  // whenever at least one Group Buy line/campaign pair was checked, even if
  // every one of them verified (so the "Group Buy" verified tag is applied),
  // and NEVER skipped on redelivery — see this file's own module comment.
  // -------------------------------------------------------------------------
  if (newlyHeldLines.length > 0) {
    await notifyGroupBuyOrderHeld({ orderRef, heldLines: newlyHeldLines }, resolveEmailPort);
  }

  if (gbLineCheckedCount > 0) {
    // POSTGRES FIRST, SHOPIFY AFTER — every check row and every unit above is
    // already committed by this point, so a throw from here never loses or
    // duplicates evidence/units.
    await reconcileGroupBuyOrderReviewState({ orderRef, heldLines, shopDomain: event.shopDomain }, resolveReviewPort);
  }

  if (touchedCampaignIds.size === 0) return;

  const failures: string[] = [];
  for (const campaignId of touchedCampaignIds) {
    try {
      await ensureGroupBuyCampaignSyncedToCurrentTier(campaignId, { resolveSyncPort });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("groupbuy_order.tier_price_sync_failed", { orderRef, campaignId, error: message });
      failures.push(`campaign ${campaignId}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`groupbuy_order: tier price sync incomplete — ${failures.join("; ")}`);
  }
}
