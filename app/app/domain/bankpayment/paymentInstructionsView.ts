import type { BankPaymentCoordinates } from "~/lib/payments/bankPaymentCoordinates.server";

/**
 * THE CUSTOMER-FACING PAYMENT INSTRUCTIONS, COMPOSED ONCE.
 *
 * Every surface that tells a customer how to pay by bank builds it here: the
 * Buy Now confirmation, the Group Buy confirmation, and the authenticated
 * retrieval page. The instructions email has its own builder because it is
 * prose in a different medium, but the facts it states come from the same
 * order state and the same coordinate resolver.
 *
 * ============================================================================
 * THIS OBJECT IS NEVER PERSISTED. NOT ANYWHERE.
 * ============================================================================
 * It carries bank coordinates, and `bankPaymentCoordinates.server.ts` says
 * "NOT PERSISTED, EVER" for a reason: a copy in Postgres is a second place to
 * secure, retain and eventually redact.
 *
 * Concretely, this value must never reach:
 *   - `IdempotencyKey.resultPayload` — which is why the checkout result DTOs
 *     stay coordinate-free and this envelope is composed AFTER
 *     `executeIdempotent` returns, not inside it;
 *   - a Snapshot, an AuditEvent, a Shopify note or tag;
 *   - any log line, at any level.
 *
 * The durable half of a bank payment is the order: reference, quoted money,
 * deadline, status, customer identity. That is persisted. How to pay is
 * runtime configuration, resolved per request and thrown away.
 *
 * ============================================================================
 * PURE
 * ============================================================================
 * No database, no clock, no environment. Money arrives pre-formatted, exactly
 * as `groupBuyPaymentInstructionsEmail.ts` requires — the caller owns the
 * bigint-to-string conversion so no formatting decision is duplicated here.
 */

/** Which lifecycle the order belongs to. The two are deliberately not merged. */
export type BankPaymentFlow = "buy_now" | "group_buy";

/** Where CaratForUs answers payment questions. Matches the contact page and the FAQ. */
export const PAYMENT_SUPPORT_EMAIL = "orders@caratforus.com";

export interface PaymentInstructionsInput {
  readonly flow: BankPaymentFlow;
  /** The CaratForUs order id. The ONLY reference a customer is ever given. */
  readonly reference: string;
  /** Pre-formatted major units, e.g. "1062.00". Never computed here. */
  readonly formattedAmountDue: string;
  readonly currency: string;
  /** The customer-facing deadline. For Group Buy this is the INITIAL 48-hour one. */
  readonly paymentDeadline: Date;
  readonly coordinates: BankPaymentCoordinates;
}

export interface PaymentMethodZelle {
  readonly kind: "zelle";
  readonly recipient: string;
  /** What to type in the memo so staff can match the payment to the order. */
  readonly memo: string;
}

export interface PaymentMethodWire {
  readonly kind: "domestic_wire";
  readonly bankName: string;
  readonly accountName: string;
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly reference: string;
}

export interface PaymentInstructionsView {
  readonly flow: BankPaymentFlow;
  readonly reference: string;
  readonly formattedAmountDue: string;
  readonly currency: string;
  /** ISO-8601. */
  readonly paymentDeadline: string;
  readonly methods: readonly (PaymentMethodZelle | PaymentMethodWire)[];
  /** One sentence naming exactly what to include with the transfer. */
  readonly includeWithPayment: string;
  /** Why the money is still owed — never implies the order is settled. */
  readonly paymentStillRequired: string;
  /** Flow-specific commitment language. The two lifecycles differ materially. */
  readonly commitmentNotice: string;
  /** Group Buy only: the 48h + automatic 48h extension behaviour. */
  readonly extensionNotice: string | null;
  readonly supportEmail: string;
}

export function buildPaymentInstructionsView(
  input: PaymentInstructionsInput
): PaymentInstructionsView {
  const { zelle, wire } = input.coordinates;

  return {
    flow: input.flow,
    reference: input.reference,
    formattedAmountDue: input.formattedAmountDue,
    currency: input.currency,
    paymentDeadline: input.paymentDeadline.toISOString(),
    methods: [
      { kind: "zelle", recipient: zelle.recipient, memo: input.reference },
      {
        kind: "domestic_wire",
        bankName: wire.bankName,
        accountName: wire.accountName,
        routingNumber: wire.routingNumber,
        accountNumber: wire.accountNumber,
        reference: input.reference,
      },
    ],
    includeWithPayment:
      `Include your order reference ${input.reference} with the payment — in the Zelle memo, or as the wire reference. ` +
      `It is how we match your money to your order.`,
    paymentStillRequired:
      "Your payment has not been received yet. These instructions are how to send it.",
    // THE TWO LIFECYCLES SAY DIFFERENT THINGS BECAUSE THEY ARE DIFFERENT.
    //
    // Buy Now holds a staff-only draft: nothing is committed or reserved
    // until staff verify the funds. Group Buy already created a real unpaid
    // Shopify order, deliberately, because the unit must count toward the
    // campaign at placement. Telling a Group Buy customer their order "is not
    // created" would be false, and telling a Buy Now customer it is reserved
    // would be worse.
    commitmentNotice:
      input.flow === "buy_now"
        ? "Your order is not committed and your items are not reserved until your Bank Payment is received and verified."
        : "Your order already counts toward this campaign's progress, and your price is locked. It is not paid until we receive and verify your Bank Payment.",
    extensionNotice:
      input.flow === "group_buy"
        ? "You have 48 hours to send payment; if you need longer we’ll automatically extend it once, by a further 48 hours."
        : null,
    supportEmail: PAYMENT_SUPPORT_EMAIL,
  };
}
