import {
  executeIdempotent,
  IdempotentOperationFailedError,
  InDoubtIdempotencyError,
  type ClassifyIdempotentError,
} from "~/domain/idempotency";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import {
  getRmaRequestForStaffReview,
  updateRmaRemedyStatus,
  RmaRemedyNotFoundError,
  RmaRequestNotFoundError,
  type RmaStaffView,
} from "~/db/repositories/rmaRepository.server";
import { Money } from "~/domain/money/money";
import { logger } from "~/lib/logger.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import type { RmaRemedyExecutionPort } from "~/shopify/admin/rmaRemedyExecutionAdapter.server";

/**
 * `executeRmaRemedy` — the staff-triggered job that actually moves money for
 * a Buy Now RMA remedy: Shopify Store Credit (merchandise credit) or a
 * refund to the original payment method (docs/ARCHITECTURE-MVP1.md D5/D7/D10,
 * `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §4, `docs/specs/
 * SLICE-4-BUY-NOW-RMA.md` criteria 192-197, 204). Called from
 * `app.rma.$id.tsx`'s `execute_remedy` action.
 *
 * WHAT THIS FILE OWNS THAT THE DOMAIN (`app/domain/rma/**`) DELIBERATELY DOES
 * NOT: the D7 tax-preservation decision and the Shopify-calling side of
 * remedy issuance. `app/domain/rma/remedy.ts`'s own header explains why that
 * boundary exists (the tax-boundary fence over `app/domain/rma/**` would fail
 * this file — correctly, since this file's whole job is to ask Shopify for a
 * tax figure and preserve it). This module is intentionally OUTSIDE that
 * fenced directory.
 *
 * ============================================================================
 * THE ONE MONEY-CRITICAL JUDGEMENT CALL IN THIS FILE — flag for architect
 * review before this executes against a live store.
 * ============================================================================
 * D7: "if Shopify cannot represent a case while keeping tax records
 * internally consistent, do not manufacture a tax result — route to staff
 * review." This file reads that instruction as covering the late-window
 * 50%-restocking-fee refund UNCONDITIONALLY, for a concrete reason: Shopify's
 * refund tooling (`suggestedRefund`/`refundCreate`) computes tax proportional
 * to a LINE ITEM'S OWN QUANTITY/PRICE, not to an arbitrary fractional dollar
 * amount CaratForUs decided after the fact. There is no Shopify input that
 * means "give me the tax on half this item's value" — the only way to
 * produce that number would be for this codebase to derive a proportional
 * tax figure itself, which D7 exists specifically to forbid. So EVERY
 * `restockingFeeMinorUnits > 0` remedy routes straight to
 * `staff_review_required`, with no Shopify call attempted at all, every
 * time — deterministic, not a transient failure. Staff resolve it by
 * processing the partial refund directly in Shopify Admin and recording the
 * result via the route's manual `update_remedy_status` action. The two
 * remaining cases — a standard-window 100% refund, and a late-window 100%
 * merchandise credit — always return the FULL line, so Shopify's own
 * suggested-refund figure needs no adjustment and this file only ever sums
 * two numbers Shopify or this codebase already computed (never derives one
 * from the other).
 *
 * ============================================================================
 * IDEMPOTENCY — docs/ARCHITECTURE-MVP1.md §6.7
 * ============================================================================
 * `RmaRemedy.@@unique([rmaId])` already makes ISSUING TWICE for one RMA
 * structurally impossible (criterion 196/204) — this file builds on that
 * rather than around it, exactly as assigned. What it adds is idempotency
 * for the SHOPIFY CALL WITHIN one issuance attempt: a UNIQUE `idempotency_key`
 * row is committed (via `executeIdempotent`) BEFORE the Shopify call, keyed
 * on `${remedy.id}:${remedy.updatedAt}` — the row's own `updatedAt`, which
 * Prisma's `@updatedAt` sets EXACTLY when this file transitions the remedy
 * into `processing`, is used as a durable per-attempt nonce with NO SCHEMA
 * CHANGE: it is set before the Shopify call (satisfying "committed before
 * the external call"), and a crash-recovery retry recomputes the identical
 * key by re-reading the same row PROVIDED it does not re-write the row while
 * it is already `processing` (this file is careful never to do that — see
 * the `view.remedy.status === "processing"` guard in `executeRmaRemedy`
 * below). `failed` is, by the remedy domain's own design
 * (`app/domain/rma/remedy.ts`), a retryable state (`failed: ["processing"]`);
 * a genuine retry after a failure calls `updateRmaRemedyStatus` again, which
 * bumps `updatedAt` again, which mints a FRESH key for the fresh attempt —
 * exactly the behaviour `executeIdempotent`'s permanent-`failed`-state design
 * requires for a retry to ever actually re-run the operation.
 *
 * A KNOWN, LOW-PROBABILITY RACE, not fixed here: `updateRmaRemedyStatus` is a
 * read-then-write (no compare-and-set), so two truly concurrent staff clicks
 * against the same `pending`/`failed`/`staff_review_required` remedy could
 * each observe the pre-transition state and mint two different keys. This
 * mirrors an already-accepted tolerance elsewhere in this codebase (e.g.
 * `createRmaRequest`'s own "vanishingly unlikely race" note) for a
 * staff-driven, low-frequency admin action, and the route disables its
 * submit button while a request is in flight (the same protection every
 * other staff mutation in this app relies on) — flagged here for architect
 * awareness, not silently accepted without a trace.
 */

export class RmaRemedyIllegalStateError extends Error {
  constructor(
    readonly rmaId: string,
    readonly reason: string
  ) {
    super(`RMA ${rmaId}: cannot execute remedy — ${reason}`);
    this.name = "RmaRemedyIllegalStateError";
  }
}

interface IssuedOutcome {
  readonly outcome: "issued";
  readonly processorReference: string;
  /** Decimal-string minor units — JSON-safe for the idempotency record's stored result payload. */
  readonly actualRefundOrCreditMinorUnits: string;
  readonly shopifyTaxAdjustmentMinorUnits: string;
}
interface StaffReviewOutcome {
  readonly outcome: "staff_review_required";
  readonly reason: string;
}
type RemedyOperationOutcome = IssuedOutcome | StaffReviewOutcome;

/** D7's fail-closed classification, plus the two Shopify-representability checks. No Shopify call for the restocking-fee case — see module header. */
async function performRemedyOperation(
  view: RmaStaffView,
  remedy: NonNullable<RmaStaffView["remedy"]>,
  port: RmaRemedyExecutionPort
): Promise<RemedyOperationOutcome> {
  if (remedy.restockingFeeMinorUnits > 0n) {
    return {
      outcome: "staff_review_required",
      reason:
        "Late-window 50% restocking-fee refund: Shopify has no way to compute tax proportional to a partial " +
        "merchandise value, and this codebase does not invent one (D7). Process this refund directly in Shopify " +
        "Admin, then record the result via 'Update remedy status'.",
    };
  }

  const suggested = await port.getSuggestedRefundForLine({ orderGid: view.orderRef, lineItemGid: view.lineRef });
  if (!suggested) {
    return {
      outcome: "staff_review_required",
      reason: "Shopify could not return a suggested refund for this order line (nothing left to refund, or unresolvable).",
    };
  }
  if (suggested.currency !== remedy.currency) {
    return {
      outcome: "staff_review_required",
      reason: `currency mismatch: remedy is ${remedy.currency}, Shopify's suggested refund is ${suggested.currency}.`,
    };
  }
  if (suggested.merchandiseAmountMinorUnits !== remedy.merchandiseAmountMinorUnits) {
    return {
      outcome: "staff_review_required",
      reason:
        `Shopify's suggested merchandise subtotal (${suggested.merchandiseAmountMinorUnits}) does not match the ` +
        `recorded remedy amount (${remedy.merchandiseAmountMinorUnits}); this codebase will not guess which is correct.`,
    };
  }

  const merchandise = Money.fromMinorUnits(remedy.merchandiseAmountMinorUnits, remedy.currency);
  const tax = Money.fromMinorUnits(suggested.taxAmountMinorUnits, remedy.currency);
  const total = merchandise.add(tax);

  if (remedy.kind === "merchandise_credit") {
    if (!view.customerRef) {
      return {
        outcome: "staff_review_required",
        reason: "No Shopify customer is on file for this RMA; native Store Credit requires a customer account (D5).",
      };
    }
    const credited = await port.issueStoreCredit({
      customerGid: view.customerRef,
      amountMinorUnits: total.amountMinorUnits,
      currency: total.currency,
    });
    if (!credited) {
      return {
        outcome: "staff_review_required",
        reason: "No Shopify Store Credit account exists for this customer (D5 — never falls back to a gift card).",
      };
    }
    return {
      outcome: "issued",
      processorReference: credited.reference,
      actualRefundOrCreditMinorUnits: total.amountMinorUnits.toString(),
      shopifyTaxAdjustmentMinorUnits: tax.amountMinorUnits.toString(),
    };
  }

  // kind === "refund_original_payment" with restockingFeeMinorUnits === 0n — the standard-window 100% refund.
  const refunded = await port.createRefund({
    orderGid: view.orderRef,
    lineItemGid: view.lineRef,
    totalAmountMinorUnits: total.amountMinorUnits,
    currency: total.currency,
  });
  return {
    outcome: "issued",
    processorReference: refunded.reference,
    actualRefundOrCreditMinorUnits: total.amountMinorUnits.toString(),
    shopifyTaxAdjustmentMinorUnits: tax.amountMinorUnits.toString(),
  };
}

/** A definitive Shopify rejection (userErrors, top-level errors) proves the mutation did not take effect — safe to classify `failed`. Anything else (network/timeout/unexpected) stays the safe default, `in_doubt`. */
const classifyRmaRemedyExecutionError: ClassifyIdempotentError = (error) =>
  error instanceof AdminApiError ? "failed" : "in_doubt";

export interface ExecuteRmaRemedyDeps {
  readonly port: RmaRemedyExecutionPort;
}

/**
 * Preconditions checked BEFORE any write or Shopify call (mirrors this
 * repository's own "refused, not recorded" discipline): the RMA must exist,
 * carry a remedy, be `remedy_in_progress`, and the remedy must not already
 * be `issued` (an idempotent read-only no-op, not an error, if it is).
 */
export async function executeRmaRemedy(rmaId: string, deps: ExecuteRmaRemedyDeps) {
  const view = await getRmaRequestForStaffReview(rmaId);
  if (!view) throw new RmaRequestNotFoundError(rmaId);
  if (!view.remedy) throw new RmaRemedyNotFoundError(rmaId);
  if (view.status !== "remedy_in_progress") {
    throw new RmaRemedyIllegalStateError(rmaId, `RMA status must be "remedy_in_progress" (is "${view.status}")`);
  }
  if (view.remedy.status === "issued") {
    return view.remedy; // already settled — nothing to do, nothing to call.
  }

  // Transition into `processing` ONLY when not already there — re-writing an
  // already-`processing` row would bump `updatedAt` and mint a DIFFERENT
  // idempotency key than whatever attempt is (or was) actually in flight,
  // defeating crash-recovery. See module header.
  const remedy =
    view.remedy.status === "processing" ? view.remedy : await updateRmaRemedyStatus({ rmaId, status: "processing" });

  const idempotencyKey = `rma_remedy_issue:${remedy.id}:${remedy.updatedAt.toISOString()}`;
  const payload = {
    rmaId,
    remedyId: remedy.id,
    kind: remedy.kind,
    merchandiseAmountMinorUnits: remedy.merchandiseAmountMinorUnits.toString(),
    restockingFeeMinorUnits: remedy.restockingFeeMinorUnits.toString(),
    currency: remedy.currency,
  };

  try {
    const outcome = await executeIdempotent<RemedyOperationOutcome>(
      idempotencyKeyRepository,
      idempotencyKey,
      "rma_remedy_issue",
      payload,
      () => performRemedyOperation(view, remedy, deps.port),
      classifyRmaRemedyExecutionError
    );

    if (outcome.outcome === "issued") {
      logger.info("rma.remedy_issued", { rmaId, remedyId: remedy.id, kind: remedy.kind });
      return updateRmaRemedyStatus({
        rmaId,
        status: "issued",
        processorReference: outcome.processorReference,
        actualRefundOrCreditMinorUnits: BigInt(outcome.actualRefundOrCreditMinorUnits),
        shopifyTaxAdjustmentMinorUnits: BigInt(outcome.shopifyTaxAdjustmentMinorUnits),
      });
    }
    logger.info("rma.remedy_staff_review_required", { rmaId, remedyId: remedy.id, reason: outcome.reason });
    return updateRmaRemedyStatus({ rmaId, status: "staff_review_required", staffReviewReason: outcome.reason });
  } catch (error) {
    if (error instanceof InDoubtIdempotencyError) {
      // Genuinely ambiguous — may have already succeeded at Shopify before
      // the response was lost. Leave the remedy at `processing` (never
      // `failed`, never `issued`) for staff to resolve via the idempotency
      // key queue before anything retries.
      logger.error("rma.remedy_in_doubt", { rmaId, remedyId: remedy.id, idempotencyKey });
      throw error;
    }

    if (error instanceof IdempotentOperationFailedError) {
      // A REPEAT call found the key already resolved `failed` by an earlier
      // attempt (the only way a key reaches `failed` is a DEFINITIVE
      // rejection — see classifyRmaRemedyExecutionError). Reconcile the
      // remedy row to match, in case an earlier attempt crashed between
      // recordFailure and this write.
      logger.error("rma.remedy_execution_failed", { rmaId, remedyId: remedy.id, message: error.message });
      await updateRmaRemedyStatus({ rmaId, status: "failed", failureReason: error.originalMessage ?? error.message });
      throw error;
    }

    // A fresh error from THIS attempt's operation() call. Only reconcile the
    // remedy row to `failed` if the SAME classifier executeIdempotent just
    // used agrees this was a definitive rejection — an "in_doubt"
    // classification must leave the remedy at `processing`, exactly like the
    // `InDoubtIdempotencyError` branch above, or a network timeout that may
    // have actually refunded the customer would get silently marked `failed`
    // and become eligible for a second, duplicate attempt.
    const message = error instanceof Error ? error.message : String(error);
    if (classifyRmaRemedyExecutionError(error) === "failed") {
      logger.error("rma.remedy_execution_failed", { rmaId, remedyId: remedy.id, message });
      await updateRmaRemedyStatus({ rmaId, status: "failed", failureReason: message });
    } else {
      logger.error("rma.remedy_in_doubt", { rmaId, remedyId: remedy.id, idempotencyKey, message });
    }
    throw error;
  }
}
