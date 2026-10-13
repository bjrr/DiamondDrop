import { hashCanonicalJson } from "~/domain/evidence/hash";

/**
 * The Bank Payment Checkout idempotency key (Slice 2C, criteria 75/105/106).
 *
 * KEYED ON THE RESOLVED CUSTOMER EMAIL + MODE + A CONTENT HASH OF THE
 * SERVER-RECOMPUTED LINES — explicitly NOT the Shopify cart token, which can
 * rotate and would let two submissions either side of a rotation produce two
 * draft orders and two invoices for one customer (spec §14 C2C-4).
 *
 * WHY THE LINES ARE THE SERVER'S RECOMPUTED VALUES, NOT THE REQUEST BODY'S.
 * The request body only names which variants and how many; criterion 72
 * requires every price to be re-resolved server-side. Hashing the resolved
 * unit prices (not the raw request) means a genuine double-submit seconds
 * apart — where the published price has not moved — collapses to one key,
 * while two submissions that straddle a real price change are treated as two
 * distinct checkout attempts rather than silently reusing a stale quote.
 * That is a deliberate reading of criterion 105's "content hash of the
 * recomputed lines", not an accident of using whatever was easiest to hash.
 *
 * WHY THE SHIPPING ADDRESS IS NOT IN THE KEY. Criterion 105 names email, mode
 * and the line hash only, and criterion 97 forbids persisting the address at
 * all — hashing a value never stored anywhere as a DB row would make the key
 * itself the only surviving record of what was submitted, which the same
 * criterion exists to prevent. The accepted residual (a lone corrected
 * address, same email/lines, colliding with a prior failed key) is described
 * in the route's own doc comment.
 */

export interface IdempotencyKeyLine {
  readonly shopifyVariantGid: string;
  readonly quantity: number;
  /** Decimal string minor units — the unit price actually resolved for this line (bank or card, per §18). */
  readonly unitPriceMinorUnits: string;
  readonly currency: string;
}

const KEY_PREFIX = "bank_checkout";

/**
 * Sorted by `shopifyVariantGid` before hashing so the key is stable
 * regardless of the order lines arrived in the request or were coalesced —
 * `coalesceCheckoutLines` makes no ordering promise, and this function must
 * not depend on one.
 */
export function computeBankCheckoutIdempotencyKey(
  resolvedEmail: string,
  mode: "bank",
  lines: readonly IdempotencyKeyLine[]
): string {
  const sortedLines = [...lines].sort((a, b) =>
    a.shopifyVariantGid < b.shopifyVariantGid ? -1 : a.shopifyVariantGid > b.shopifyVariantGid ? 1 : 0
  );

  const hash = hashCanonicalJson({
    resolvedEmail,
    mode,
    lines: sortedLines.map((line) => ({
      shopifyVariantGid: line.shopifyVariantGid,
      quantity: line.quantity,
      unitPriceMinorUnits: line.unitPriceMinorUnits,
      currency: line.currency,
    })),
  });

  return `${KEY_PREFIX}:${hash}`;
}
