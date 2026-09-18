/**
 * Group Buy tier-adjustment refunds (README, "Group Buy Final Price / Refunds").
 *
 *   "If a lower tier is ultimately reached, earlier participants receive the
 *    same final eligible-variant price. Tier-price adjustments are refunded to
 *    the original payment method where supported, not store credit."
 *
 * A REFUND NEVER BECOMES A CHARGE, and this is the one judgement in the file.
 *
 * Qualifying units can fall as well as rise — cancellation "can move the live
 * campaign back to a prior tier before close" — so a customer who bought while
 * the campaign was at its deepest tier can find the FINAL tier is shallower
 * than the one they paid at. The arithmetic difference is then negative.
 *
 * The README addresses only the improving case, so the loss-making direction is
 * a decision rather than a reading: the amount is floored at zero and we absorb
 * it. Retroactively charging a customer more than they agreed to at checkout,
 * because other people cancelled, is not something to infer from silence — it
 * would need explicit authorisation, and it is the kind of thing that produces
 * chargebacks rather than revenue.
 *
 * PURE. No clock, no database, no rounding of its own: both prices are already
 * whole minor units, having each crossed the engine's single rounding boundary,
 * so the subtraction is exact and needs no further rounding.
 */

export interface RefundComputationInput {
  /** What the customer actually paid per unit, in whole minor units. */
  paidPerUnitMinorUnits: bigint;
  /** The campaign's final tier price per unit, in whole minor units. */
  finalPerUnitMinorUnits: bigint;
  /** Units still qualifying on this line at close. */
  qualifyingUnits: number;
}

export interface RefundComputation {
  /** Per unit, floored at zero. */
  refundPerUnitMinorUnits: bigint;
  /** refundPerUnit x qualifyingUnits. */
  totalRefundMinorUnits: bigint;
  /** False when nothing is owed — a distinct state from "owed zero by mistake". */
  owed: boolean;
  /**
   * True when the final price ended up ABOVE what was paid. No money moves, but
   * it is recorded: a campaign where this happens has had cancellations undo a
   * tier, and that is worth being able to see rather than inferring from a
   * suspicious run of zero refunds.
   */
  finalPriceExceededPaid: boolean;
}

export class RefundComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundComputationError";
  }
}

export function computeTierRefund(input: RefundComputationInput): RefundComputation {
  if (!Number.isInteger(input.qualifyingUnits) || input.qualifyingUnits < 0) {
    throw new RefundComputationError(
      `qualifyingUnits must be a non-negative integer, got ${input.qualifyingUnits}`
    );
  }
  if (input.paidPerUnitMinorUnits < 0n || input.finalPerUnitMinorUnits < 0n) {
    throw new RefundComputationError("prices cannot be negative");
  }

  const difference = input.paidPerUnitMinorUnits - input.finalPerUnitMinorUnits;
  const finalPriceExceededPaid = difference < 0n;
  const refundPerUnitMinorUnits = difference > 0n ? difference : 0n;
  const totalRefundMinorUnits = refundPerUnitMinorUnits * BigInt(input.qualifyingUnits);

  return {
    refundPerUnitMinorUnits,
    totalRefundMinorUnits,
    owed: totalRefundMinorUnits > 0n,
    finalPriceExceededPaid,
  };
}

/**
 * The refund lifecycle. README order states: "Refund pending ... In production,
 * QC complete, Shipped, Refund issued".
 *
 * Owner-confirmed timing: the amount is settled at CLOSE but deliberately HELD
 * through production and QC, and only released at shipping. The consequence
 * worth naming — a customer is owed money for as long as production takes, and
 * that obligation sits on our books throughout — is the reason `pending` and
 * `releasable` are distinct states rather than one "not yet paid".
 */
export type RefundStatus =
  /** Computed and owed, held through production/QC. Not payable yet. */
  | "pending"
  /** The item shipped; the refund may now be processed. */
  | "releasable"
  /** Handed to the payment processor; awaiting its answer. */
  | "processing"
  /** Money returned to the original payment method. Terminal. */
  | "issued"
  /** The processor rejected it. Retryable — NOT terminal. */
  | "failed"
  /** Nothing was owed, or the line was cancelled outright. Terminal. */
  | "not_owed";

const ALLOWED: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  // Held through production/QC — the whole point of the owner's timing.
  pending: ["releasable", "not_owed"],
  releasable: ["processing", "not_owed"],
  // A failure returns to `releasable` so a retry follows the same path as the
  // first attempt, rather than acquiring a second, less-tested route to money.
  processing: ["issued", "failed"],
  failed: ["releasable", "not_owed"],
  // Terminal. `issued` especially: README §371 — "Duplicate/retried refund ...
  // must not create duplicate customer value."
  issued: [],
  not_owed: [],
};

export class InvalidRefundTransitionError extends Error {
  constructor(
    readonly from: RefundStatus,
    readonly to: RefundStatus
  ) {
    super(
      `Refund cannot move from ${from} to ${to}. Allowed: ${ALLOWED[from].join(", ") || "(terminal)"}`
    );
    this.name = "InvalidRefundTransitionError";
  }
}

/**
 * The only place a refund's status may change.
 *
 * `issued` has NO outgoing transitions, which is what makes duplicate payment
 * structurally impossible rather than merely unlikely: a second attempt cannot
 * find a path back into `processing`.
 */
export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!ALLOWED[from].includes(to)) throw new InvalidRefundTransitionError(from, to);
}

export function isTerminal(status: RefundStatus): boolean {
  return ALLOWED[status].length === 0;
}
