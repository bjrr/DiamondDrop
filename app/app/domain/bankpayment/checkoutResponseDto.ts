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

/**
 * THE PERSISTED SHAPE — what `executeIdempotent` stores as `resultPayload`.
 *
 * D12/D15 (2026-10-24): `invoiceUrl` was removed (Buy Now no longer sends a
 * Shopify invoice or redirects to one) and `formattedAmountDue` added. Nothing
 * in this type may EVER carry a payment coordinate (Zelle recipient, wire
 * details): this object is written to Postgres and replayed verbatim.
 * Coordinates reach the customer only through `BankCheckoutResponseDto`,
 * which is built per request and never persisted.
 */
export interface BankCheckoutResultDto {
  readonly bankPaymentOrderId: string;
  readonly draftOrderGid: string;
  /** ISO-8601. The instant the 24-hour guarantee starts counting from. */
  readonly quotedAt: string;
  /** ISO-8601. `quotedAt` + 24 hours. */
  readonly guaranteeExpiresAt: string;
  /** e.g. "1062.00 USD" — sum of CHARGED unit price x quantity. Not secret. */
  readonly formattedAmountDue: string;
  readonly lines: readonly BankCheckoutLineResultDto[];
}

/** The customer-facing success body: the persisted result plus the Zelle recipient, never stored. */
export interface BankCheckoutResponseDto {
  readonly bankPaymentOrderId: string;
  readonly draftOrderGid: string;
  readonly quotedAt: string;
  readonly guaranteeExpiresAt: string;
  readonly formattedAmountDue: string;
  readonly lines: readonly BankCheckoutLineResultDto[];
  readonly paymentInstructions: { readonly zelleRecipient: string };
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
  formattedAmountDue: string;
  lines: readonly QuotedLineForResult[];
}): BankCheckoutResultDto {
  return {
    bankPaymentOrderId: input.bankPaymentOrderId,
    draftOrderGid: input.draftOrderGid,
    quotedAt: input.quotedAt.toISOString(),
    guaranteeExpiresAt: input.guaranteeExpiresAt.toISOString(),
    formattedAmountDue: input.formattedAmountDue,
    lines: input.lines.map(buildBankCheckoutLineResultDto),
  };
}

/**
 * What a stored `resultPayload` may look like when read back. Payloads
 * written before D12/D15 have `invoiceUrl` and no `formattedAmountDue`; a
 * replay of one must neither crash nor leak the invoice URL.
 */
export type StoredBankCheckoutResult = BankCheckoutResultDto | (Omit<BankCheckoutResultDto, "formattedAmountDue"> & {
  readonly formattedAmountDue?: undefined;
  readonly invoiceUrl?: unknown;
});

/**
 * Minimal decimal formatting of a minor-unit bigint ("106200n" -> "1062.00").
 * Integer arithmetic only. Duplicates `minorUnitsToDecimalString` from the
 * Shopify price adapter so this pure domain module stays free of adapter
 * imports; the route uses the adapter's helper for fresh results and this
 * only serves the old-payload recompute path (both are exact for USD's two
 * minor-unit digits, which is every currency this storefront sells in).
 */
function decimalFromMinorUnits(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${cents}`;
}

/**
 * OLD-PAYLOAD REPLAY POLICY (design choice, 2026-10-24): RECOMPUTE, don't omit.
 * If a stored result lacks `formattedAmountDue`, derive it from the stored
 * lines using the same rule as a fresh checkout — the CHARGED unit price
 * (Bank Payment Price if `eligibleAtQuoteTime`, else Regular/Card Price)
 * times quantity, summed as BigInt — so the customer still gets a working
 * Zelle panel on a resubmission. Returns `null` (caller omits nothing; the
 * theme then shows its existing "unavailable" message) if the lines are
 * unusable.
 */
export function resolveFormattedAmountDue(stored: StoredBankCheckoutResult): string | null {
  if (typeof stored.formattedAmountDue === "string" && stored.formattedAmountDue.length > 0) {
    return stored.formattedAmountDue;
  }
  const lines = stored.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  try {
    let total = 0n;
    const currency = lines[0]!.currency;
    for (const line of lines) {
      if (line.currency !== currency) return null;
      const unit = BigInt(line.eligibleAtQuoteTime ? line.quotedBankPaymentPriceMinorUnits : line.quotedRegularCardPriceMinorUnits);
      total += unit * BigInt(line.quantity);
    }
    return `${decimalFromMinorUnits(total)} ${currency}`;
  } catch {
    return null;
  }
}

/**
 * THE ONLY WAY a Bank Payment Checkout HTTP success body may be produced.
 * Field-by-field, NO SPREAD: a stored payload (possibly an old one carrying
 * `invoiceUrl`) is never copied wholesale, so a stale or unexpected key can
 * never reach the customer. The Zelle recipient is supplied per request from
 * the environment and is never part of anything persisted.
 *
 * Returns `null` when an amount due cannot be determined (see
 * `resolveFormattedAmountDue`).
 */
export function buildBankCheckoutResponseDto(
  result: StoredBankCheckoutResult,
  payment: { zelleRecipient: string }
): BankCheckoutResponseDto | null {
  const formattedAmountDue = resolveFormattedAmountDue(result);
  if (formattedAmountDue === null) return null;
  return {
    bankPaymentOrderId: result.bankPaymentOrderId,
    draftOrderGid: result.draftOrderGid,
    quotedAt: result.quotedAt,
    guaranteeExpiresAt: result.guaranteeExpiresAt,
    formattedAmountDue,
    lines: result.lines.map((line) => ({
      shopifyVariantId: line.shopifyVariantId,
      quantity: line.quantity,
      quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
      quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
      currency: line.currency,
      eligibleAtQuoteTime: line.eligibleAtQuoteTime,
    })),
    paymentInstructions: { zelleRecipient: payment.zelleRecipient },
  };
}
