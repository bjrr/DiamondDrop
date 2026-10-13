/**
 * The Bank Payment cancellation email (criterion 80 / D22, §17.1).
 *
 * OWNER-APPROVED COPY, 2026-09-22. Every character below is the owner's,
 * including the curly apostrophes and the US spelling "canceled" — do not
 * "correct" either. Criterion 111.3's blocker is satisfied by this text and
 * nothing else: an edit here is new unapproved copy, however small, so it
 * needs owner sign-off before it ships. `guaranteeCancellationEmail.test.ts`
 * pins it character-for-character so a well-meaning tidy-up fails loudly.
 *
 * TWO SUBSTITUTIONS, AND ONE OF THEM COSTS A ROUND TRIP. The order reference
 * we hold. The customer's first name we deliberately DO NOT: criterion 97
 * keeps the shipping address — first name included — at Shopify rather than
 * duplicating it into a table we would then have to secure, retain and
 * redact. So the name is read from the draft order at send time (criterion
 * 99's "reads it from Shopify at the time"), best-effort.
 *
 * WHEN THE NAME CANNOT BE READ, the greeting falls back to "Hi there,".
 * OWNER-APPROVED 2026-09-22 alongside the dynamic form: both greetings are
 * approved copy, and both are pinned.
 *
 * The owner ruled the mechanism too, not only the words. The first name is
 * NEVER persisted for personalisation, and a failure to retrieve it must
 * neither delay nor reverse a cancellation. Holding the cancellation until
 * Shopify answers would make a withdrawn price contingent on an unrelated
 * outage; storing the name would re-duplicate exactly the PII criterion 98
 * argued down to a single field.
 */

export interface GuaranteeCancellationEmailInput {
  /** Printed as the order reference the customer can quote back to us. */
  bankPaymentOrderId: string;
  /**
   * Read from the Shopify draft order at send time, or `null` when it could
   * not be read — a deleted draft, an API failure, or an order placed with no
   * first name at all. Never sourced from our own tables, which do not hold it.
   */
  customerFirstName: string | null;
}

export interface GuaranteeCancellationEmailContent {
  subject: string;
  text: string;
}

/**
 * The approved fallback greeting name, giving "Hi there,". Used only when
 * Shopify cannot supply the first name. Owner-approved 2026-09-22.
 */
export const APPROVED_FALLBACK_GREETING_NAME = "there";

export const PINNED = {
  subject: "An update on your CaratForUs Bank Payment order",
  body: (greetingName: string, orderReference: string): string =>
    [
      `Hi ${greetingName},`,
      "",
      `We’re writing to let you know that your CaratForUs Bank Payment order ${orderReference} has been canceled.`,
      "",
      "When you placed your order, your Bank Payment Price was guaranteed for 24 hours. Because payment was not received and verified within that guarantee period, and the price of your order changed after the 24-hour window expired, we’re no longer able to honor the original quoted price.",
      "",
      "Rather than automatically changing your order to a different price, we canceled it so you can review the current price and decide whether you’d like to place a new order.",
      "",
      "No payment has been processed by CaratForUs for this order.",
      "",
      "If you already sent a bank payment, please reply to this email and we’ll review it for you.",
      "",
      "You’re welcome to place a new order at the current price at any time. If you have any questions, simply reply to this email and we’ll be happy to help.",
      "",
      "Thank you,",
      "CaratForUs Customer Care",
      "orders@caratforus.com",
    ].join("\n"),
} as const;

export function buildGuaranteeCancellationEmail(
  input: GuaranteeCancellationEmailInput
): GuaranteeCancellationEmailContent {
  const trimmed = input.customerFirstName?.trim();
  return {
    subject: PINNED.subject,
    text: PINNED.body(trimmed && trimmed.length > 0 ? trimmed : APPROVED_FALLBACK_GREETING_NAME, input.bankPaymentOrderId),
  };
}
