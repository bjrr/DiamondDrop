/**
 * Group Buy Bank Payment timing (owner §24: "initial payment window: 48
 * hours; if unpaid, automatically extend once for an additional 48 hours;
 * after 96 hours unpaid, the order may be marked internally inactive/
 * canceled for nonpayment").
 *
 * PURE, NO I/O — the sweep (`groupBuyBankPaymentInactivationSweep.server.ts`)
 * is the only caller that touches the database; this module only answers
 * "given when an order was quoted and what time it is now, has its payment
 * window elapsed".
 *
 * THE EXTENSION IS UNCONDITIONAL, SO THERE IS NOTHING TO BRANCH ON. Owner
 * §24 does not make the 48-hour extension contingent on anything — it always
 * happens, once, for every unpaid order. There is therefore no meaningful
 * "extend now" decision to model separately from "has 96 hours elapsed
 * since quotedAt": the two 48-hour windows collapse to one 96-hour deadline,
 * named as two constants below only so a reader can see the owner's own two
 * numbers rather than a single unexplained 96.
 *
 * WHY THIS NEVER CONSULTS `reactivatedAt`. A reactivation (owner §24: "the
 * customer requests reactivation by email... reactivation preserves the
 * original locked order price") explicitly reuses the SAME order at the SAME
 * price — it does not requote. The repository that performs a reactivation
 * is what resets the clock, by writing a FRESH `quotedAt`-equivalent
 * (`reactivatedAt`) that this function is then called against in place of
 * the original `quotedAt`; this module has no opinion on which timestamp its
 * caller supplies, only on the arithmetic once it has one.
 */

export const GROUP_BUY_INITIAL_PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const GROUP_BUY_AUTOMATIC_EXTENSION_MS = 48 * 60 * 60 * 1000;
export const GROUP_BUY_TOTAL_PAYMENT_WINDOW_MS =
  GROUP_BUY_INITIAL_PAYMENT_WINDOW_MS + GROUP_BUY_AUTOMATIC_EXTENSION_MS;

/** `windowStartedAt` + 96 hours — the instant an unpaid order becomes eligible for inactivation. */
export function groupBuyPaymentWindowDeadline(windowStartedAt: Date): Date {
  return new Date(windowStartedAt.getTime() + GROUP_BUY_TOTAL_PAYMENT_WINDOW_MS);
}

/**
 * True once `now` is AT OR PAST the 96-hour deadline. `windowStartedAt` is
 * whichever of `quotedAt` (never reactivated) or `reactivatedAt` (most
 * recently reactivated) the caller resolves as current — see the module
 * comment.
 */
export function hasGroupBuyPaymentWindowElapsed(windowStartedAt: Date, now: Date): boolean {
  return now.getTime() >= groupBuyPaymentWindowDeadline(windowStartedAt).getTime();
}

/**
 * The single, shared rule for "which timestamp is this order's window
 * currently counting from" — a reactivation resets the clock (owner §24),
 * so the most recent `reactivatedAt` takes priority over the original
 * `quotedAt` whenever one exists. Both the sweep and any admin/read surface
 * that needs to show "when does this order become inactive" must resolve it
 * this same way, so a display and the sweep that acts on it can never
 * disagree about which order is overdue.
 */
export function resolveGroupBuyPaymentWindowStart(order: {
  readonly quotedAt: Date;
  readonly reactivatedAt: Date | null;
}): Date {
  return order.reactivatedAt ?? order.quotedAt;
}
