/**
 * Buy Now RMA remedy — merchandise-only calculation, and the remedy status
 * lifecycle (docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md §4,
 * docs/ARCHITECTURE-MVP1.md D5/D7/D10,
 * docs/specs/SLICE-4-BUY-NOW-RMA.md criteria 186-197, 204).
 *
 * PURE — no database access, no I/O, no ambient clock, no Shopify. This is
 * the single most important boundary in this task: THIS MODULE COMPUTES THE
 * MERCHANDISE REMEDY AND NOTHING ELSE. It contains no tax rate, no tax
 * percentage, no tax table, in this file or anywhere in this directory
 * (enforced by `taxBoundaryFence.test.ts`, mirroring criterion 175's
 * $100-fence style, including a "guard the guard" case per the finding
 * recorded in `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` §12 about a fence that
 * proved nothing).
 *
 * D7: "CaratForUs does not invent or maintain a tax formula. Shopify stays
 * authoritative for tax calculation and records." What this module produces
 * — `merchandiseAmountMinorUnits` and `restockingFeeMinorUnits` — is handed
 * to a LATER, not-yet-built job that requests Shopify's own suggested-
 * refund/tax breakdown and preserves it, recording it in the separate
 * `shopifyTaxAdjustmentMinorUnits`/`actualRefundOrCreditMinorUnits` columns
 * on `RmaRemedy` that this task's schema defines but never populates. If
 * that job finds Shopify cannot represent the transaction cleanly, it moves
 * the remedy to `staff_review_required` rather than manufacturing a number —
 * this module supplies that status as part of the same lifecycle, but the
 * decision to USE it belongs to that later job, not to this one.
 *
 * D10: no expiration, ever. There is no parameter anywhere in this file for
 * one, and no code path computes one.
 */

import { Money } from "../money/money";
import type { RoundingRuleId } from "../money/rounding";
import { RMA_REMEDY_KINDS, type RmaWindowKind, type RmaRemedyKind } from "./window";

export { RMA_REMEDY_KINDS };
export type { RmaRemedyKind };

/** The exact restocking fee policy §4 fixes for the late-window refund-to-original-payment choice. */
const RESTOCKING_FEE_RATE = "0.5";

export class RmaRemedyComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RmaRemedyComputationError";
  }
}

export interface RmaRemedyComputationInput {
  readonly windowKind: RmaWindowKind;
  /** Required (and only meaningful) when windowKind === "late" — see window.ts's validateRequestedRemedy. */
  readonly requestedRemedyKind: RmaRemedyKind | null;
  readonly eligibleMerchandiseAmountMinorUnits: bigint;
  readonly currency: string;
  readonly roundingRuleId: RoundingRuleId;
}

export interface RmaRemedyComputation {
  readonly remedyKind: RmaRemedyKind;
  /** Criterion 191: merchandiseAmountMinorUnits + restockingFeeMinorUnits === eligibleMerchandiseAmountMinorUnits, exactly. */
  readonly merchandiseAmountMinorUnits: bigint;
  readonly restockingFeeMinorUnits: bigint;
  readonly currency: string;
}

/**
 * Criteria 186-191. Computes ONLY the merchandise-side remedy:
 *
 * - `standard` window: always 100% refund to the original payment method
 *   (criterion 186) — no restocking fee, no choice.
 * - `late` window, `refund_original_payment` choice: 50% restocking fee
 *   (policy §4 option 1), computed once at the pricing engine's single money
 *   rounding boundary (`Money.multiplyByDecimal`) — never floating point.
 * - `late` window, `merchandise_credit` choice: 100% credit, no fee
 *   (policy §4 option 2).
 *
 * Throws if `windowKind === "late"` and `requestedRemedyKind` is null, or if
 * `windowKind === "standard"` and a choice is supplied — callers should have
 * already run `validateRequestedRemedy` (window.ts) before reaching here;
 * this is defense in depth, not the primary validation point.
 */
export function computeRmaRemedy(input: RmaRemedyComputationInput): RmaRemedyComputation {
  if (input.eligibleMerchandiseAmountMinorUnits < 0n) {
    throw new RmaRemedyComputationError("eligibleMerchandiseAmountMinorUnits cannot be negative");
  }

  const eligible = Money.fromMinorUnits(input.eligibleMerchandiseAmountMinorUnits, input.currency);

  if (input.windowKind === "standard") {
    if (input.requestedRemedyKind !== null) {
      throw new RmaRemedyComputationError("the standard window has no remedy choice; requestedRemedyKind must be null");
    }
    return {
      remedyKind: "refund_original_payment",
      merchandiseAmountMinorUnits: eligible.amountMinorUnits,
      restockingFeeMinorUnits: 0n,
      currency: input.currency,
    };
  }

  // windowKind === "late"
  if (input.requestedRemedyKind === null) {
    throw new RmaRemedyComputationError("the late window requires a customer-chosen requestedRemedyKind");
  }

  if (input.requestedRemedyKind === "merchandise_credit") {
    return {
      remedyKind: "merchandise_credit",
      merchandiseAmountMinorUnits: eligible.amountMinorUnits,
      restockingFeeMinorUnits: 0n,
      currency: input.currency,
    };
  }

  // requestedRemedyKind === "refund_original_payment" in the late window: 50% restocking fee.
  const restockingFee = eligible.multiplyByDecimal(RESTOCKING_FEE_RATE, input.roundingRuleId);
  const merchandiseAmount = eligible.subtract(restockingFee);

  return {
    remedyKind: "refund_original_payment",
    merchandiseAmountMinorUnits: merchandiseAmount.amountMinorUnits,
    restockingFeeMinorUnits: restockingFee.amountMinorUnits,
    currency: input.currency,
  };
}

/**
 * The remedy lifecycle (criteria 194, 196, 204). Mirrors
 * `app/domain/groupbuy/refunds.ts`'s `RefundStatus`/`assertRefundTransition`
 * shape closely — same discipline, same reasoning, adapted for this case.
 *
 * OWNER DECISION (late-window RMA approval gating, 2026-09-27): "Do not
 * automatically issue money or store credit merely because the RMA was
 * submitted or the package was received." `approved` is the STRUCTURAL edge
 * that makes this true for every remedy kind and every window, not just a
 * route-level check a future caller could bypass: `processing` (the only
 * status a real Shopify call can be attempted from) is reachable ONLY from
 * `approved` — never directly from `pending` — so "issued without an
 * explicit staff approval" is unrepresentable by this table, independent of
 * which route or job calls it. Approval is granted by a dedicated repository
 * function (`approveRmaRemedy`) that records a reviewer identity and
 * timestamp as its OWN fact (`RmaRemedy.approvedAt`/`approvedByActorRef`),
 * never inferred from `record_receipt` or `decide_condition` (those remain
 * `RmaRequest`-level facts, checked before a remedy can even be COMPUTED —
 * see `createRmaRemedy`'s `conditionDecision === "accepted"` guard — and are
 * a separate concern from the money-movement approval this status adds).
 * `prisma/migrations/20260927030000_rma_remedy_approval_gate`'s
 * `rma_remedy_guard` trigger mirrors this exact table at the database layer,
 * plus a same-row CHECK that no status other than `pending` may exist
 * without `approved_at`/`approved_by_actor_ref` recorded — the "impossible
 * even via a route-level bypass or raw SQL" guarantee the owner asked for.
 *
 * `staff_review_required` (D7's fail-closed state) returns only to
 * `processing`, never straight to `issued` — a human resolves the
 * representability question, and the reattempt still goes through the same
 * validated path every other attempt does, rather than acquiring a shortcut
 * into the issued-fields CHECK constraints. Retries from `failed` and
 * `staff_review_required` go straight back to `processing`, not back through
 * `approved` again — the remedy was already approved once, and approval, once
 * granted, is never re-solicited or revoked by a later status.
 */
export type RmaRemedyStatus = "pending" | "approved" | "processing" | "issued" | "failed" | "staff_review_required";

const ALLOWED_REMEDY_TRANSITIONS: Readonly<Record<RmaRemedyStatus, readonly RmaRemedyStatus[]>> = {
  // The ONLY way out of `pending`. No edge from `pending` to `processing`
  // exists — that absence is the whole point of this table.
  pending: ["approved"],
  // The ONLY way into `processing`. A staff reviewer has explicitly approved
  // this remedy; nothing about receipt or inspection implies this transition.
  approved: ["processing"],
  processing: ["issued", "failed", "staff_review_required"],
  // A failure returns to processing so a retry follows the same path as the first attempt.
  failed: ["processing"],
  // D7's fail-closed state: a human resolves the representability question first.
  staff_review_required: ["processing"],
  // Terminal. Policy §13 criterion 11: duplicate/retried issuance must not create duplicate value.
  issued: [],
};

export class InvalidRmaRemedyTransitionError extends Error {
  constructor(
    readonly from: RmaRemedyStatus,
    readonly to: RmaRemedyStatus
  ) {
    super(
      `RMA remedy cannot move from ${from} to ${to}. Allowed: ${ALLOWED_REMEDY_TRANSITIONS[from].join(", ") || "(terminal)"}`
    );
    this.name = "InvalidRmaRemedyTransitionError";
  }
}

/** The only place an RmaRemedy's status may change. Refused, not recorded, on an illegal request. */
export function assertRmaRemedyTransition(from: RmaRemedyStatus, to: RmaRemedyStatus): void {
  if (!ALLOWED_REMEDY_TRANSITIONS[from].includes(to)) {
    throw new InvalidRmaRemedyTransitionError(from, to);
  }
}

export function isRmaRemedyTerminal(status: RmaRemedyStatus): boolean {
  return ALLOWED_REMEDY_TRANSITIONS[status].length === 0;
}
