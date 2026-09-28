import { groupBuyPaymentWindowDeadline } from "./groupBuyPaymentWindow";

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
  /** ISO-8601. `quotedAt` + 96 hours — see `groupBuyPaymentWindowDeadline`. */
  readonly paymentDueBy: string;
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
    paymentDueBy: groupBuyPaymentWindowDeadline(input.quotedAt).toISOString(),
    lines: input.lines.map(buildGroupBuyBankCheckoutLineResultDto),
  };
}
