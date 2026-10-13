import type { BankPaymentCoordinates } from "~/lib/payments/bankPaymentCoordinates.server";

/**
 * The Group Buy Bank Payment instructions email — what unblocks the storefront
 * sentence "We'll email you payment instructions." (§1.5, owner-approved
 * 2026-09-29 *conditional on this existing*, which is why it now does).
 *
 * ============================================================================
 * METHODS: ZELLE AND DOMESTIC WIRE, AND ONLY THOSE
 * ============================================================================
 * Owner decision 2026-09-29. Locked policy permits ACH and bank transfer too,
 * but "the policy may allow it, we do not need to expose every allowed method
 * at launch". Adding a method here is a customer-facing product decision, not
 * a formatting change.
 *
 * ============================================================================
 * THE TIMING SENTENCES ARE NOT NEW COPY
 * ============================================================================
 * The 48-hour window, the single automatic 48-hour extension, immediate
 * progress counting and the locked price are restatements of locked policy
 * already vetted in §1.5 of `STOREFRONT-COPY-DECISIONS.md`. They are repeated
 * here verbatim rather than paraphrased, so the page and the email cannot
 * drift into saying two different things about the same deadline.
 *
 * THE DEADLINE IS PASSED IN, NEVER COMPUTED HERE. It comes from
 * `groupBuyInitialPaymentDeadline` applied to the order's own window start, so
 * the email cannot disagree with the sweep that will actually inactivate the
 * order. A second implementation of "when is this due" is the same class of
 * mistake as a second refund formula.
 *
 * ============================================================================
 * PAYMENT IS NOT VERIFIED BY SENDING IT
 * ============================================================================
 * Locked: a Group Buy Bank Payment order stays unverified until staff confirm
 * receipt. The email says so plainly rather than implying that following the
 * instructions completes the purchase.
 *
 * COORDINATES ARE PASSED IN, NEVER READ HERE. This module is pure and has no
 * access to the environment; `bankPaymentCoordinates.server.ts` is the only
 * reader, and it fails closed. That separation is what makes it possible to
 * unit-test this text with obviously-fake coordinates and still be certain the
 * real ones can never be logged from here.
 */

export interface GroupBuyPaymentInstructionsEmailInput {
  /** The reference a customer quotes back to us. */
  bankPaymentOrderId: string;
  /** Campaign code, so a customer with more than one order can tell them apart. */
  campaignCode: string;
  /** Pre-formatted, e.g. "$1,062.00". Formatted by the caller from minor units — never computed here. */
  formattedAmountDue: string;
  /** From `groupBuyInitialPaymentDeadline(resolveGroupBuyPaymentWindowStart(order))` — the 48-hour CUSTOMER deadline, never the 96-hour inactivation instant. */
  paymentDeadline: Date;
  coordinates: BankPaymentCoordinates;
}

export interface GroupBuyPaymentInstructionsEmailContent {
  subject: string;
  text: string;
}

/** UTC, spelled out, with the zone named. A bare local time in an email is a time in someone else's day. */
function formatDeadline(deadline: Date): string {
  const iso = deadline.toISOString();
  const [date, rest] = iso.split("T");
  const hhmm = rest!.slice(0, 5);
  return `${date} ${hhmm} UTC`;
}

export function buildGroupBuyPaymentInstructionsEmail(
  input: GroupBuyPaymentInstructionsEmailInput
): GroupBuyPaymentInstructionsEmailContent {
  const { zelle, wire } = input.coordinates;

  return {
    subject: `Payment instructions for your Group Buy order (${input.bankPaymentOrderId})`,
    text: [
      "Hi there,",
      "",
      `Thank you for your Group Buy order on campaign ${input.campaignCode}.`,
      "",
      `Amount due: ${input.formattedAmountDue}`,
      `Order reference: ${input.bankPaymentOrderId}`,
      `Please send payment by: ${formatDeadline(input.paymentDeadline)}`,
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
      // Locked timing, verbatim from the approved §1.5 storefront copy so the
      // page and this email can never disagree about the same deadline.
      "You have 48 hours to send payment; if you need longer we’ll automatically extend it once, by a further 48 hours.",
      "",
      "Your order counts toward the group’s progress straight away, and your price is locked from the moment you order.",
      "",
      "If payment hasn’t arrived after 96 hours we’ll set your order aside. While the campaign is still open you can email us to reactivate it — same order, same locked price.",
      "",
      "Your payment is not confirmed until we receive it and verify it. We’ll email you once that is done.",
      "",
      "CaratForUs",
    ].join("\n"),
  };
}
