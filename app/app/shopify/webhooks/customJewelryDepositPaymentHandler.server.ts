import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import {
  CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG,
  CUSTOM_JEWELRY_DEPOSIT_PROJECT_TAG_PREFIX,
} from "~/domain/customjewelry/depositInvoice";
import { logger } from "~/lib/logger.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";

import { preserveShopifyBigIntIds } from "./luxuryStealOrderHandler.server";
import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * `orders/paid` — records that a Custom Jewelry Design Deposit was actually
 * paid, and only then advances the project to `deposit_charged`.
 *
 * ============================================================================
 * THE TAG IS A HINT. SHOPIFY IS THE AUTHORITY.
 * ============================================================================
 * The draft order was tagged `carat-design-deposit` plus
 * `carat-project-<reference>`, and the resulting order inherits those tags. So
 * the tags are how this handler knows a delivery is even worth looking at, and
 * how it finds the candidate project cheaply.
 *
 * THEY ARE NOT TRUSTED FOR THE MATCH. An order tag is editable by any Shopify
 * admin user, and matching money on an editable field is how the wrong deposit
 * gets marked paid. So once a candidate invoice is found, this handler asks
 * Shopify which order that invoice's DRAFT order actually became, and requires
 * it to be this order. Same discipline as every customer-ownership check in
 * this app: the client-supplied value locates the record, the server-side
 * lookup decides.
 *
 * ============================================================================
 * AND THE AMOUNT MUST MATCH, OR NOTHING IS RECORDED
 * ============================================================================
 * A draft order can be edited in the Shopify admin before the customer pays.
 * If the order's total is not the invoiced amount, this handler records NO
 * payment and does not advance the project — it logs at error and writes an
 * audit event instead. Design work must not begin because something that
 * resembled the deposit arrived; a human reconciles it.
 *
 * ============================================================================
 * WHICH FAILURES RETRY, AND WHICH DO NOT
 * ============================================================================
 * Shopify redelivers on a 5xx, so throwing is a request to be retried and must
 * be reserved for things a retry could fix:
 *
 *   THROWS (retryable)      the Shopify lookup failed — network, 5xx, a
 *                           transient Admin API error. The next delivery can
 *                           succeed.
 *   RETURNS (not ours)      no deposit tag. Not an error; most orders on this
 *                           store are Buy Now or Group Buy.
 *   RETURNS + LOGS (stuck)  tagged as a deposit but the project, invoice or
 *                           order verification does not line up, or the amount
 *                           differs. A retry cannot fix any of these — the
 *                           data is what it is — so looping Shopify forever
 *                           would turn one anomaly into permanent noise and
 *                           bury it. These are logged at error with an audit
 *                           event, which is what a human can actually act on.
 *
 * ============================================================================
 * IDEMPOTENT THREE TIMES OVER
 * ============================================================================
 * The receive layer dedupes by Shopify event id; the payment table is UNIQUE
 * on `invoice_id` AND on `order_gid`; and the status update is a write of a
 * fixed value rather than an increment. A redelivery therefore cannot produce
 * a second payment row, and a second order cannot mark a second invoice paid.
 */

/**
 * Only the fields this handler reads. Deliberately permissive about everything
 * else: `orders/paid` carries a very large payload and a strict schema over it
 * would reject deliveries over a field we do not use.
 */
const orderPaidPayloadSchema = z.object({
  admin_graphql_api_id: z.string().min(1),
  /** Shopify sends tags as a comma-separated string on the REST-shaped payload. */
  tags: z.string().optional().nullable(),
  current_total_price: z.string().optional().nullable(),
  total_price: z.string().optional().nullable(),
  currency: z.string().optional().nullable(),
  processed_at: z.string().optional().nullable(),
  created_at: z.string().optional().nullable(),
});

const DRAFT_ORDER_RESULTING_ORDER_QUERY = `#graphql
  query CaratDepositDraftOrderResultingOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      order { id }
    }
  }`;

export interface CustomJewelryDepositPaymentDeps {
  /**
   * RESOLVED LAZILY, and that is a correctness property rather than a
   * micro-optimisation.
   *
   * Almost every `orders/paid` delivery on this store is a Buy Now or Group
   * Buy order, not a deposit. An eagerly-built Admin client made each of those
   * depend on a session lookup they never needed — and a live test delivery
   * proved the consequence: the route returned 500 and asked Shopify to
   * redeliver, for an order the handler would have ignored anyway. A transient
   * session problem would have done the same to real customer orders.
   *
   * So the client is built ONLY after the tags say this is a deposit and an
   * invoice has been found — at which point a failure genuinely is worth
   * retrying.
   */
  readonly adminGraphql: () => Promise<AdminGraphqlClient>;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * The project reference carried in `carat-project-<reference>`.
 *
 * Returns null when absent or when more than one such tag is present: two
 * project tags on one order is ambiguous, and guessing which one is meant is
 * exactly the kind of inference that marks the wrong deposit paid.
 */
function projectReferenceFromTags(tags: readonly string[]): string | null {
  const prefix = CUSTOM_JEWELRY_DEPOSIT_PROJECT_TAG_PREFIX;
  const matches = tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length));
  if (matches.length !== 1) return null;
  const reference = matches[0]!.trim();
  return reference.length > 0 ? reference : null;
}

/**
 * Decimal major units to integer minor units, by string manipulation.
 *
 * Shopify sends the total as a decimal string. Parsing it as a float and
 * multiplying is the exact arithmetic this repo forbids for money, so the
 * fractional digits are padded or rejected textually instead. Returns null for
 * anything that is not a plain amount — including a value with more than two
 * decimal places, which is not a USD amount and should not be silently
 * truncated into one.
 */
function decimalStringToMinorUnits(raw: string): bigint | null {
  const cleaned = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return BigInt(whole! + fraction.padEnd(2, "0"));
}

export async function handleCustomJewelryDepositOrderPaidWebhook(
  event: ReceivedWebhookEvent,
  deps: CustomJewelryDepositPaymentDeps
): Promise<void> {
  // Shopify ids exceed Number.MAX_SAFE_INTEGER, so the raw JSON TEXT is
  // rewritten to quote them before it is parsed — `preserveShopifyBigIntIds`
  // returns a doctored STRING, not an object, and `JSON.parse` still has to
  // run on it. (Passing its result straight to a Zod object schema silently
  // fails every payload; the tests below caught exactly that.) Same two-step
  // as `parseOrderPayload` in `luxuryStealOrderHandler.server.ts`.
  let doctored: unknown;
  try {
    doctored = JSON.parse(preserveShopifyBigIntIds(event.rawBody));
  } catch {
    logger.error("custom_jewelry_deposit_payment.unparseable_body", { shopifyEventId: event.shopifyEventId });
    return;
  }
  const parsed = orderPaidPayloadSchema.safeParse(doctored);
  if (!parsed.success) {
    // A payload we cannot even read the order id from. Not retryable —
    // redelivering the same bytes produces the same result.
    logger.error("custom_jewelry_deposit_payment.unreadable_payload", { shopifyEventId: event.shopifyEventId });
    return;
  }
  const payload = parsed.data;
  const orderGid = payload.admin_graphql_api_id;

  const tags = parseTags(payload.tags);
  if (!tags.includes(CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG)) {
    // NOT OURS. Most orders on this store are Buy Now or Group Buy; this is
    // the common case and is silent on purpose.
    return;
  }

  const projectReference = projectReferenceFromTags(tags);
  if (!projectReference) {
    logger.error("custom_jewelry_deposit_payment.no_project_tag", { orderGid });
    await recordAnomaly(orderGid, "deposit-tagged order carries no single carat-project-<reference> tag");
    return;
  }

  const project = await prisma.customJewelryProject.findUnique({
    where: { projectReference },
    select: {
      id: true,
      status: true,
      depositAcceptance: {
        select: {
          id: true,
          invoice: {
            select: {
              id: true,
              draftOrderGid: true,
              amountMinorUnits: true,
              currency: true,
              payment: { select: { id: true } },
            },
          },
        },
      },
    },
  });

  const invoice = project?.depositAcceptance?.invoice;
  if (!project || !invoice) {
    logger.error("custom_jewelry_deposit_payment.no_invoice", { orderGid, projectReference });
    await recordAnomaly(orderGid, `no deposit invoice found for project ${projectReference}`);
    return;
  }

  if (invoice.payment) {
    // Already recorded — a redelivery, or a replay. Nothing to do and nothing
    // wrong.
    return;
  }

  // ---------------------------------------------------------------------------
  // THE AUTHORITATIVE CHECK. Ask Shopify which order this invoice's draft
  // order became, and require it to be this one.
  // ---------------------------------------------------------------------------
  // Built here, not at entry — see `CustomJewelryDepositPaymentDeps`. A
  // failure to obtain it now IS retryable: this really is a deposit order, so
  // we must not record a payment without verifying it, and a later delivery
  // may succeed.
  const adminGraphql = await deps.adminGraphql();
  const response = await adminGraphql.graphql(DRAFT_ORDER_RESULTING_ORDER_QUERY, {
    variables: { id: invoice.draftOrderGid },
  });
  const body = (await response.json()) as {
    data?: { draftOrder?: { id: string; order?: { id: string } | null } | null };
    errors?: unknown;
  };
  // EVERY Shopify Admin failure arrives on HTTP 200 — the body is what says
  // whether this worked.
  if (body.errors) {
    // Retryable: a transient Admin API failure, and the next delivery can
    // succeed. THROWN so Shopify redelivers.
    throw new Error(
      `could not resolve the draft order's resulting order for ${invoice.draftOrderGid}: ${JSON.stringify(body.errors)}`
    );
  }

  const resultingOrderGid = body.data?.draftOrder?.order?.id ?? null;
  if (resultingOrderGid !== orderGid) {
    // The tags said this order pays that invoice; Shopify disagrees. Record
    // nothing. Not retryable — the relationship is what it is.
    logger.error("custom_jewelry_deposit_payment.order_mismatch", {
      orderGid,
      projectReference,
      draftOrderGid: invoice.draftOrderGid,
    });
    await recordAnomaly(
      orderGid,
      `tags point at project ${projectReference}, but its invoice's draft order ${invoice.draftOrderGid} ` +
        `resolved to order ${resultingOrderGid ?? "none"}`
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // AND THE AMOUNT. A draft order can be edited before the customer pays.
  // ---------------------------------------------------------------------------
  const totalRaw = payload.current_total_price ?? payload.total_price ?? null;
  const observedMinorUnits = totalRaw ? decimalStringToMinorUnits(totalRaw) : null;
  const observedCurrency = payload.currency?.trim().toUpperCase() ?? null;

  if (
    observedMinorUnits === null ||
    observedCurrency === null ||
    observedMinorUnits !== invoice.amountMinorUnits ||
    observedCurrency !== invoice.currency
  ) {
    logger.error("custom_jewelry_deposit_payment.amount_mismatch", {
      orderGid,
      projectReference,
      observed: `${totalRaw ?? "none"} ${observedCurrency ?? ""}`,
    });
    await recordAnomaly(
      orderGid,
      `order total ${totalRaw ?? "unreadable"} ${observedCurrency ?? ""} does not match the invoiced ` +
        `${invoice.amountMinorUnits} ${invoice.currency} — no payment recorded and the project was not advanced`
    );
    return;
  }

  // Shopify's own timestamp, not our clock.
  const paidAtRaw = payload.processed_at ?? payload.created_at ?? null;
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;
  if (!paidAt || Number.isNaN(paidAt.getTime())) {
    logger.error("custom_jewelry_deposit_payment.unreadable_paid_at", { orderGid, projectReference });
    await recordAnomaly(orderGid, "order carried no readable processed_at/created_at timestamp");
    return;
  }

  // ONE TRANSACTION. The payment and the status it justifies are one fact; a
  // project showing `deposit_charged` with no payment row would assert a
  // receipt that does not exist, which is the whole thing this path guards.
  //
  // ============================================================================
  // THE STATUS ONLY EVER MOVES FORWARD
  // ============================================================================
  // The enum runs submitted -> deposit_charged -> awaiting_approval ->
  // approved -> purchased -> closed. Writing `deposit_charged` unconditionally
  // would drag a project BACKWARDS if it had already advanced — and that is
  // reachable the moment a staff action sets `awaiting_approval`, because a
  // delayed or redelivered `orders/paid` would arrive after it.
  //
  // So the update is CONDITIONAL on the project still being at `submitted`,
  // expressed in the WHERE clause rather than by reading the status first:
  // a read-then-write loses to a concurrent staff action, and the point is to
  // be correct under exactly that race.
  //
  // THE PAYMENT IS STILL RECORDED EITHER WAY. The money genuinely arrived; a
  // handler that refused to record it because the project had moved on would
  // lose the receipt, which is far worse than a status that needs a human to
  // look at. The two halves are not the same decision and are not treated as
  // one.
  let advanced: boolean;
  try {
    advanced = await prisma.$transaction(async (tx) => {
      await tx.customJewelryDepositPayment.create({
        data: {
          invoiceId: invoice.id,
          orderGid,
          // The OBSERVED figure, not the invoice's — see the table comment.
          amountMinorUnits: observedMinorUnits,
          currency: observedCurrency,
          paidAt,
        },
      });
      // `updateMany`, not `update`: a status that no longer matches must be
      // "nothing to do" rather than a thrown not-found that would roll the
      // payment back.
      const result = await tx.customJewelryProject.updateMany({
        where: { id: project.id, status: "submitted" },
        data: { status: "deposit_charged" },
      });
      return result.count === 1;
    });
  } catch (error) {
    // TWO CONCURRENT DELIVERIES OF THE SAME ORDER. The receive layer dedupes
    // by Shopify event id, and the `invoice.payment` check above catches a
    // sequential redelivery — but two deliveries in flight at once both pass
    // that check and both attempt the insert. The UNIQUE indexes on
    // `invoice_id` and `order_gid` are what actually decide it, and the loser
    // lands here.
    //
    // THAT IS NOT A FAILURE AND MUST NOT BE REPORTED AS ONE. Letting it
    // propagate returned 500 and asked Shopify to redeliver a payment that
    // was already recorded correctly by the winner — noise that looks like a
    // money-path error. The payment exists; there is nothing left to do.
    //
    // Deliberately NO anomaly event either: nothing anomalous happened, and
    // writing one would mean a routine race produced an entry a human has to
    // triage.
    if (isUniqueViolation(error)) {
      logger.info("custom_jewelry_deposit_payment.concurrent_duplicate", { orderGid, projectReference });
      return;
    }
    throw error;
  }

  if (!advanced) {
    // The deposit was paid for a project that had already moved past
    // `deposit_charged`. Not an error and not a reason to discard the receipt
    // — but a human should see it, because it means work advanced before the
    // money landed.
    logger.warn("custom_jewelry_deposit_payment.status_not_advanced", {
      orderGid,
      projectReference,
      status: project.status,
    });
    await recordAnomaly(
      orderGid,
      `payment recorded, but project ${projectReference} was already at status "${project.status}" rather than ` +
        `"submitted", so the status was left alone rather than moved backwards`
    );
  }

  logger.info("custom_jewelry_deposit_payment.recorded", { orderGid, projectReference, statusAdvanced: advanced });
}

/**
 * An anomaly a human needs to look at, written where staff can find it.
 *
 * Never throws into the caller: a failure to record the audit note must not
 * turn a non-retryable anomaly into a retried delivery, which would hide the
 * anomaly behind redelivery noise.
 */
async function recordAnomaly(orderGid: string, detail: string): Promise<void> {
  try {
    await createAuditEvent({
      entityType: "custom_jewelry_deposit_payment",
      // Keyed on the ORDER, not the project: when the anomaly is that we
      // cannot tell which project this order belongs to, the order is the
      // only identifier that is certainly correct.
      entityId: orderGid,
      action: "anomaly",
      actorType: "system",
      actorRef: "webhook:orders-paid",
      reason: detail,
    });
  } catch (error) {
    logger.error("custom_jewelry_deposit_payment.audit_write_failed", {
      orderGid,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Prisma's unique-constraint code, matched structurally rather than on the
 * message text, which is not a stable contract.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
