import { hashCanonicalJson } from "~/domain/evidence/hash";

/**
 * The Group Buy Bank Payment Checkout idempotency key. Mirrors
 * `~/domain/bankpayment/idempotencyKey.ts`'s `computeBankCheckoutIdempotencyKey`
 * exactly in spirit — deliberately restated, not shared, because the two
 * checkout flows must never collapse into one key space (a Buy Now and a
 * Group Buy checkout for the same customer/variant/price must never be
 * treated as the same idempotent operation).
 *
 * KEYED ON THE AUTHENTICATED CUSTOMER GID, THE CAMPAIGN, AND A CONTENT HASH
 * OF THE SERVER-RESOLVED LINES. The customer gid (not the request body's
 * email, which is presentation contact info only — see
 * docs/REQUIRED-CUSTOMER-ACCOUNTS.md) is the authorization basis, so it is
 * also the right identity to dedupe a resubmission against. The campaign id
 * is included because a customer could plausibly have two genuinely distinct
 * in-flight Group Buy checkouts (two different campaigns) at once, and those
 * must never collide into one key.
 *
 * THE LINES ARE THE SERVER'S RESOLVED PRICES, not the raw request — the
 * request only names which variants and how many; every unit price is
 * re-resolved server-side from the campaign's frozen basis and current tier.
 * Hashing the resolved price means a genuine double-submit seconds apart
 * (same tier, same price) collapses to one key, while two submissions that
 * straddle a real tier change are treated as distinct attempts rather than
 * silently reusing a stale quote.
 */

export interface GroupBuyCheckoutIdempotencyKeyLine {
  readonly shopifyVariantGid: string;
  readonly quantity: number;
  /** Decimal string minor units — the Bank Payment Price actually resolved for this line at the current tier. */
  readonly unitPriceMinorUnits: string;
  readonly currency: string;
}

const KEY_PREFIX = "group_buy_bank_checkout";

/**
 * Sorted by `shopifyVariantGid` before hashing so the key is stable
 * regardless of request/coalescing order.
 */
export function computeGroupBuyBankCheckoutIdempotencyKey(
  customerGid: string,
  campaignId: string,
  lines: readonly GroupBuyCheckoutIdempotencyKeyLine[]
): string {
  const sortedLines = [...lines].sort((a, b) =>
    a.shopifyVariantGid < b.shopifyVariantGid ? -1 : a.shopifyVariantGid > b.shopifyVariantGid ? 1 : 0
  );

  const hash = hashCanonicalJson({
    customerGid,
    campaignId,
    lines: sortedLines.map((line) => ({
      shopifyVariantGid: line.shopifyVariantGid,
      quantity: line.quantity,
      unitPriceMinorUnits: line.unitPriceMinorUnits,
      currency: line.currency,
    })),
  });

  return `${KEY_PREFIX}:${hash}`;
}
