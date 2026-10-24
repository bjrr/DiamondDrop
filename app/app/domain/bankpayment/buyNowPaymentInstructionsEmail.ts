import type { BankPaymentCoordinates } from "~/lib/payments/bankPaymentCoordinates.server";

/**
 * The Buy Now Bank Payment instructions email (D12, owner-approved 2026-10-24).
 *
 * WHY THIS EXISTS. Buy Now used to rely on Shopify's draft-order invoice to
 * carry payment instructions, and that invoice carried no payment coordinates
 * at all (D12). Worse, the invoice page offered a "Confirm order" button that
 * turned the draft into a real order with committed inventory before staff had
 * verified any payment (D15, CLAUDE.md #22). The invoice is gone; this email is
 * how the customer learns where to send money.
 *
 * Modelled on `groupBuyPaymentInstructionsEmail.ts`: same method list (Zelle
 * and domestic wire ONLY, owner decision 2026-09-29) and same structure.
 *
 * THE 24-HOUR GUARANTEE AND NOT-COMMITTED SENTENCES ARE OWNER-APPROVED
 * VERBATIM (2026-10-24). Do not reword them; a reworded material term is new
 * unapproved copy. The guarantee instant is passed in (it is the order's
 * persisted `guaranteeExpiresAt`), never computed here, so the email cannot
 * disagree with the sweep that enforces it.
 *
 * COORDINATES ARE PASSED IN, NEVER READ HERE. This module is pure and has no
 * access to the environment; `bankPaymentCoordinates.server.ts` is the only
 * reader. Nothing here logs.
 *
 * Nothing in this text mentions card pricing, fees or surcharges: the
 * customer is only ever told what to pay and when.
 */

export interface BuyNowPaymentInstructionsEmailInput {
  /** The reference a customer quotes back to us. */
  bankPaymentOrderId: string;
  /** Pre-formatted, e.g. "1062.00 USD". Formatted by the caller from minor units -- never computed here. */
  formattedAmountDue: string;
  /** The order's persisted `guaranteeExpiresAt` (quotedAt + 24 hours). */
  guaranteeExpiresAt: Date;
  coordinates: BankPaymentCoordinates;
}

export interface BuyNowPaymentInstructionsEmailContent {
  subject: string;
  text: string;
}

/** UTC, spelled out, with the zone named. Same formatter as the Group Buy email. */
function formatDeadline(deadline: Date): string {
  const iso = deadline.toISOString();
  const [date, rest] = iso.split("T");
  const hhmm = rest!.slice(0, 5);
  return `${date} ${hhmm} UTC`;
}

export function buildBuyNowPaymentInstructionsEmail(
  input: BuyNowPaymentInstructionsEmailInput
): BuyNowPaymentInstructionsEmailContent {
  const { zelle, wire } = input.coordinates;

  return {
    subject: `Payment instructions for your CaratForUs order (${input.bankPaymentOrderId})`,
    text: [
      "Hi there,",
      "",
      `Amount due: ${input.formattedAmountDue}`,
      `Order reference: ${input.bankPaymentOrderId}`,
      `Your Bank Payment Price is guaranteed until: ${formatDeadline(input.guaranteeExpiresAt)}`,
      "",
      "Choose ONE of the following methods and include your order reference:",
      "",
      "Zelle",
      `  Send to: ${zelle.recipient}`,
      `  Memo / note: ${input.bankPaymentOrderId}`,
      "",
      "Domestic bank wire",
      `  Bank name: ${wire.bankName}`,
      `  Account name: ${wire.accountName}`,
      `  Routing number: ${wire.routingNumber}`,
      `  Account number: ${wire.accountNumber}`,
      `  Reference: ${input.bankPaymentOrderId}`,
      "",
      // OWNER-APPROVED VERBATIM, 2026-10-24.
      "Your Bank Payment Price is guaranteed for 24 hours. After that, your order stays open only while the price is unchanged; if the price changes before your payment arrives, we’ll cancel the order and email you.",
      "",
      // OWNER-APPROVED VERBATIM, 2026-10-24.
      "Your order is not committed and availability is not guaranteed until your Bank Payment is received and verified. We’ll email you once that is done.",
      "",
      "CaratForUs",
    ].join("\n"),
  };
}
