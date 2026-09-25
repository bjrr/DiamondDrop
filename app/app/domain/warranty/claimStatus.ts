/**
 * Warranty claim status state machine (D-none; docs/WARRANTY-CLAIMS.md §8,
 * docs/specs/SLICE-5-WARRANTY-CLAIMS.md criteria 156-160, 168-169, task 5-1).
 *
 * PURE — no database access, no I/O, no ambient clock (same discipline as
 * `app/domain/luxurysteals/orderCheck.ts`). This module is the ONE source of
 * truth for which status transitions are legal; `prisma/migrations/
 * 20260925010000_slice5_warranty_claims_schema`'s `warranty_claim_guard`
 * trigger is a hand-written SQL MIRROR of the exact same table, kept
 * deliberately in lockstep as defense-in-depth (criterion 168: an illegal
 * transition must be a refusal, not a recorded row, even against a caller
 * that bypasses this module entirely). Change one, change both, and say so
 * in the commit — they must never drift apart.
 *
 * TWO ORDERINGS THE POLICY MAKES NON-NEGOTIABLE
 * ----------------------------------------------
 * 1. A coverage decision cannot precede recorded receipt (criterion 159).
 *    `decide_coverage` is legal only from `received_inspection_pending`,
 *    which is reachable only through `record_receipt`
 *    (`in_transit_to_carat_for_us -> received_inspection_pending`, the ONE
 *    transition that records `receivedAt`) — see point 2 below for why a
 *    claim cannot slip past that through the pause state.
 * 2. A claim cannot reach `resolved` without having been decided. `resolve`
 *    is legal only from `remedy_in_progress` (itself reachable only from
 *    `approved_covered`) or from `denied_not_covered` — both are decided
 *    states, so there is no path to `resolved` that skips a decision.
 *
 * WHY `more_information_requested` IS A PAUSE, NOT A FORK
 * ---------------------------------------------------------
 * §8 lists "More Information Requested" as one status, and it plainly needs
 * to be reachable both before and after receipt — a claim can be missing
 * photos before anything ships, and it can just as easily need a follow-up
 * question ("was this resized after delivery?") after the item is physically
 * in hand and being inspected. Naively allowing
 * `more_information_requested -> received_inspection_pending` as a STATIC
 * edge (reachable regardless of where the pause was entered from) would
 * silently create a shortcut around ordering rule 1: pause from
 * `under_review` (before any receipt), then "resume" straight into
 * `received_inspection_pending` — and now a coverage decision looks legal
 * with no receipt ever actually recorded.
 *
 * The fix is that `more_information_requested` carries WHERE it paused from
 * (`pausedFromStatus`), and `resume_after_more_information` returns to
 * EXACTLY that recorded status — never a caller-chosen destination. So:
 *   - paused from `under_review`               -> resumes to `under_review`
 *   - paused from `received_inspection_pending` -> resumes to `received_inspection_pending`
 * and nothing else is possible, because the destination is read off the
 * claim's own recorded fact rather than named by the request. This is the
 * same reason the database mirror compares against `OLD.paused_from_status`
 * as a value rather than encoding a second static edge.
 */

export const WARRANTY_CLAIM_STATUSES = [
  "submitted",
  "under_review",
  "more_information_requested",
  "authorized_for_inspection",
  "in_transit_to_carat_for_us",
  "received_inspection_pending",
  "approved_covered",
  "denied_not_covered",
  "remedy_in_progress",
  "resolved",
  "closed",
] as const;

export type WarrantyClaimStatus = (typeof WARRANTY_CLAIM_STATUSES)[number];

export const WARRANTY_COVERAGE_DECISIONS = ["covered", "not_covered"] as const;
export type WarrantyCoverageDecision = (typeof WARRANTY_COVERAGE_DECISIONS)[number];

/**
 * The facts of a claim relevant to deciding its next legal transition.
 * Deliberately narrow — this is not the whole `WarrantyClaim` row, only what
 * the transition rules above actually consult.
 */
export interface WarrantyClaimTransitionState {
  readonly status: WarrantyClaimStatus;
  /** Meaningful only while `status === "more_information_requested"`. */
  readonly pausedFromStatus: WarrantyClaimStatus | null;
  /** Criterion 159's gate. Set exactly once, by `record_receipt`. */
  readonly receivedAt: Date | null;
}

/**
 * One legal action a caller (task 5-2's repository, on behalf of a
 * staff/system actor) may request. Modelled as named actions rather than a
 * raw `{from, to}` pair so that the payload each action requires is checked
 * by the type system, not just at runtime — e.g. `decide_coverage` with
 * `decision: "not_covered"` cannot be constructed without a `reason`
 * (criterion 160), mirroring the CHECK constraint that also enforces it at
 * the database layer.
 */
export type WarrantyClaimAction =
  | { readonly type: "start_review" }
  | { readonly type: "request_more_information" }
  | { readonly type: "resume_after_more_information" }
  | { readonly type: "authorize_for_inspection" }
  | { readonly type: "mark_in_transit" }
  | { readonly type: "record_receipt" }
  | { readonly type: "decide_coverage"; readonly decision: "covered"; readonly reason?: string }
  | { readonly type: "decide_coverage"; readonly decision: "not_covered"; readonly reason: string }
  | { readonly type: "begin_remedy" }
  | { readonly type: "resolve" }
  | { readonly type: "close" };

export type WarrantyClaimActionType = WarrantyClaimAction["type"];

export interface WarrantyClaimTransitionSuccess {
  readonly ok: true;
  readonly nextStatus: WarrantyClaimStatus;
  /** Non-null only when `nextStatus === "more_information_requested"`. */
  readonly nextPausedFromStatus: WarrantyClaimStatus | null;
}

export interface WarrantyClaimTransitionRefusal {
  readonly ok: false;
  readonly reason: string;
}

export type WarrantyClaimTransitionResult = WarrantyClaimTransitionSuccess | WarrantyClaimTransitionRefusal;

function refuse(reason: string): WarrantyClaimTransitionRefusal {
  return { ok: false, reason };
}

function succeed(
  nextStatus: WarrantyClaimStatus,
  nextPausedFromStatus: WarrantyClaimStatus | null = null
): WarrantyClaimTransitionSuccess {
  return { ok: true, nextStatus, nextPausedFromStatus };
}

/**
 * Decide whether `action` is legal against `state`, and if so what the
 * claim's next `status`/`pausedFromStatus` should be. Never throws — an
 * illegal transition is a typed refusal (`ok: false`), matching this
 * module's header: refused, not recorded.
 */
export function decideWarrantyClaimTransition(
  state: WarrantyClaimTransitionState,
  action: WarrantyClaimAction
): WarrantyClaimTransitionResult {
  switch (action.type) {
    case "start_review":
      // submitted -> under_review
      if (state.status !== "submitted") {
        return refuse(`start_review is only legal from "submitted" (claim is "${state.status}")`);
      }
      return succeed("under_review");

    case "request_more_information":
      // under_review | received_inspection_pending -> more_information_requested,
      // recording exactly where it paused from (see module header).
      if (state.status !== "under_review" && state.status !== "received_inspection_pending") {
        return refuse(
          `request_more_information is only legal from "under_review" or "received_inspection_pending" (claim is "${state.status}")`
        );
      }
      return succeed("more_information_requested", state.status);

    case "resume_after_more_information":
      // more_information_requested -> exactly pausedFromStatus. Never a
      // caller-chosen destination — see module header for why.
      if (state.status !== "more_information_requested") {
        return refuse(
          `resume_after_more_information is only legal from "more_information_requested" (claim is "${state.status}")`
        );
      }
      if (state.pausedFromStatus === null) {
        // Defensive: a data-integrity bug (a more_information_requested row
        // with no recorded pause origin), not a normal caller error. The
        // database CHECK/trigger should have made this unreachable; refusing
        // here rather than guessing a destination keeps that true even if it
        // somehow wasn't.
        return refuse("more_information_requested claim has no recorded pausedFromStatus to resume to");
      }
      return succeed(state.pausedFromStatus);

    case "authorize_for_inspection":
      // under_review -> authorized_for_inspection. Criterion 157: this
      // action IS the explicit staff act; the caller (task 5-2) is
      // responsible for only invoking it from an authenticated staff
      // identity and recording that identity/timestamp on the claim row.
      if (state.status !== "under_review") {
        return refuse(`authorize_for_inspection is only legal from "under_review" (claim is "${state.status}")`);
      }
      return succeed("authorized_for_inspection");

    case "mark_in_transit":
      // authorized_for_inspection -> in_transit_to_carat_for_us
      if (state.status !== "authorized_for_inspection") {
        return refuse(
          `mark_in_transit is only legal from "authorized_for_inspection" (claim is "${state.status}")`
        );
      }
      return succeed("in_transit_to_carat_for_us");

    case "record_receipt":
      // in_transit_to_carat_for_us -> received_inspection_pending. The ONLY
      // transition that records receivedAt (criterion 159) — the caller sets
      // the actual timestamp (no ambient clock in this module).
      if (state.status !== "in_transit_to_carat_for_us") {
        return refuse(
          `record_receipt is only legal from "in_transit_to_carat_for_us" (claim is "${state.status}")`
        );
      }
      return succeed("received_inspection_pending");

    case "decide_coverage": {
      // received_inspection_pending -> approved_covered | denied_not_covered.
      // Criterion 159, checked explicitly here even though the only legal
      // predecessor status already implies it — defense in depth, mirroring
      // the database CHECK that guards the same fact independently of the
      // transition table.
      if (state.status !== "received_inspection_pending") {
        return refuse(
          `decide_coverage is only legal from "received_inspection_pending" (claim is "${state.status}")`
        );
      }
      if (state.receivedAt === null) {
        return refuse("decide_coverage requires a recorded receipt (receivedAt is null)");
      }
      // Criterion 160: a denial without a reason is not a valid state. The
      // discriminated union already makes `reason` required for
      // "not_covered" at the type level; this guards the runtime value too
      // (an empty/whitespace-only string is not a reason).
      if (action.decision === "not_covered" && action.reason.trim().length === 0) {
        return refuse("decide_coverage with decision not_covered requires a non-empty reason");
      }
      return succeed(action.decision === "covered" ? "approved_covered" : "denied_not_covered");
    }

    case "begin_remedy":
      // approved_covered -> remedy_in_progress. Criterion 162: the remedy
      // KIND is chosen by CaratForUs via WarrantyClaimRemedy (task 5-2), not
      // by this action — this only marks the claim as entering that phase.
      if (state.status !== "approved_covered") {
        return refuse(`begin_remedy is only legal from "approved_covered" (claim is "${state.status}")`);
      }
      return succeed("remedy_in_progress");

    case "resolve":
      // remedy_in_progress | denied_not_covered -> resolved. Both
      // predecessors are decided states, so `resolved` is unreachable from
      // an undecided claim (criterion 168's second ordering).
      if (state.status !== "remedy_in_progress" && state.status !== "denied_not_covered") {
        return refuse(
          `resolve is only legal from "remedy_in_progress" or "denied_not_covered" (claim is "${state.status}")`
        );
      }
      return succeed("resolved");

    case "close":
      // resolved -> closed
      if (state.status !== "resolved") {
        return refuse(`close is only legal from "resolved" (claim is "${state.status}")`);
      }
      return succeed("closed");

    default: {
      const exhaustiveCheck: never = action;
      return refuse(`unrecognised action: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Criterion 156 — no shipping instruction may be produced before a claim
 * reaches `authorized_for_inspection`. Pure helper so every surface (route,
 * email template, status page) can ask this exact question the same way
 * rather than each re-deriving it from a status comparison of its own.
 * `authorizedForInspectionAt` is the claim's `authorizedAt` column — passing
 * it (rather than re-deriving from `status`) means this stays true even for
 * a claim that has since moved past `authorized_for_inspection`, since
 * authorization, once granted, is never revoked by a later status.
 */
export function mayIssueInboundShippingInstructions(claim: {
  readonly authorizedAt: Date | null;
}): boolean {
  return claim.authorizedAt !== null;
}
