import { groupBuyInitialPaymentDeadline } from "./groupBuyPaymentWindow";
import type { PaymentInstructionsView } from "./paymentInstructionsView";

/**
 * The Group Buy Bank Payment Checkout response contract.
 *
 * SAME FENCE DISCIPLINE AS `~/domain/bankpayment/checkoutResponseDto.ts`
 * (ruling R10), deliberately repeated rather than shared: every field that
 * reaches the caller is named explicitly below, by hand, with NO SPREAD
 * OPERATOR anywhere in this file. This is the one place a frozen landed
 * cost, margin figure, or the campaign's internal frozen-base price could
 * leak into a customer-facing payload by a caller reaching for `...line`
 * out of habit — this module exists so that cannot compile.
 *
 * ALSO NEVER CARRIES THE SHIPPING ADDRESS, for the identical reason
 * `checkoutResponseDto.ts` never does (docs/REQUIRED-CUSTOMER-ACCOUNTS.md).
 *
 * MONEY AS STRINGS — every bigint crosses to JSON as a decimal string via
 * `.toString()`, never widened to a JS `number`.
 *
 * THIS SAME SHAPE IS WHAT `executeIdempotent` PERSISTS AS `resultPayload`
 * and returns verbatim on a replay, so it must be fully JSON-safe with no
 * field whose meaning depends on when it is read — every date below is an
 * ISO-8601 string, not a `Date`.
 */

export interface GroupBuyBankCheckoutLineResultDto {
  readonly shopifyVariantId: string;
  readonly quantity: number;
  readonly quotedBankPaymentPriceMinorUnits: string;
  readonly quotedRegularCardPriceMinorUnits: string;
  readonly currency: string;
}

export interface GroupBuyBankCheckoutResultDto {
  readonly groupBuyBankPaymentOrderId: string;
  readonly campaignId: string;
  readonly campaignCode: string;
  readonly draftOrderGid: string;
  readonly shopifyOrderGid: string;
  readonly tierNumber: number;
  /** ISO-8601. The instant this order's 48h+48h payment window starts counting from. */
  readonly quotedAt: string;
  /**
   * ISO-8601. `quotedAt` + 48 HOURS — the deadline the CUSTOMER is given,
   * matching the locked sentence "You have 48 hours to send payment" and the
   * date in the instructions email.
   *
   * THIS WAS `quotedAt` + 96 HOURS AND THAT WAS WRONG FOR A CUSTOMER-FACING
   * FIELD. 96 hours is the INACTIVATION instant — when the sweep may set an
   * unpaid order aside, after the one automatic extension. It is internal
   * lifecycle timing, not a promise. A field literally named "payment due by",
   * returned to the customer browser, carrying an enforcement deadline four
   * days out, would have contradicted the email the moment any surface
   * rendered it. Nothing rendered it yet, which is the only reason no customer
   * saw two different dates.
   */
  readonly paymentDueBy: string;
  /** e.g. "4080.00" — sum of the bank unit price x quantity. Not secret. */
  readonly formattedAmountDue: string;
  readonly lines: readonly GroupBuyBankCheckoutLineResultDto[];
}

export interface QuotedGroupBuyLineForResult {
  readonly shopifyVariantGid: string;
  readonly quantity: number;
  readonly quotedBankPaymentPriceMinorUnits: bigint;
  readonly quotedRegularCardPriceMinorUnits: bigint;
  readonly currency: string;
}

/** Builds exactly one line's result DTO. Every field is copied by name — no spread. */
export function buildGroupBuyBankCheckoutLineResultDto(
  line: QuotedGroupBuyLineForResult
): GroupBuyBankCheckoutLineResultDto {
  return {
    shopifyVariantId: line.shopifyVariantGid,
    quantity: line.quantity,
    quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits.toString(),
    quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits.toString(),
    currency: line.currency,
  };
}

/**
 * Assembles the full result/response DTO. THE ONLY WAY a Group Buy Bank
 * Payment Checkout success body may be produced — the route must pass this
 * function's return value directly to `Response.json` (or store it verbatim
 * as the idempotent operation's result), with no property added afterward.
 */
export function buildGroupBuyBankCheckoutResultDto(input: {
  groupBuyBankPaymentOrderId: string;
  campaignId: string;
  campaignCode: string;
  draftOrderGid: string;
  shopifyOrderGid: string;
  tierNumber: number;
  quotedAt: Date;
  formattedAmountDue: string;
  lines: readonly QuotedGroupBuyLineForResult[];
}): GroupBuyBankCheckoutResultDto {
  return {
    groupBuyBankPaymentOrderId: input.groupBuyBankPaymentOrderId,
    campaignId: input.campaignId,
    campaignCode: input.campaignCode,
    draftOrderGid: input.draftOrderGid,
    shopifyOrderGid: input.shopifyOrderGid,
    tierNumber: input.tierNumber,
    quotedAt: input.quotedAt.toISOString(),
    paymentDueBy: groupBuyInitialPaymentDeadline(input.quotedAt).toISOString(),
    formattedAmountDue: input.formattedAmountDue,
    lines: input.lines.map(buildGroupBuyBankCheckoutLineResultDto),
  };
}

/**
 * THE CUSTOMER RESPONSE ENVELOPE — what the browser actually receives
 * (register D12). Exactly the split `checkoutResponseDto.ts` documents for
 * Buy Now, repeated here deliberately rather than shared:
 *
 *   `GroupBuyBankCheckoutResultDto`  persisted in
 *                            `IdempotencyKey.resultPayload`. Non-secret
 *                            transaction state only. Carries
 *                            `draftOrderGid`/`shopifyOrderGid` because
 *                            replay and staff reconciliation need them.
 *
 *   `GroupBuyBankCheckoutCustomerResponse`  never persisted. Drops the
 *                            Shopify internals and adds the payment
 *                            instructions, which carry bank coordinates and
 *                            therefore cannot be allowed anywhere near the
 *                            stored payload.
 *
 * BOTH Shopify handles are removed, not just the draft. A Group Buy Bank
 * Payment order IS a real Shopify order — unlike Buy Now's staff-held draft
 * — so `shopifyOrderGid` is a live handle to a real, unpaid, participation
 * -counting order. There is no customer action it enables that we want to
 * exist, and the customer already has the only reference that matters:
 * `groupBuyBankPaymentOrderId`, the one staff match payments against.
 *
 * `campaignId` goes too. It is an internal primary key; `campaignCode` is
 * the customer-facing identifier and is kept.
 */
export interface GroupBuyBankCheckoutCustomerResponse {
  readonly groupBuyBankPaymentOrderId: string;
  readonly campaignCode: string;
  readonly tierNumber: number;
  readonly quotedAt: string;
  readonly paymentDueBy: string;
  readonly lines: readonly GroupBuyBankCheckoutLineResultDto[];
  readonly instructions: PaymentInstructionsView;
}

export function toGroupBuyCustomerResponse(
  result: GroupBuyBankCheckoutResultDto,
  instructions: PaymentInstructionsView
): GroupBuyBankCheckoutCustomerResponse {
  // Named field by field, NO SPREAD — the same fence discipline this module
  // applies to the persisted DTO. A spread here would silently reintroduce
  // both Shopify handles the moment anyone adds a field upstream.
  return {
    groupBuyBankPaymentOrderId: result.groupBuyBankPaymentOrderId,
    campaignCode: result.campaignCode,
    tierNumber: result.tierNumber,
    quotedAt: result.quotedAt,
    paymentDueBy: result.paymentDueBy,
    lines: result.lines,
    instructions,
  };
}

/**
 * What a stored `resultPayload` may look like when read back. Payloads
 * written before D12 have no `formattedAmountDue`; a replay of one must
 * neither crash nor leave the customer without an amount.
 */
export type StoredGroupBuyBankCheckoutResult =
  | GroupBuyBankCheckoutResultDto
  | (Omit<GroupBuyBankCheckoutResultDto, "formattedAmountDue"> & {
      readonly formattedAmountDue?: undefined;
    });

/**
 * OLD-PAYLOAD REPLAY POLICY: RECOMPUTE, don't omit — the same choice
 * `checkoutResponseDto.ts` makes and for the same reason, so a customer
 * resubmitting an old request still gets a working instructions panel
 * rather than a blank amount.
 *
 * SIMPLER THAN BUY NOW'S ON PURPOSE. Every line of a Group Buy Bank Payment
 * order is charged at its Bank Payment Price — there is no per-line
 * eligibility flag to honour, because the whole order is one payment basis
 * decided at placement. Buy Now's version must pick between bank and card
 * per line; this one must not, and conflating them would silently charge a
 * Group Buy customer the card price.
 *
 * Returns `null` if the lines are unusable; the caller then fails closed
 * rather than inventing a figure.
 */
export function resolveGroupBuyFormattedAmountDue(
  stored: StoredGroupBuyBankCheckoutResult
): string | null {
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
      total += BigInt(line.quotedBankPaymentPriceMinorUnits) * BigInt(line.quantity);
    }
    return decimalFromMinorUnits(total);
  } catch {
    return null;
  }
}

/**
 * Minor-unit bigint to a decimal string ("408000n" -> "4080.00"). Integer
 * arithmetic only — duplicated from `checkoutResponseDto.ts` so this pure
 * domain module stays free of adapter imports, exactly as that file's own
 * copy explains.
 */
function decimalFromMinorUnits(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${cents}`;
}
