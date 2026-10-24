/**
 * The Bank Payment Checkout response contract (Slice 2C task 2C-3).
 *
 * SAME FENCE DISCIPLINE AS `~/domain/cart/proxyResponseDto.ts` (ruling R10),
 * deliberately repeated rather than shared: every field that reaches the
 * caller is named explicitly below, by hand, with NO SPREAD OPERATOR
 * anywhere in this file. This is the one place a `priceCalculationId`,
 * `appliedUpliftRate`, `appliedTierLabel`, landed cost or margin figure
 * could leak into a customer-facing payload by a caller reaching for
 * `...quotedLine` out of habit — this module exists so that cannot compile.
 *
 * ALSO NEVER CARRIES THE SHIPPING ADDRESS (criteria 97-99). The address is
 * sent to Shopify at draft-order creation and never persisted or echoed back
 * by this app; the customer already knows what they just typed, so there is
 * no reason for this DTO to carry an address field at all.
 *
 * MONEY AS STRINGS. Every bigint crosses to JSON as a decimal string via
 * `.toString()` — `JSON.stringify` cannot serialize a bigint, and money in
 * this domain is never widened to a JS `number` (money-safety scan, Tier 2:
 * `app/domain/bankpayment/` is a scanned prefix).
 *
 * THIS SAME SHAPE IS WHAT `executeIdempotent` PERSISTS AS `resultPayload`
 * (Slice 0 spec §0.7) and returns verbatim on a replay (criterion 75: "a
 * repeat returns the stored draft order") — so it must be fully JSON-safe
 * with no field whose meaning depends on when it is read, which is also why
 * every date below is an ISO-8601 string, not a `Date`.
 *
 * AND THEREFORE IT CARRIES NO BANK COORDINATES. Because this shape is
 * persisted, adding a Zelle recipient or an account number to it would put
 * payment credentials in Postgres, which
 * `bankPaymentCoordinates.server.ts` forbids outright ("NOT PERSISTED,
 * EVER"). The customer still needs them, so they travel in
 * `BankCheckoutCustomerResponse` at the bottom of this file, composed after
 * the idempotent transaction and never stored.
 *
 * (Criterion 75 previously also read "and sends no second invoice". Bank
 * Payment no longer sends a Shopify invoice at all — register D15.)
 */

import type { PaymentInstructionsView } from "./paymentInstructionsView";

export interface BankCheckoutLineResultDto {
  readonly shopifyVariantId: string;
  readonly quantity: number;
  readonly quotedBankPaymentPriceMinorUnits: string;
  readonly quotedRegularCardPriceMinorUnits: string;
  readonly currency: string;
  readonly eligibleAtQuoteTime: boolean;
}

export interface BankCheckoutResultDto {
  readonly bankPaymentOrderId: string;
  readonly draftOrderGid: string;
  /**
   * NO `invoiceUrl`. DO NOT ADD ONE BACK (register D15).
   *
   * This DTO used to carry Shopify's draft-order invoice URL, and the
   * storefront navigated the customer straight to it. That invoice exposes a
   * **Confirm order** action, which let the customer advance a draft that is
   * supposed to stay staff-controlled until payment is verified — defeating
   * the one rule Buy Now's state machine exists to enforce.
   *
   * Shopify may still mint an invoice URL on the draft internally; staff can
   * reach it in Admin. It is simply not part of the customer contract, and
   * `bankCheckoutInvoiceFence.test.ts` fails if a usable one reappears here.
   */

  /** ISO-8601. The instant the 24-hour guarantee starts counting from. */
  readonly quotedAt: string;
  /** ISO-8601. `quotedAt` + 24 hours. */
  readonly guaranteeExpiresAt: string;
  readonly lines: readonly BankCheckoutLineResultDto[];
}

export interface QuotedLineForResult {
  readonly shopifyVariantGid: string;
  readonly quantity: number;
  readonly quotedBankPaymentPriceMinorUnits: bigint;
  readonly quotedRegularCardPriceMinorUnits: bigint;
  readonly currency: string;
  readonly eligibleAtQuoteTime: boolean;
}

/** Builds exactly one line's result DTO. Every field is copied by name — no spread. */
export function buildBankCheckoutLineResultDto(line: QuotedLineForResult): BankCheckoutLineResultDto {
  return {
    shopifyVariantId: line.shopifyVariantGid,
    quantity: line.quantity,
    quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits.toString(),
    quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits.toString(),
    currency: line.currency,
    eligibleAtQuoteTime: line.eligibleAtQuoteTime,
  };
}

/**
 * Assembles the full result/response DTO. THE ONLY WAY a Bank Payment
 * Checkout success body may be produced — the route must pass this
 * function's return value directly to `Response.json` (or store it
 * verbatim as the idempotent operation's result), with no property added
 * afterward.
 */
export function buildBankCheckoutResultDto(input: {
  bankPaymentOrderId: string;
  draftOrderGid: string;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
  lines: readonly QuotedLineForResult[];
}): BankCheckoutResultDto {
  return {
    bankPaymentOrderId: input.bankPaymentOrderId,
    draftOrderGid: input.draftOrderGid,
    quotedAt: input.quotedAt.toISOString(),
    guaranteeExpiresAt: input.guaranteeExpiresAt.toISOString(),
    lines: input.lines.map(buildBankCheckoutLineResultDto),
  };
}

/**
 * THE CUSTOMER RESPONSE ENVELOPE — what the browser actually receives.
 *
 * Two different audiences, deliberately split:
 *
 *   `BankCheckoutResultDto`  persisted in `IdempotencyKey.resultPayload`.
 *                            Non-secret transaction state only. Carries
 *                            `draftOrderGid` because replay and staff
 *                            reconciliation need it.
 *
 *   `BankCheckoutCustomerResponse`  never persisted. Drops the Shopify
 *                            internals and adds the payment instructions,
 *                            which carry bank coordinates and therefore
 *                            cannot be allowed anywhere near the stored
 *                            payload.
 *
 * `draftOrderGid` is removed rather than passed through: it is an internal
 * Shopify handle, and the customer having it is how D15 started. There is no
 * customer action it enables that we want to exist.
 */
export interface BankCheckoutCustomerResponse {
  readonly bankPaymentOrderId: string;
  readonly quotedAt: string;
  readonly guaranteeExpiresAt: string;
  readonly lines: readonly BankCheckoutLineResultDto[];
  readonly instructions: PaymentInstructionsView;
}

export function toCustomerResponse(
  result: BankCheckoutResultDto,
  instructions: PaymentInstructionsView
): BankCheckoutCustomerResponse {
  // Named field by field, no spread — the same fence discipline this module
  // applies to the persisted DTO. A spread here would silently reintroduce
  // `draftOrderGid` the moment anyone adds a field upstream.
  return {
    bankPaymentOrderId: result.bankPaymentOrderId,
    quotedAt: result.quotedAt,
    guaranteeExpiresAt: result.guaranteeExpiresAt,
    lines: result.lines,
    instructions,
  };
}
