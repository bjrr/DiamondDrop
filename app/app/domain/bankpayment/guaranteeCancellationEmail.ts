/**
 * The customer-facing cancellation email content (criterion 80, §13/D22).
 * PURE — no I/O, no clock; every fact printed was already resolved by the
 * caller (`~/jobs/bankpayment/guaranteeSweep.server.ts`).
 *
 * ==========================================================================
 * THIS WORDING IS NOT OWNER-APPROVED. READ BEFORE SHIPPING.
 * ==========================================================================
 * `docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md`'s status table lists
 * "Customer-facing copy — Not approved" as a blocker for phase 2C-c (the
 * checkout/email disclosures). This is a DIFFERENT email — the guarantee
 * -expiry cancellation notice, owned by 2C-b/criterion 80 — but it is just
 * as materially customer-facing, and nobody has signed off on its exact
 * wording the way `app/theme/ownerApprovedCopy.test.ts` pins the cart
 * strings.
 *
 * This copy is deliberately minimal and factual — no marketing language, no
 * dollar figures (a specific new price is exactly the kind of "material
 * pricing communication" `CLAUDE.md` says must not be invented), and no
 * forbidden terminology (`cash`, `card fee`, `surcharge` — see
 * `ownerApprovedCopy.test.ts`'s own prohibition sweep). It states only that
 * the quoted price is no longer available, the order was cancelled with
 * nothing charged, and how to reach support or reorder.
 *
 * ARCHITECT / OWNER REVIEW REQUIRED before this ships to a real customer.
 * If the wording changes, update `PINNED` below in the same commit — same
 * discipline as `ownerApprovedCopy.test.ts`.
 */

export interface GuaranteeCancellationEmailInput {
  /** `bank_payment_order.id` — the only reference a customer received at quote time (`BankCheckoutResultDto.bankPaymentOrderId`). */
  bankPaymentOrderId: string;
  customerEmail: string;
}

export interface GuaranteeCancellationEmailContent {
  subject: string;
  text: string;
}

/** Not owner-approved — see the module doc comment. Kept as a single named constant so a future approval is a one-line diff against a visible string, not a rewrite spread across this file. */
export const PINNED = {
  subject: "Your CaratForUs Bank Payment order has been cancelled",
  body: (orderReference: string): string =>
    [
      `Order reference: ${orderReference}`,
      "",
      "The Bank Payment price quoted for this order was guaranteed for 24 hours. " +
        "That guarantee has now expired, the price has since changed, and no payment " +
        "was received in time, so this order has been cancelled.",
      "",
      "Nothing was charged to you.",
      "",
      "You're welcome to place a new order at the current price, or reply to this " +
        "email if you have any questions.",
    ].join("\n"),
} as const;

export function buildGuaranteeCancellationEmail(
  input: GuaranteeCancellationEmailInput
): GuaranteeCancellationEmailContent {
  return {
    subject: PINNED.subject,
    text: PINNED.body(input.bankPaymentOrderId),
  };
}
