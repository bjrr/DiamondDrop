/**
 * Luxury Steal order-time check — the decision layer (D6, criteria 137-140,
 * docs/specs/SLICE-3-LUXURY-STEALS.md §3/§4.4/§5, task 3-1).
 *
 * PURE — no database access, no I/O, no ambient clock. The actual matching
 * ALGORITHM (which stored `Acknowledgment` row, if any, corresponds to a
 * given `orders/create` line) is task 3-4's job — it owns the webhook and
 * therefore the query that produces the candidate acknowledgment id, per
 * this task's assignment ("the webhook itself is task 3-4, you build the
 * table and the repository it will use"). What belongs here, pure and
 * testable with no database, is the one rule that must never drift out of
 * sync with the schema's own CHECK constraint (this slice's migration):
 * the recorded OUTCOME is entirely determined by whether a matching
 * acknowledgment id was found, never supplied independently — so a caller
 * cannot construct a `matched` outcome with no acknowledgment, or an
 * `unmatched` outcome that still names one.
 *
 * Kept as a plain string union, not imported from `@prisma/client`, for the
 * same reason `verification.ts`'s `BankPaymentMethod` is — this module stays
 * importable and unit-testable with zero database dependency. The Prisma
 * `LuxuryStealOrderCheckOutcome` enum (`prisma/schema.prisma`) is required to
 * have exactly these two members in this exact spelling.
 */
export const LUXURY_STEAL_ORDER_CHECK_OUTCOMES = ["matched", "unmatched"] as const;
export type LuxuryStealOrderCheckOutcome = (typeof LUXURY_STEAL_ORDER_CHECK_OUTCOMES)[number];

export interface OrderCheckDecisionInput {
  /**
   * The acknowledgment id task 3-4's matching query found for this line, or
   * `null` if none matched. This is the ONLY input to the outcome decision —
   * see this module's header comment for why the outcome is never an
   * independent field.
   */
  readonly matchedAcknowledgmentId: string | null;
}

/**
 * Criterion 140: whichever way it comes out, it is recorded. `matched`
 * requires a non-null acknowledgment id; `unmatched` requires a null one —
 * mirrored at the database level by this slice's migration CHECK constraint
 * on `luxury_steal_order_check`, so the invariant holds even against a
 * caller that bypasses this function.
 */
export function decideOrderCheckOutcome(input: OrderCheckDecisionInput): LuxuryStealOrderCheckOutcome {
  return input.matchedAcknowledgmentId !== null ? "matched" : "unmatched";
}
