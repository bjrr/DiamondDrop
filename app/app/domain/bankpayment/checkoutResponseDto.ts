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
 * repeat returns the stored draft order and sends no second invoice") — so
 * it must be fully JSON-safe with no field whose meaning depends on when it
 * is read, which is also why every date below is an ISO-8601 string, not a
 * `Date`.
 */

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
  readonly invoiceUrl: string | null;
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
  invoiceUrl: string | null;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
  lines: readonly QuotedLineForResult[];
}): BankCheckoutResultDto {
  return {
    bankPaymentOrderId: input.bankPaymentOrderId,
    draftOrderGid: input.draftOrderGid,
    invoiceUrl: input.invoiceUrl,
    quotedAt: input.quotedAt.toISOString(),
    guaranteeExpiresAt: input.guaranteeExpiresAt.toISOString(),
    lines: input.lines.map(buildBankCheckoutLineResultDto),
  };
}
