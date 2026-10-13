/**
 * Group Buy cancellation-acknowledgment order-time verification — the
 * decision layer (owner spec 2026-09-27/28, mirroring
 * `~/domain/luxurysteals/orderCheck.ts`'s shape and discipline for the same
 * reason: this rule must never drift out of sync with the schema's own CHECK
 * constraint on `group_buy_order_cancellation_check` — the recorded OUTCOME
 * is entirely determined by whether a VERIFIED acknowledgment id was found,
 * never supplied independently).
 *
 * PURE — no database access, no I/O, no ambient clock. The actual matching
 * ALGORITHM (which stored `Acknowledgment` row, if any, a line's property
 * names) is the webhook handler's job, exactly as task 3-4 owned that split
 * for Luxury Steals; this module owns the one rule that decides whether a
 * CANDIDATE acknowledgment the handler already resolved actually counts.
 *
 * ============================================================================
 * "THE LINE-ITEM ACKNOWLEDGMENT ID IS ONLY A REFERENCE, NOT PROOF BY ITSELF"
 * ============================================================================
 * (owner, verbatim). An id that resolves to a REAL `Acknowledgment` row is
 * necessary but not sufficient — the row must ALSO belong to THIS customer,
 * THIS campaign, at the CURRENT required policy version, with the CURRENT
 * pinned text and label. Every one of those is checked independently below;
 * a caller that only checked "does this id exist" would let through the
 * exact attack the owner named: a customer's own acknowledgment from a
 * DIFFERENT campaign, or another customer's acknowledgment entirely, either
 * of which is a perfectly real, perfectly resolvable row.
 *
 * WHY POLICY VERSION IS CHECKED FOR EQUALITY WITH THE CURRENT REQUIRED
 * VERSION, NOT MERELY "some version of the right slug". `policy_version` is
 * append-only — a future wording change adds version 2 without touching
 * version 1's already-recorded rows. An acknowledgment captured against a
 * SUPERSEDED version proves the customer agreed to OLD terms, not the terms
 * currently in force, which is exactly the "stale" case the owner named.
 */

export const GROUP_BUY_CANCELLATION_ORDER_CHECK_OUTCOMES = ["matched", "unmatched"] as const;
export type GroupBuyCancellationOrderCheckOutcome = (typeof GROUP_BUY_CANCELLATION_ORDER_CHECK_OUTCOMES)[number];

/** Everything about a CANDIDATE acknowledgment the handler resolved by id — a plain projection of the stored `Acknowledgment` + its `PolicyVersion`, never trusted further than what is checked below. */
export interface CandidateCancellationAcknowledgment {
  readonly id: string;
  readonly exactText: string;
  readonly affirmativeActionLabel: string;
  readonly customerRef: string | null;
  readonly campaignRef: string | null;
  readonly policyVersionSlug: string;
  readonly policyVersionVersion: number;
}

/** What THIS order/line actually requires the acknowledgment to say and belong to — computed by the caller from the order's own authenticated customer, the campaign it names, and the CURRENT pinned copy (never from the request/candidate itself). */
export interface ExpectedCancellationAcknowledgmentContext {
  /** The order's own AUTHENTICATED Shopify customer gid — never a client-supplied field. */
  readonly customerRef: string;
  /** The specific campaign's `code` this line belongs to. */
  readonly campaignRef: string;
  readonly requiredText: string;
  readonly requiredLabel: string;
  readonly requiredPolicySlug: string;
  readonly requiredPolicyVersion: number;
}

/**
 * Internal-only diagnostic — never customer-facing, and never itself the
 * `outcome` column (that stays the closed `matched`/`unmatched` union so the
 * database CHECK constraint has exactly two values to enforce). Recorded
 * alongside the outcome purely so a held order's evidence explains WHY,
 * without a human re-deriving it from raw column comparisons.
 */
export const CANCELLATION_ACKNOWLEDGMENT_MISMATCH_REASONS = [
  "no_candidate",
  "customer_mismatch",
  "campaign_mismatch",
  "text_mismatch",
  "label_mismatch",
  "policy_slug_mismatch",
  "policy_version_stale",
] as const;
export type CancellationAcknowledgmentMismatchReason = (typeof CANCELLATION_ACKNOWLEDGMENT_MISMATCH_REASONS)[number];

export interface CancellationAcknowledgmentVerificationResult {
  readonly outcome: GroupBuyCancellationOrderCheckOutcome;
  /** Non-null if and only if `outcome === "matched"` — the CANDIDATE's own id, echoed back only once every check below has passed. */
  readonly matchedAcknowledgmentId: string | null;
  /** Non-null if and only if `outcome === "unmatched"`. */
  readonly mismatchReason: CancellationAcknowledgmentMismatchReason | null;
}

/**
 * THE reference-is-not-proof check. `candidate` is `null` when the line
 * carried no acknowledgment property, an unparsable one, or one that did not
 * resolve to any stored row at all — the caller collapses all three into
 * "no candidate" before calling this, since none of them has anything left
 * to check.
 *
 * Checked in a fixed order so the FIRST reason a real mismatch would be
 * caught is always the one recorded — order does not change the OUTCOME
 * (any failure is `unmatched` regardless of which check fired), only which
 * `mismatchReason` explains it.
 */
export function verifyCancellationAcknowledgment(
  candidate: CandidateCancellationAcknowledgment | null,
  expected: ExpectedCancellationAcknowledgmentContext
): CancellationAcknowledgmentVerificationResult {
  function unmatched(reason: CancellationAcknowledgmentMismatchReason): CancellationAcknowledgmentVerificationResult {
    return { outcome: "unmatched", matchedAcknowledgmentId: null, mismatchReason: reason };
  }

  if (!candidate) return unmatched("no_candidate");

  // THE COPIED-ACKNOWLEDGMENT CASE (owner's own example): a perfectly real,
  // perfectly resolvable row that simply belongs to someone/something else.
  if (candidate.customerRef !== expected.customerRef) return unmatched("customer_mismatch");
  if (candidate.campaignRef !== expected.campaignRef) return unmatched("campaign_mismatch");

  // THE STALE-COPY-OF-APPROVED-TERMS CASE: a row that really does belong to
  // this customer and campaign, but was captured against text/label/version
  // that is no longer the CURRENT required one.
  if (candidate.exactText !== expected.requiredText) return unmatched("text_mismatch");
  if (candidate.affirmativeActionLabel !== expected.requiredLabel) return unmatched("label_mismatch");
  if (candidate.policyVersionSlug !== expected.requiredPolicySlug) return unmatched("policy_slug_mismatch");
  if (candidate.policyVersionVersion !== expected.requiredPolicyVersion) return unmatched("policy_version_stale");

  return { outcome: "matched", matchedAcknowledgmentId: candidate.id, mismatchReason: null };
}

/**
 * Re-derives the outcome from ONLY `matchedAcknowledgmentId`, mirroring
 * `decideOrderCheckOutcome` in `~/domain/luxurysteals/orderCheck.ts` exactly
 * — a second, independent guarantee (on top of `verifyCancellationAcknowledgment`
 * itself) that the repository can never persist a `matched` row with no id, or
 * an `unmatched` row that still names one, even if a future caller bypasses
 * `verifyCancellationAcknowledgment` entirely.
 */
export function decideCancellationOrderCheckOutcome(input: {
  matchedAcknowledgmentId: string | null;
}): GroupBuyCancellationOrderCheckOutcome {
  return input.matchedAcknowledgmentId !== null ? "matched" : "unmatched";
}
