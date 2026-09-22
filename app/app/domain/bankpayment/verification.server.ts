import type { BankPaymentMethod as PrismaBankPaymentMethod, Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { Money } from "~/domain/money/money";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { getVariantsAvailability } from "~/shopify/metafields/variantAvailability.server";
import type { DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

import { completeBankPaymentOrder } from "./completeOrder.server";
import {
  chargedUnitPriceMinorUnits,
  compareReceivedToExpected,
  computeExpectedTotal,
  type AmountComparison,
  type VerificationSubmission,
} from "./verification";

/**
 * Manual Bank Payment verification — the DATABASE/SHOPIFY-FACING half (owner
 * §23, spec §5.4/§14/§19, phase 2C-c criteria 87-91, 103-104, 112-124). Pure
 * decision logic (validation, the expected-total sum, the amount comparison,
 * the closed method enum, the D25 state classifier) lives in `verification.ts`
 * and is unit-tested there with no database; this file is the thin,
 * integration-tested layer that turns those decisions into committed rows,
 * audit evidence and a completed Shopify order.
 *
 * "VERIFYING ADMIN" IS THE AUTHENTICATED SHOPIFY STAFF IDENTITY (D23,
 * criteria 112-114) — not a typed name. `app/shopify.server.ts` requests an
 * ONLINE session in addition to the offline one (`useOnlineTokens: true`),
 * so an embedded admin request carries `session.onlineAccessInfo
 * .associated_user`. Every function below that records a verification takes
 * `verifiedByShopifyUserId`/`verifiedByEmail` as REQUIRED inputs resolved by
 * the caller from that session — never a form field, never defaulted.
 *
 * D24 (criteria 115-117) — A MISMATCHED AMOUNT REFUSES BEFORE ANYTHING IS
 * WRITTEN. `verifyAndCompleteBankPaymentOrder` compares the submission
 * against the order's expected total and throws `BankPaymentAmountMismatchError`
 * on any difference, writing only an audit event recording the refused
 * attempt — never the verification fields themselves. This replaced an
 * earlier design that recorded the verification and merely skipped
 * completion on a mismatch; the owner ruled that strands the order in
 * exactly the state D25 exists to recover, and makes a typo unrecoverable
 * through the idempotency guard.
 *
 * D25 (criteria 118-120) — COMPLETION CAN FAIL AFTER VERIFICATION IS
 * RECORDED, AND RECOVERY IS READ-BEFORE-WRITE. `completeVerifiedBankPaymentOrder`
 * is the ONE function in this app that may call `completeBankPaymentOrder`
 * (and therefore `draftOrderComplete`) — used both right after a fresh
 * verification and by the explicit "Retry completion" recovery action, so
 * there is exactly one path capable of creating a duplicate real order, and
 * it always asks Shopify first whether the draft already became one
 * (`draftOrder { order { id } }`) before ever attempting completion again.
 * 2C-a's live gate produced exactly the danger this guards against: order
 * #1001 exists on the dev store because `draftOrderComplete` succeeded while
 * the read of its result was denied by a missing scope, and nothing was
 * recorded.
 */

export class BankPaymentOrderNotFoundError extends Error {
  constructor(bankPaymentOrderId: string) {
    super(`bank payment order ${bankPaymentOrderId} does not exist`);
    this.name = "BankPaymentOrderNotFoundError";
  }
}

/**
 * Thrown only when an order was NEVER verified and is not `open` — a genuine
 * refusal (e.g. the guarantee sweep cancelled it between page load and
 * submit), never a duplicate. A duplicate submission of an ALREADY-verified
 * order takes the idempotent success path instead — see
 * `verifyAndCompleteBankPaymentOrder`.
 */
export class BankPaymentOrderNotOpenForVerificationError extends Error {
  constructor(bankPaymentOrderId: string, status: string) {
    super(`bank payment order ${bankPaymentOrderId} is ${status}; only an open order can be verified`);
    this.name = "BankPaymentOrderNotOpenForVerificationError";
  }
}

/**
 * D24, criteria 115-117. Thrown BEFORE anything is persisted — see this
 * module's header comment. Carries the full comparison so the route can show
 * both figures and the difference without recomputing anything.
 */
export class BankPaymentAmountMismatchError extends Error {
  constructor(
    readonly bankPaymentOrderId: string,
    readonly comparison: AmountComparison
  ) {
    super(
      `bank payment order ${bankPaymentOrderId}: amount received does not match amount expected; ` +
        "refused before recording anything (D24) — resolution is manual"
    );
    this.name = "BankPaymentAmountMismatchError";
  }
}

/** `"gold 14k, Comfort Fit 6.5-8"` — never null. Restated from `adminAlertEpisodes.server.ts`'s private, unexported helper of the same shape rather than imported, since that module is owned outside this task's file glob. */
function describeVariant(variant: { metal: string; purity: string; band: { label: string } | null }): string {
  const metalAndPurity = `${variant.metal} ${variant.purity}`;
  return variant.band ? `${metalAndPurity}, ${variant.band.label}` : metalAndPurity;
}

/** Human-readable "who" for an audit event's `actorRef` — the authenticated Shopify staff identity plus the shop, never a typed name (D23). */
function formatVerifierActorRef(input: { shop: string; verifiedByShopifyUserId: bigint; verifiedByEmail: string }): string {
  return `${input.verifiedByEmail} (Shopify user ${input.verifiedByShopifyUserId}) — ${input.shop}`;
}

export interface BankPaymentOrderLineView {
  readonly id: string;
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly quantity: number;
  readonly eligibleAtQuoteTime: boolean;
  readonly quotedBankPaymentPriceMinorUnits: bigint;
  readonly quotedRegularCardPriceMinorUnits: bigint;
  /** Bank price if `eligibleAtQuoteTime`, card price otherwise — what this line actually charges (owner §18). */
  readonly chargedUnitPriceMinorUnits: bigint;
  readonly currency: string;
}

export interface BankPaymentOrderDetail {
  readonly id: string;
  readonly status: "open" | "cancelled" | "completed";
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string | null;
  readonly quotedAt: Date;
  readonly guaranteeExpiresAt: Date;
  readonly verifiedAt: Date | null;
  readonly verifiedByShopifyUserId: bigint | null;
  readonly verifiedByEmail: string | null;
  readonly verifiedPaymentAmountMinorUnits: bigint | null;
  readonly verifiedPaymentCurrency: string | null;
  readonly verifiedPaymentMethod: PrismaBankPaymentMethod | null;
  readonly verifiedPaymentReference: string | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly lines: readonly BankPaymentOrderLineView[];
}

/** Never throws on a missing row — returns `null` so the route can render its own "not found" page instead of a crash. */
export async function loadBankPaymentOrderForVerification(id: string): Promise<BankPaymentOrderDetail | null> {
  const order = await prisma.bankPaymentOrder.findUnique({
    where: { id },
    include: {
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          masterVariant: {
            select: {
              id: true,
              metal: true,
              purity: true,
              shopifyVariantGid: true,
              band: { select: { label: true } },
              masterProduct: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!order) return null;

  return {
    id: order.id,
    status: order.status,
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    quotedAt: order.quotedAt,
    guaranteeExpiresAt: order.guaranteeExpiresAt,
    verifiedAt: order.verifiedAt,
    verifiedByShopifyUserId: order.verifiedByShopifyUserId,
    verifiedByEmail: order.verifiedByEmail,
    verifiedPaymentAmountMinorUnits: order.verifiedPaymentAmountMinorUnits,
    verifiedPaymentCurrency: order.verifiedPaymentCurrency,
    verifiedPaymentMethod: order.verifiedPaymentMethod,
    verifiedPaymentReference: order.verifiedPaymentReference,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    cancellationReason: order.cancellationReason,
    lines: order.lines.map((line) => ({
      id: line.id,
      masterVariantId: line.masterVariantId,
      shopifyVariantGid: line.masterVariant.shopifyVariantGid,
      productTitle: line.masterVariant.masterProduct.name,
      variantLabel: describeVariant(line.masterVariant),
      quantity: line.quantity,
      eligibleAtQuoteTime: line.eligibleAtQuoteTime,
      quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
      quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
      chargedUnitPriceMinorUnits: chargedUnitPriceMinorUnits(line),
      currency: line.currency,
    })),
  };
}

export interface LineAvailability {
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  /**
   * `null` means "could not be confirmed" (no gid on file, or Shopify's
   * answer omitted this id — a deleted product/variant) and is DELIBERATELY
   * distinct from `false`. Criterion 103 requires an honest re-query, not a
   * default; a caller must treat `null` with the same caution as `false`,
   * never as `true`.
   */
  readonly availableForSale: boolean | null;
}

/**
 * Criterion 103: re-queries EVERY line's current `availableForSale` from
 * Shopify, live, at verification time — never a cached or stale value.
 * Criterion 104: this result is for DISPLAY only. Nothing in this module (or
 * `verifyAndCompleteBankPaymentOrder` below) refuses verification because a
 * line reads unavailable.
 */
export async function checkLinesAvailability(
  admin: AdminGraphqlClient,
  lines: readonly { masterVariantId: string; shopifyVariantGid: string | null }[]
): Promise<LineAvailability[]> {
  const gids = lines
    .map((line) => line.shopifyVariantGid)
    .filter((gid): gid is string => gid !== null);

  const availability = gids.length > 0 ? await getVariantsAvailability(admin, gids) : new Map<string, boolean>();

  return lines.map((line) => ({
    masterVariantId: line.masterVariantId,
    shopifyVariantGid: line.shopifyVariantGid,
    availableForSale: line.shopifyVariantGid ? availability.get(line.shopifyVariantGid) ?? null : null,
  }));
}

export interface BankPaymentOrderSummary {
  readonly id: string;
  readonly status: "open" | "cancelled" | "completed";
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string | null;
  readonly quotedAt: Date;
  readonly guaranteeExpiresAt: Date;
  readonly verifiedAt: Date | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_RESULT_LIMIT = 50;

function toSummary(order: {
  id: string;
  status: "open" | "cancelled" | "completed";
  customerEmail: string;
  shopifyDraftOrderGid: string;
  shopifyOrderGid: string | null;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
  verifiedAt: Date | null;
}): BankPaymentOrderSummary {
  return {
    id: order.id,
    status: order.status,
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    quotedAt: order.quotedAt,
    guaranteeExpiresAt: order.guaranteeExpiresAt,
    verifiedAt: order.verifiedAt,
  };
}

/**
 * Locates a Bank Payment order (the assigning message's "authorised staff
 * must be able to locate a Bank Payment order"). A blank query lists every
 * currently OPEN order — the ones still needing a verification decision —
 * newest first. A non-blank query matches the customer email, the Shopify
 * draft-order gid, the Shopify order gid (once completed), or (only when it
 * parses as a UUID) this app's own order id — so a staff member can paste
 * whichever identifier they have to hand.
 */
export async function searchBankPaymentOrders(query: string): Promise<BankPaymentOrderSummary[]> {
  const trimmed = query.trim();

  if (trimmed === "") {
    const rows = await prisma.bankPaymentOrder.findMany({
      where: { status: "open" },
      orderBy: { quotedAt: "desc" },
      take: SEARCH_RESULT_LIMIT,
    });
    return rows.map(toSummary);
  }

  const orConditions: Prisma.BankPaymentOrderWhereInput[] = [
    { customerEmail: { contains: trimmed, mode: "insensitive" } },
    { shopifyDraftOrderGid: { contains: trimmed, mode: "insensitive" } },
    { shopifyOrderGid: { contains: trimmed, mode: "insensitive" } },
  ];
  if (UUID_PATTERN.test(trimmed)) {
    orConditions.push({ id: trimmed });
  }

  const rows = await prisma.bankPaymentOrder.findMany({
    where: { OR: orConditions },
    orderBy: { quotedAt: "desc" },
    take: SEARCH_RESULT_LIMIT,
  });
  return rows.map(toSummary);
}

export interface DraftOrderResultLookup {
  readonly orderGid: string;
  readonly orderName: string | null;
}

export class DraftOrderResultLookupError extends Error {
  constructor(draftOrderGid: string, cause: string) {
    super(`could not confirm whether draft order ${draftOrderGid} already became a Shopify order: ${cause}`);
    this.name = "DraftOrderResultLookupError";
  }
}

const DRAFT_ORDER_RESULT_QUERY = `#graphql
  query CaratDraftOrderResult($id: ID!) {
    draftOrder(id: $id) {
      id
      order { id name }
    }
  }
`;

interface DraftOrderResultEnvelope {
  data?: { draftOrder?: { id: string; order?: { id: string; name: string | null } | null } | null };
  errors?: { message: string }[];
}

/**
 * D25 / criterion 120 — THE READ THAT MAKES RETRY SAFE. `draftOrderComplete`
 * may have already succeeded at Shopify even though our own write of the
 * resulting order id failed. Retrying blind would call `draftOrderComplete`
 * a SECOND time and create a second real order against one payment. This
 * function is the read half of read-before-write: it asks Shopify directly
 * whether the draft already has a resulting order, so the caller can ADOPT
 * that id instead of completing again.
 *
 * A raw query living outside `app/shopify/admin/` (not this task's file
 * glob) — the same precedent `~/shopify/metafields/variantAvailability.server.ts`
 * already set for a read-only Shopify query owned by a different phase.
 *
 * Returns `null` both when Shopify confirms no resulting order exists yet
 * AND when the draft order itself cannot be found (e.g. deleted) — in
 * either case there is nothing to adopt, and the caller falls through to an
 * ordinary completion attempt.
 */
export async function resolveDraftOrderResultingOrder(
  admin: AdminGraphqlClient,
  draftOrderGid: string
): Promise<DraftOrderResultLookup | null> {
  const response = await admin.graphql(DRAFT_ORDER_RESULT_QUERY, { variables: { id: draftOrderGid } });
  const body = (await response.json()) as DraftOrderResultEnvelope;

  if (body.errors?.length) {
    throw new DraftOrderResultLookupError(draftOrderGid, body.errors.map((e) => e.message).join("; "));
  }

  const draftOrder = body.data?.draftOrder;
  if (!draftOrder || !draftOrder.order) return null;

  return { orderGid: draftOrder.order.id, orderName: draftOrder.order.name };
}

export interface CompleteVerifiedOrderInput {
  readonly bankPaymentOrderId: string;
  readonly shop: string;
  readonly admin: AdminGraphqlClient;
  readonly draftOrderPort: DraftOrderPort;
}

export type CompleteVerifiedOrderResult =
  | { readonly outcome: "completed"; readonly shopifyOrderGid: string; readonly orderName: string | null }
  | { readonly outcome: "completion_failed"; readonly error: string };

/**
 * Completes (or discovers-and-adopts) a VERIFIED order's Shopify order,
 * read-before-write per criterion 120. THE ONLY FUNCTION IN THIS APP THAT
 * MAY REACH `completeBankPaymentOrder` — used both by the automatic
 * completion attempt immediately after a fresh verification
 * (`verifyAndCompleteBankPaymentOrder` below) and by the explicit "Retry
 * completion" recovery action (criterion 119). One call site into
 * `draftOrderComplete`, and it always asks Shopify first.
 *
 * Never throws — a Shopify or database failure is caught and returned as
 * `{ outcome: "completion_failed" }` so the caller can leave the order in
 * its verified-but-not-completed state (D25) rather than crashing the
 * request. The failure is also written to the audit trail.
 */
export async function completeVerifiedBankPaymentOrder(
  input: CompleteVerifiedOrderInput
): Promise<CompleteVerifiedOrderResult> {
  const order = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: input.bankPaymentOrderId } });

  // Already recorded as completed — no read, no write, no second Shopify call.
  if (order.shopifyOrderGid) {
    return { outcome: "completed", shopifyOrderGid: order.shopifyOrderGid, orderName: null };
  }
  if (!order.verifiedAt) {
    return { outcome: "completion_failed", error: "order has not been verified; nothing to complete" };
  }

  try {
    const existing = await resolveDraftOrderResultingOrder(input.admin, order.shopifyDraftOrderGid);

    if (existing) {
      // ADOPT. Shopify already has the order — never call draftOrderComplete
      // again. Compare-and-set for the same reason completeOrder.server.ts
      // uses one for shopifyOrderGid: two callers racing this same recovery
      // must not both claim the write.
      const written = await prisma.bankPaymentOrder.updateMany({
        where: { id: order.id, shopifyOrderGid: null },
        data: { shopifyOrderGid: existing.orderGid, completedAt: new Date(), status: "completed" },
      });
      if (written.count === 1) {
        await createAuditEvent({
          actorType: "staff",
          actorRef: input.shop,
          action: "bank_payment_order.completion_adopted",
          entityType: "bank_payment_order",
          entityId: order.id,
          after: { shopifyOrderGid: existing.orderGid, orderName: existing.orderName },
          reason:
            "draftOrderComplete had already succeeded at Shopify before our earlier write of the order id " +
            "failed; adopted the existing Shopify order instead of completing again (criterion 120)",
        });
      }
      const current = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
      // current.shopifyOrderGid is guaranteed non-null here: either this call
      // just wrote it, or a racing call already did.
      return { outcome: "completed", shopifyOrderGid: current.shopifyOrderGid as string, orderName: existing.orderName };
    }

    // Shopify confirms no resulting order exists yet — safe to complete.
    const completed = await completeBankPaymentOrder({
      bankPaymentOrderId: order.id,
      port: input.draftOrderPort,
    });
    if (!completed.alreadyCompleted) {
      await createAuditEvent({
        actorType: "staff",
        actorRef: input.shop,
        action: "bank_payment_order.completed",
        entityType: "bank_payment_order",
        entityId: order.id,
        after: { shopifyOrderGid: completed.shopifyOrderGid, orderName: completed.orderName },
      });
    }
    return { outcome: "completed", shopifyOrderGid: completed.shopifyOrderGid, orderName: completed.orderName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await createAuditEvent({
      actorType: "staff",
      actorRef: input.shop,
      action: "bank_payment_order.completion_failed",
      entityType: "bank_payment_order",
      entityId: order.id,
      reason: message,
    });
    return { outcome: "completion_failed", error: message };
  }
}

export interface VerifyAndCompleteInput {
  readonly bankPaymentOrderId: string;
  readonly submission: VerificationSubmission;
  /** This app's single connected shop domain. */
  readonly shop: string;
  /** The AUTHENTICATED Shopify staff identity (D23) — resolved by the route from `session.onlineAccessInfo.associated_user`, never from a form field. */
  readonly verifiedByShopifyUserId: bigint;
  readonly verifiedByEmail: string;
  readonly admin: AdminGraphqlClient;
  readonly draftOrderPort: DraftOrderPort;
  /**
   * What the verifying admin was actually shown before confirming
   * (criterion 103) — carried through into the audit event as evidence of
   * what informed the decision, not re-queried a second time here. A blank
   * array is legitimate (an order whose lines all lack a Shopify variant
   * gid, or a genuinely empty availability check) and is recorded as such.
   */
  readonly availabilityShownToAdmin: readonly LineAvailability[];
  readonly now?: Date;
}

export type VerifyAndCompleteResult =
  | { readonly outcome: "completed"; readonly bankPaymentOrderId: string; readonly shopifyOrderGid: string; readonly orderName: string | null }
  | { readonly outcome: "completion_failed"; readonly bankPaymentOrderId: string; readonly completionError: string };

/**
 * The single entry point that turns a validated verification submission into
 * a committed row, its audit evidence, and a completed Shopify order.
 *
 * ORDER OF OPERATIONS MATTERS (D24 before the write, D25 after it):
 *
 *   1. If never verified: refuse outright if the order is not `open`.
 *   2. If never verified: compare the submitted amount against the expected
 *      total. A mismatch REFUSES — writes only an audit event, nothing else
 *      (criteria 115-117) — before any compare-and-set is attempted.
 *   3. If never verified: compare-and-set the verification fields, guarded
 *      on `verifiedAt IS NULL AND status = 'open'` (criterion 88's
 *      idempotency idiom, same as `completeOrder.server.ts`'s for
 *      `shopifyOrderGid`). "Somebody got there first" is a duplicate, not an
 *      error.
 *   4. If already verified (either before this call started, or a race lost
 *      just now): record the duplicate attempt and proceed — never write
 *      the verification fields twice.
 *   5. Attempt completion via `completeVerifiedBankPaymentOrder`, which
 *      NEVER throws. A completion failure here leaves the order in the
 *      verified-but-not-completed state (D25, criterion 118) and is
 *      returned as `{ outcome: "completion_failed" }` rather than thrown —
 *      the caller must not treat this as a request failure that undoes the
 *      verification, because nothing about the verification needs undoing.
 */
export async function verifyAndCompleteBankPaymentOrder(
  input: VerifyAndCompleteInput
): Promise<VerifyAndCompleteResult> {
  const now = input.now ?? new Date();
  const id = input.bankPaymentOrderId;

  const order = await prisma.bankPaymentOrder.findUnique({ where: { id }, include: { lines: true } });
  if (!order) throw new BankPaymentOrderNotFoundError(id);

  if (order.verifiedAt === null) {
    if (order.status !== "open") {
      throw new BankPaymentOrderNotOpenForVerificationError(id, order.status);
    }

    // D24, criteria 115-117 — compare BEFORE writing anything.
    const currency = order.lines[0]?.currency ?? input.submission.currency;
    const expected = computeExpectedTotal(order.lines, currency);
    const received = Money.fromMinorUnits(input.submission.amountReceivedMinorUnits, input.submission.currency);
    const comparison = compareReceivedToExpected(expected, received);
    if (comparison.currencyMismatch || !comparison.matchesExactly) {
      await createAuditEvent({
        actorType: "staff",
        actorRef: formatVerifierActorRef(input),
        action: "bank_payment_order.verify_amount_mismatch_refused",
        entityType: "bank_payment_order",
        entityId: id,
        after: {
          expectedMinorUnits: expected.amountMinorUnits.toString(),
          expectedCurrency: expected.currency,
          receivedMinorUnits: received.amountMinorUnits.toString(),
          receivedCurrency: received.currency,
          currencyMismatch: comparison.currencyMismatch,
          differenceMinorUnits: comparison.differenceMinorUnits?.toString() ?? null,
        },
        reason: "amount received did not match amount expected; refused before recording anything (D24)",
      });
      throw new BankPaymentAmountMismatchError(id, comparison);
    }

    const written = await prisma.bankPaymentOrder.updateMany({
      where: { id, verifiedAt: null, status: "open" },
      data: {
        verifiedPaymentAmountMinorUnits: input.submission.amountReceivedMinorUnits,
        verifiedPaymentCurrency: input.submission.currency,
        verifiedPaymentMethod: input.submission.method,
        verifiedPaymentReference: input.submission.reference,
        verifiedAt: now,
        verifiedByShopifyUserId: input.verifiedByShopifyUserId,
        verifiedByEmail: input.verifiedByEmail,
      },
    });

    if (written.count === 1) {
      await createAuditEvent({
        actorType: "staff",
        actorRef: formatVerifierActorRef(input),
        action: "bank_payment_order.verified",
        entityType: "bank_payment_order",
        entityId: id,
        after: {
          verifiedPaymentAmountMinorUnits: input.submission.amountReceivedMinorUnits.toString(),
          verifiedPaymentCurrency: input.submission.currency,
          verifiedPaymentMethod: input.submission.method,
          verifiedPaymentReference: input.submission.reference,
          verifiedAt: now.toISOString(),
          verifiedByShopifyUserId: input.verifiedByShopifyUserId.toString(),
          verifiedByEmail: input.verifiedByEmail,
          // Evidence of what the admin was shown BEFORE confirming (criterion
          // 103) — durable, not merely rendered-and-discarded.
          availabilityShownToAdmin: input.availabilityShownToAdmin.map((line) => ({
            masterVariantId: line.masterVariantId,
            shopifyVariantGid: line.shopifyVariantGid,
            availableForSale: line.availableForSale,
          })),
        },
      });
    } else {
      // Lost a genuine race — somebody else verified between our read and
      // our compare-and-set. Re-read; if STILL not verified, the order must
      // have left "open" in the interim (e.g. cancelled), which is a real
      // refusal, not a duplicate.
      const raced = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id } });
      if (raced.verifiedAt === null) {
        throw new BankPaymentOrderNotOpenForVerificationError(id, raced.status);
      }
      await createAuditEvent({
        actorType: "staff",
        actorRef: formatVerifierActorRef(input),
        action: "bank_payment_order.verify_duplicate_ignored",
        entityType: "bank_payment_order",
        entityId: id,
        reason: `already verified at ${raced.verifiedAt.toISOString()} by ${raced.verifiedByEmail ?? "unknown"} — this submission changed nothing`,
      });
    }
  } else {
    // Already verified before this call even started — a genuine duplicate
    // submission (double-click, browser resubmit). Never re-compares the
    // amount and never rewrites the verification fields.
    await createAuditEvent({
      actorType: "staff",
      actorRef: formatVerifierActorRef(input),
      action: "bank_payment_order.verify_duplicate_ignored",
      entityType: "bank_payment_order",
      entityId: id,
      reason: `already verified at ${order.verifiedAt.toISOString()} by ${order.verifiedByEmail ?? "unknown"} — this submission changed nothing`,
    });
  }

  const completion = await completeVerifiedBankPaymentOrder({
    bankPaymentOrderId: id,
    shop: input.shop,
    admin: input.admin,
    draftOrderPort: input.draftOrderPort,
  });

  if (completion.outcome === "completion_failed") {
    return { outcome: "completion_failed", bankPaymentOrderId: id, completionError: completion.error };
  }
  return {
    outcome: "completed",
    bankPaymentOrderId: id,
    shopifyOrderGid: completion.shopifyOrderGid,
    orderName: completion.orderName,
  };
}
