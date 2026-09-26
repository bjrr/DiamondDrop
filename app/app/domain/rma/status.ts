/**
 * Buy Now RMA status state machine
 * (docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md §2-§7,
 * docs/specs/SLICE-4-BUY-NOW-RMA.md criteria 198-203).
 *
 * PURE — no database access, no I/O, no ambient clock (same discipline as
 * `app/domain/warranty/claimStatus.ts`, whose shape this mirrors closely —
 * see that module's header for the fuller rationale of this pattern). This
 * module is the ONE source of truth for which status transitions are legal;
 * `prisma/migrations/20260926010000_slice4_buy_now_rma_schema`'s
 * `rma_request_guard` trigger is a hand-written SQL MIRROR of the exact same
 * table, kept deliberately in lockstep as defense-in-depth. Change one,
 * change both, and say so in the commit.
 *
 * NO PAUSE STATE. Unlike the warranty claim machine's
 * `more_information_requested`, nothing in the locked RMA policy calls for
 * one — inventing a pause/resume mechanism this workflow doesn't need would
 * be the kind of speculative addition CLAUDE.md's implementation discipline
 * forbids.
 *
 * TWO ORDERINGS THE POLICY MAKES NON-NEGOTIABLE
 * ----------------------------------------------
 * 1. A condition decision cannot precede recorded receipt (criterion 202).
 *    `decide_condition` is legal only from `received_inspection_pending`,
 *    reachable only through `record_receipt` — the one transition that
 *    records `receivedAt`.
 * 2. A claim cannot reach `resolved` without having been decided.
 *    `resolve` is legal only from `remedy_in_progress` (itself reachable
 *    only from `inspection_passed`) or from `inspection_failed` — both
 *    decided states, so there is no path to `resolved` that skips a
 *    decision.
 *
 * `approve`/`deny` carry no window/eligibility payload: `windowKind` and the
 * eligible-merchandise-amount snapshot are set at ROW CREATION (see
 * `window.ts`'s header and `schema.prisma`'s `RmaRequest.windowKind` doc
 * comment), not decided by this transition. `approve` only marks that
 * staff/system confirmed overall eligibility (item condition, reason
 * category) — the repository layer (a later task) is responsible for
 * computing and persisting `approvedAt`/`receiveByDeadline` in the same
 * write as this transition, exactly as the warranty machine leaves
 * `authorizedAt` to its caller.
 */

export const RMA_STATUSES = [
  "submitted",
  "approved",
  "denied",
  "return_shipped",
  "expired",
  "received_inspection_pending",
  "inspection_passed",
  "inspection_failed",
  "remedy_in_progress",
  "resolved",
  "closed",
] as const;

export type RmaStatus = (typeof RMA_STATUSES)[number];

export const RMA_CONDITION_DECISIONS = ["accepted", "rejected"] as const;
export type RmaConditionDecision = (typeof RMA_CONDITION_DECISIONS)[number];

/**
 * The facts of a request relevant to deciding its next legal transition.
 * Deliberately narrow — not the whole `RmaRequest` row, only what the
 * transition rules below actually consult.
 */
export interface RmaTransitionState {
  readonly status: RmaStatus;
  /** Criterion 202's gate. Set exactly once, by `record_receipt`. */
  readonly receivedAt: Date | null;
}

/**
 * One legal action a caller (a later repository, on behalf of a
 * staff/system/customer actor as the policy specifies for each) may
 * request. Named actions rather than a raw `{from, to}` pair so the payload
 * each requires is checked by the type system — e.g. `deny` cannot be
 * constructed without a `reason` (mirrors `warranty_claim_denial_requires_reason`'s
 * coupling), and `decide_condition` with `decision: "rejected"` cannot be
 * constructed without one either (criterion 202).
 */
export type RmaAction =
  | { readonly type: "approve" }
  | { readonly type: "deny"; readonly reason: string }
  | { readonly type: "mark_return_shipped" }
  | { readonly type: "expire" }
  | { readonly type: "record_receipt" }
  | { readonly type: "decide_condition"; readonly decision: "accepted" }
  | { readonly type: "decide_condition"; readonly decision: "rejected"; readonly reason: string }
  | { readonly type: "begin_remedy" }
  | { readonly type: "resolve" }
  | { readonly type: "close" };

export type RmaActionType = RmaAction["type"];

export interface RmaTransitionSuccess {
  readonly ok: true;
  readonly nextStatus: RmaStatus;
}

export interface RmaTransitionRefusal {
  readonly ok: false;
  readonly reason: string;
}

export type RmaTransitionResult = RmaTransitionSuccess | RmaTransitionRefusal;

function refuse(reason: string): RmaTransitionRefusal {
  return { ok: false, reason };
}

function succeed(nextStatus: RmaStatus): RmaTransitionSuccess {
  return { ok: true, nextStatus };
}

/**
 * Decide whether `action` is legal against `state`, and if so what the
 * request's next `status` should be. Never throws — an illegal transition
 * is a typed refusal (`ok: false`), matching this module's header: refused,
 * not recorded.
 */
export function decideRmaTransition(state: RmaTransitionState, action: RmaAction): RmaTransitionResult {
  switch (action.type) {
    case "approve":
      // submitted -> approved
      if (state.status !== "submitted") {
        return refuse(`approve is only legal from "submitted" (request is "${state.status}")`);
      }
      return succeed("approved");

    case "deny":
      // submitted -> denied. Criterion 202-sibling reasoning: a denial
      // without a reason is not a valid state — the discriminated union
      // requires `reason` at the type level; this guards the runtime value.
      if (state.status !== "submitted") {
        return refuse(`deny is only legal from "submitted" (request is "${state.status}")`);
      }
      if (action.reason.trim().length === 0) {
        return refuse("deny requires a non-empty reason");
      }
      return succeed("denied");

    case "mark_return_shipped":
      // approved -> return_shipped
      if (state.status !== "approved") {
        return refuse(`mark_return_shipped is only legal from "approved" (request is "${state.status}")`);
      }
      return succeed("return_shipped");

    case "expire":
      // approved | return_shipped -> expired. Criterion 198: the customer
      // ran out the receive-by deadline before CaratForUs recorded receipt.
      if (state.status !== "approved" && state.status !== "return_shipped") {
        return refuse(`expire is only legal from "approved" or "return_shipped" (request is "${state.status}")`);
      }
      if (state.receivedAt !== null) {
        // Defensive: a data-integrity bug, not a normal caller error — the
        // status/receivedAt CHECK constraints should have made this
        // unreachable. Refusing rather than silently expiring a received item.
        return refuse("expire is not legal once a receipt has been recorded");
      }
      return succeed("expired");

    case "record_receipt":
      // approved | return_shipped -> received_inspection_pending. The ONLY
      // transition that records receivedAt (criterion 202) — the caller
      // sets the actual timestamp (no ambient clock in this module).
      if (state.status !== "approved" && state.status !== "return_shipped") {
        return refuse(
          `record_receipt is only legal from "approved" or "return_shipped" (request is "${state.status}")`
        );
      }
      return succeed("received_inspection_pending");

    case "decide_condition": {
      // received_inspection_pending -> inspection_passed | inspection_failed.
      if (state.status !== "received_inspection_pending") {
        return refuse(
          `decide_condition is only legal from "received_inspection_pending" (request is "${state.status}")`
        );
      }
      if (state.receivedAt === null) {
        // Defense in depth, mirroring warranty's decide_coverage — the only
        // legal predecessor status already implies this.
        return refuse("decide_condition requires a recorded receipt (receivedAt is null)");
      }
      if (action.decision === "rejected" && action.reason.trim().length === 0) {
        return refuse("decide_condition with decision rejected requires a non-empty reason");
      }
      return succeed(action.decision === "accepted" ? "inspection_passed" : "inspection_failed");
    }

    case "begin_remedy":
      // inspection_passed -> remedy_in_progress
      if (state.status !== "inspection_passed") {
        return refuse(`begin_remedy is only legal from "inspection_passed" (request is "${state.status}")`);
      }
      return succeed("remedy_in_progress");

    case "resolve":
      // remedy_in_progress | inspection_failed -> resolved. Both
      // predecessors are decided states, so `resolved` is unreachable from
      // an undecided request (criterion 202's ordering).
      if (state.status !== "remedy_in_progress" && state.status !== "inspection_failed") {
        return refuse(
          `resolve is only legal from "remedy_in_progress" or "inspection_failed" (request is "${state.status}")`
        );
      }
      return succeed("resolved");

    case "close":
      // resolved -> closed
      if (state.status !== "resolved") {
        return refuse(`close is only legal from "resolved" (request is "${state.status}")`);
      }
      return succeed("closed");

    default: {
      const exhaustiveCheck: never = action;
      return refuse(`unrecognised action: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Criterion 199 — no return/shipping instruction may be produced before an
 * RMA reaches `approved`. Pure helper so every surface (route, email
 * template, status page) asks this exact question the same way rather than
 * each re-deriving it from a status comparison of its own. Mirrors
 * `app/domain/warranty/claimStatus.ts`'s `mayIssueInboundShippingInstructions`
 * exactly, including passing `approvedAt` (rather than re-deriving from
 * `status`) so this stays true even for a request that has since moved past
 * `approved` — approval, once granted, is never revoked by a later status.
 */
export function mayIssueReturnInstructions(rma: { readonly approvedAt: Date | null }): boolean {
  return rma.approvedAt !== null;
}
