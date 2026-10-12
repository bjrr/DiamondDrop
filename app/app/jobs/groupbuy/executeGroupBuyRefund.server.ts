import type { GroupBuyRefund } from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  RefundNotApprovedError,
  RefundNotFoundError,
  beginRefundProcessing,
  markRefundFailed,
  markRefundIssued,
  releaseRefundForShipping,
} from "~/jobs/groupbuy/refundLedger.server";
import {
  executeIdempotent,
  IdempotentOperationFailedError,
  InDoubtIdempotencyError,
  type ClassifyIdempotentError,
} from "~/domain/idempotency";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import {
  GroupBuyRefundEchoMismatchError,
  GroupBuyRefundExecutionNotImplementedError,
  type GroupBuyRefundExecutionPort,
} from "~/shopify/admin/groupBuyRefundExecutionAdapter.server";
import { logger } from "~/lib/logger.server";

/**
 * `executeGroupBuyRefund` — the staff-triggered job that actually moves
 * money for a Group Buy tier-adjustment refund, once it has been approved
 * and released for shipping. Mirrors `app/jobs/rma/executeRmaRemedy.server.ts`
 * closely — same idempotency discipline (`§6.7`: a UNIQUE `idempotency_key`
 * row committed BEFORE the Shopify call, keyed on `${refund.id}:${refund.
 * updatedAt.toISOString()}`), same fail-closed error classification (only a
 * definitive `AdminApiError` may be recorded `failed`; everything else is
 * `in_doubt` and leaves the refund at `processing`, never `issued`, never
 * blindly retried).
 *
 * APPROVAL GATE, ENFORCED HERE AND AT THE DATABASE (see `refundLedger.
 * server.ts`'s `RefundNotApprovedError` and migration
 * `20260928020000_group_buy_refund_approval_gate`). This job's own check
 * exists only to fail fast with a typed error before any write — the
 * structural guarantee is `beginRefundProcessing`'s own check plus the
 * database CHECK constraint, neither of which this job can bypass.
 *
 * WHY THIS DOES NOT REUSE `RmaRemedyExecutionPort` (architect-flagged
 * question, see this module's own port file for the reasoning): a Group Buy
 * tier-adjustment refund returns NO merchandise and restocks NOTHING — the
 * customer keeps 100% of what they bought, and only the PRICE DIFFERENCE
 * moves. RMA's `createRefund` ties its refund to `refundLineItems` at the
 * line's full `refundableQuantity`, which is a MERCHANDISE-RETURN shape
 * (inventory/restock and "returned quantity" accounting) that would
 * misrepresent this transaction in Shopify. `groupBuyRefundExecutionAdapter.
 * server.ts`'s own header explains what would need to change instead
 * (an order-level monetary adjustment, not a line-item return) and why this
 * codebase does not yet call it live.
 */

export class GroupBuyRefundIllegalStateError extends Error {
  constructor(
    readonly refundId: string,
    readonly reason: string
  ) {
    super(`Group Buy refund ${refundId}: cannot execute — ${reason}`);
    this.name = "GroupBuyRefundIllegalStateError";
  }
}

/**
 * A definitive Shopify rejection (`AdminApiError`) proves the mutation did
 * not take effect — safe to classify `failed`. So does
 * `GroupBuyRefundExecutionNotImplementedError`: that path refuses BEFORE
 * making any network call, so there is no ambiguity about whether Shopify saw
 * the request — it definitely did not, which is a "failed", not an "in_doubt"
 * (an "in_doubt" would wrongly suggest a real attempt reached Shopify and the
 * outcome was merely lost). Anything else stays the safe default, `in_doubt`.
 *
 * ============================================================================
 * THE ECHO MISMATCH IS EXPLICITLY NOT RETRYABLE, AND THIS IS THE DOUBLE-REFUND
 * GUARD
 * ============================================================================
 * `GroupBuyRefundEchoMismatchError` is thrown only AFTER Shopify accepted the
 * refund — money has already moved. Classifying it `failed` would mark the
 * refund failed and make it eligible for a SECOND execution, refunding the
 * customer twice.
 *
 * It is not an `AdminApiError`, so the expression below already returns
 * `in_doubt` for it. The explicit branch exists anyway: the safety depends on
 * a type NOT being in a list, which is invisible to a reader and survives only
 * by accident if someone later makes the adapter throw `AdminApiError`
 * everywhere "for consistency". Named here, with the consequence written
 * down, that change has to argue with this comment first.
 */
const classifyGroupBuyRefundExecutionError: ClassifyIdempotentError = (error) => {
  if (error instanceof GroupBuyRefundEchoMismatchError) return "in_doubt";
  if (error instanceof AdminApiError) return "failed";
  if (error instanceof GroupBuyRefundExecutionNotImplementedError) return "failed";
  return "in_doubt";
};

export interface ExecuteGroupBuyRefundDeps {
  readonly port: GroupBuyRefundExecutionPort;
}

async function reload(refundId: string): Promise<GroupBuyRefund> {
  return prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refundId } });
}

/**
 * Walks an approved refund to `processing`, via the SAME transitions a fresh
 * attempt takes, and NEVER re-writes an already-`processing` row — doing so
 * would bump `updatedAt` and mint a different idempotency key than whatever
 * attempt is (or was) actually in flight, defeating crash recovery (identical
 * reasoning to `executeRmaRemedy`'s own guard). Shared by the automated path
 * below AND the manual "record what I did in Shopify Admin myself" fallback
 * (the campaign route's `record_refund_result` action) — both need to reach
 * `processing` before `markRefundIssued`/`markRefundFailed` accept a call,
 * and duplicating the walk would risk the two paths disagreeing about it.
 */
export async function advanceApprovedGroupBuyRefundToProcessing(
  refundId: string,
  actor: string
): Promise<GroupBuyRefund> {
  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: refundId } });
  if (!existing) throw new RefundNotFoundError(refundId);

  if (!existing.approvedAt) {
    // OWNER DECISION (Group Buy settlement approval gating) — see
    // refundLedger.server.ts's own RefundNotApprovedError comment.
    throw new RefundNotApprovedError(refundId);
  }
  if (!["releasable", "failed", "processing"].includes(existing.status)) {
    throw new GroupBuyRefundIllegalStateError(
      refundId,
      `status must be "releasable" or a retryable "failed" to begin processing (is "${existing.status}")`
    );
  }

  let refund = existing;
  if (refund.status === "failed") {
    await releaseRefundForShipping({ refundId, actor });
    refund = await reload(refundId);
  }
  if (refund.status === "releasable") {
    await beginRefundProcessing({ refundId, actor });
    refund = await reload(refundId);
  }
  return refund;
}

/**
 * Preconditions checked BEFORE any write or Shopify call: the refund must
 * exist, be approved, and be in a state a real attempt can start from
 * (`releasable`, a retryable `failed`, or already `processing` — a
 * crash-recovery resume, never re-transitioned).
 */
export async function executeGroupBuyRefund(
  refundId: string,
  actor: string,
  deps: ExecuteGroupBuyRefundDeps
): Promise<GroupBuyRefund> {
  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: refundId } });
  if (!existing) throw new RefundNotFoundError(refundId);

  if (existing.status === "issued") {
    return existing; // already settled — nothing to do, nothing to call.
  }

  const refund = await advanceApprovedGroupBuyRefundToProcessing(refundId, actor);

  const idempotencyKey = `groupbuy_refund_issue:${refund.id}:${refund.updatedAt.toISOString()}`;
  const payload = {
    refundId: refund.id,
    campaignId: refund.campaignId,
    lineRef: refund.lineRef,
    refundAmountMinorUnits: refund.refundAmountMinorUnits.toString(),
    currency: refund.currency,
  };

  try {
    const outcome = await executeIdempotent(
      idempotencyKeyRepository,
      idempotencyKey,
      "groupbuy_refund_issue",
      payload,
      () =>
        deps.port.createTierAdjustmentRefund({
          orderGid: refund.orderRef,
          lineItemGid: refund.lineRef,
          totalAmountMinorUnits: refund.refundAmountMinorUnits,
          currency: refund.currency,
          // THE SAME KEY, HANDED TO SHOPIFY. `refundCreate` requires
          // `@idempotent(key:)` as of API 2026-04, so the no-double-refund rule
          // is enforced by the payment system as well as by the row above.
          // Reusing this exact string is the point: the stability analysis in
          // `advanceApprovedGroupBuyRefundToProcessing`'s comment — stable
          // while an attempt is in flight, fresh only after a definitive
          // failure — is what makes Shopify's deduplication correct too.
          idempotencyKey,
        }),
      classifyGroupBuyRefundExecutionError
    );

    logger.info("groupbuy.refund_issued", { refundId: refund.id, campaignId: refund.campaignId });
    await markRefundIssued({ refundId: refund.id, actor, processorReference: outcome.reference });
    return reload(refundId);
  } catch (error) {
    if (error instanceof InDoubtIdempotencyError) {
      // Genuinely ambiguous — may have already succeeded at Shopify before
      // the response was lost. Leave the refund at `processing` (never
      // `failed`, never `issued`) for staff to resolve.
      logger.error("groupbuy.refund_in_doubt", { refundId: refund.id, idempotencyKey });
      throw error;
    }

    if (error instanceof IdempotentOperationFailedError) {
      // A REPEAT call found the key already resolved `failed` by an earlier,
      // definitive rejection. Reconcile the refund row to match, in case an
      // earlier attempt crashed between recordFailure and this write.
      logger.error("groupbuy.refund_execution_failed", { refundId: refund.id, message: error.message });
      await markRefundFailed({ refundId: refund.id, actor, failureReason: error.originalMessage ?? error.message });
      throw error;
    }

    // A fresh error from THIS attempt. Only reconcile to `failed` if the same
    // classifier `executeIdempotent` just used agrees this was a definitive
    // rejection — an "in_doubt" classification must leave the refund at
    // `processing`, exactly like the branch above, or a network timeout that
    // may have actually refunded the customer would be marked `failed` and
    // become eligible for a second, duplicate attempt.
    const message = error instanceof Error ? error.message : String(error);
    if (classifyGroupBuyRefundExecutionError(error) === "failed") {
      logger.error("groupbuy.refund_execution_failed", { refundId: refund.id, message });
      await markRefundFailed({ refundId: refund.id, actor, failureReason: message });
    } else {
      logger.error("groupbuy.refund_in_doubt", { refundId: refund.id, idempotencyKey, message });
    }
    throw error;
  }
}
