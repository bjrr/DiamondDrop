/**
 * Buy Now RMA return window (docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md
 * §3-§5, docs/specs/SLICE-4-BUY-NOW-RMA.md criteria 184-188, 198).
 *
 * PURE — no database access, no I/O, no ambient clock (same discipline as
 * `app/domain/warranty/claimStatus.ts`). Every date this module touches is
 * passed in by the caller.
 *
 * ALL DAY MATH IS CALENDAR-DAY, DATE-ONLY. The policy states every deadline
 * in whole calendar days ("within 7 calendar days", "no later than 14
 * calendar days"), never elapsed hours — so this module compares UTC
 * calendar dates, never timestamps-with-time. Passing a `Date` with a
 * non-midnight time component is still handled correctly (the time portion
 * is discarded before comparison), but the caller should prefer a
 * date-only value (this repo stores `carrierConfirmedDeliveryDate` as
 * `@db.Date` for exactly this reason).
 *
 * THE WINDOW IS COMPUTED ONCE, AT REQUEST TIME, AND KEPT AS A FACT.
 * `classifyReturnWindow` is called by the (not-yet-built) intake path when
 * an `RmaRequest` row is first created, and the result — `windowKind` and
 * `calendarDaysSinceDelivery` — is stored on that row and never recomputed.
 * If the day thresholds in this file ever change, every request already on
 * file keeps the classification it was given at the time, the same
 * "never recalculate a historical commitment with today's rules" discipline
 * CLAUDE.md rule 7 states for Group Buy campaign pricing, generalized here to
 * an eligibility window (see `docs/specs/SLICE-4-BUY-NOW-RMA.md` criterion
 * 184 and `rma_request_guard`'s immutability check in this slice's
 * migration, which enforces the same fact at the database layer).
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export class RmaWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RmaWindowError";
  }
}

/** Truncates a Date to its UTC calendar date (midnight UTC), discarding any time-of-day component. */
function toUtcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Whole calendar days from `start` to `end`, inclusive of neither endpoint
 * (i.e. delivery day itself is day 0). Negative if `end` precedes `start` —
 * callers should treat a negative result as a data error (see
 * `calendarDaysSinceDelivery`), never as "0 days early."
 */
export function calendarDaysBetween(start: Date, end: Date): number {
  const startDateOnly = toUtcDateOnly(start).getTime();
  const endDateOnly = toUtcDateOnly(end).getTime();
  const differenceMs = endDateOnly - startDateOnly;

  // Both operands are UTC midnights (see toUtcDateOnly), so their difference
  // is EXACT BY CONSTRUCTION: an integer multiple of a day, with no DST
  // ambiguity (this is UTC, not local time) and no fractional remainder to
  // round away. Asserting that here — rather than reaching for Math.round —
  // is deliberate and stronger, not merely a way to dodge the money-safety
  // lint rule that bans Math.round/floor/ceil/trunc outside the rounding
  // registry: this is a day count, not money, so the rule fires on shape
  // rather than substance, but silently rounding past a non-zero remainder
  // would hide a real bug in toUtcDateOnly's normalisation instead of
  // surfacing it. If this ever throws, the normalisation broke; that is the
  // thing to fix, not this division.
  if (differenceMs % MILLISECONDS_PER_DAY !== 0) {
    throw new RmaWindowError(
      `calendarDaysBetween: non-whole-day difference (${differenceMs}ms) between UTC-midnight-normalised dates — ` +
        "this indicates a bug in toUtcDateOnly's normalisation, not a value to round"
    );
  }

  return differenceMs / MILLISECONDS_PER_DAY;
}

/**
 * Criterion 184 — the snapshot computed once at request time and stored
 * immutably on the `RmaRequest` row. Throws if the request date precedes the
 * delivery date (a data error a caller must not silently swallow — an RMA
 * cannot be requested before the item was delivered).
 */
export function calendarDaysSinceDelivery(deliveryDate: Date, requestedAt: Date): number {
  const days = calendarDaysBetween(deliveryDate, requestedAt);
  if (days < 0) {
    throw new RmaWindowError(
      `requestedAt (${requestedAt.toISOString()}) precedes deliveryDate (${deliveryDate.toISOString()})`
    );
  }
  return days;
}

export const RMA_WINDOW_KINDS = ["standard", "late"] as const;
export type RmaWindowKind = (typeof RMA_WINDOW_KINDS)[number];

export type RmaWindowClassification = RmaWindowKind | "ineligible";

/**
 * Criterion 185 — policy §3/§4/§5, verbatim:
 *   - Day 0-7: `"standard"` (100% refund only, criterion 186).
 *   - Day 8-30: `"late"` (customer's choice, criterion 187).
 *   - Day 31+: `"ineligible"` — the caller MUST refuse to create an
 *     `RmaRequest` row for this result. There is no `denied` status reserved
 *     for day-count alone; `denied` means every other reason (personalization,
 *     claim-workflow routing, staff judgement).
 *
 * Pure classification only — this function does not know or care about
 * reason category or item condition; see `evaluateRmaEligibility` in
 * `eligibility.ts` for the combined gate a caller should actually use before
 * creating a request.
 */
export function classifyReturnWindow(daysSinceDelivery: number): RmaWindowClassification {
  if (!Number.isInteger(daysSinceDelivery) || daysSinceDelivery < 0) {
    throw new RmaWindowError(`daysSinceDelivery must be a non-negative integer, got ${daysSinceDelivery}`);
  }
  if (daysSinceDelivery <= 7) return "standard";
  if (daysSinceDelivery <= 30) return "late";
  return "ineligible";
}

export const RMA_REMEDY_KINDS = ["refund_original_payment", "merchandise_credit"] as const;
export type RmaRemedyKind = (typeof RMA_REMEDY_KINDS)[number];

export type RequestedRemedyValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Criterion 188 — mirrors, at the application layer, the exact coherence
 * `rma_request_requested_remedy_coherent` enforces in this slice's migration:
 * a chosen remedy exists if and only if the window is `late`. Criterion 186:
 * a standard-window request has no choice to make, so submitting one is
 * refused rather than silently ignored.
 */
export function validateRequestedRemedy(
  windowKind: RmaWindowKind,
  requestedRemedyKind: RmaRemedyKind | null
): RequestedRemedyValidationResult {
  if (windowKind === "late") {
    if (requestedRemedyKind === null) {
      return { ok: false, reason: "the late window (days 8-30) requires the customer to choose a remedy" };
    }
    return { ok: true };
  }
  // windowKind === "standard"
  if (requestedRemedyKind !== null) {
    return {
      ok: false,
      reason: "the standard window (days 0-7) has no remedy choice; requestedRemedyKind must be null",
    };
  }
  return { ok: true };
}

/**
 * Criterion 198 — "received by CaratForUs no later than 14 calendar days
 * after original carrier-confirmed delivery" (policy §3, standard window).
 */
export function computeStandardReceiveByDeadline(deliveryDate: Date): Date {
  const deadline = toUtcDateOnly(deliveryDate);
  deadline.setUTCDate(deadline.getUTCDate() + 14);
  return deadline;
}

/**
 * Criterion 198 — "received by CaratForUs within 10 calendar days after RMA
 * approval" (policy §4, late window). Computed from the approval timestamp,
 * not the delivery date — the two windows use genuinely different anchors,
 * which is why `receiveByDeadline` is set uniformly at approval for both
 * windows rather than at request time for the standard one (see
 * `schema.prisma`'s `RmaRequest.receiveByDeadline` doc comment).
 */
export function computeLateReceiveByDeadline(approvedAt: Date): Date {
  const deadline = toUtcDateOnly(approvedAt);
  deadline.setUTCDate(deadline.getUTCDate() + 10);
  return deadline;
}

/** Dispatches to the correct deadline formula for the request's window. */
export function computeReceiveByDeadline(windowKind: RmaWindowKind, deliveryDate: Date, approvedAt: Date): Date {
  return windowKind === "standard" ? computeStandardReceiveByDeadline(deliveryDate) : computeLateReceiveByDeadline(approvedAt);
}

/**
 * "No later than" (policy §3/§4) is inclusive of the deadline day itself —
 * received exactly on the deadline still qualifies.
 */
export function isReceivedWithinDeadline(receivedAt: Date, deadline: Date): boolean {
  return calendarDaysBetween(deadline, receivedAt) <= 0;
}
