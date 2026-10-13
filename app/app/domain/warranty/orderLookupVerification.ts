/**
 * PURE helpers for the warranty claim order-lookup flow (owner decision D33,
 * docs/ARCHITECTURE-MVP1.md, docs/WARRANTY-CLAIMS.md §2). A customer knows
 * their order as "#1001", not `gid://shopify/Order/7184178970925` —
 * `apps.carat.warranty-order-lookup.tsx` resolves that human-readable number
 * into the GIDs `apps.carat.warranty-claim.tsx` already requires.
 *
 * RETIRED TO AUTHENTICATED-ONLY per `docs/REQUIRED-CUSTOMER-ACCOUNTS.md`
 * (LOCKED OWNER REQUIREMENT, 2026-09-26), which supersedes D33's original
 * guest order-number + email flow. This module used to also hold the
 * guest-verification helpers (email comparison, token TTL, verification
 * email copy) — those are deleted, not merely unused, per that document's
 * §6 ("do not keep dead security-sensitive code merely because it was
 * already built"). What remains is shared by the surviving authenticated
 * route only.
 */

/** A bare `WarrantyOrderLookupResult`/`WarrantyOrderLookupSummary`-shaped value, kept minimal so this module has no dependency on the Shopify adapter's own types. */
export interface OrderLookupLineItemLike {
  readonly lineRef: string;
  readonly title: string;
  readonly quantity: number;
}

export interface OrderLookupSummaryLike {
  readonly orderGid: string;
  readonly orderName: string;
  readonly lineItems: readonly OrderLookupLineItemLike[];
}

/**
 * Normalizes a customer-typed order number into the exact form Shopify's
 * order `name` field uses for a search filter — e.g. "1001", " 1001 ", or
 * "#1001" all become "#1001". Shopify order names always carry the leading
 * "#" (spec §0, order confirmation emails/pages always show it), so a
 * customer who copies the number from their own order page will usually
 * already include it; a customer who just remembers "1001" should not be
 * refused for omitting it.
 *
 * Deliberately narrow: does not accept a bare Shopify GID here — this
 * function's whole purpose is translating the HUMAN-FACING number, not
 * accepting an internal identifier through a side door.
 */
export function normalizeOrderNumberForSearch(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/**
 * The closed allow-list response shape for the order-lookup route's success
 * case — mirrors `apps.carat.warranty-claim.tsx`'s `buildConfirmationDto`
 * discipline (criterion 156's "closed allow-list of fields" pattern). Only
 * what a storefront claim-form needs to let the customer pick a line item
 * and then call the existing warranty-claim intake endpoint: no email, no
 * customer id, no financial/cost data (CLAUDE.md rule 10).
 */
export interface WarrantyOrderLookupResponseDto {
  orderRef: string;
  orderName: string;
  lineItems: { lineRef: string; title: string; quantity: number }[];
}

export function toWarrantyOrderLookupResponseDto(summary: OrderLookupSummaryLike): WarrantyOrderLookupResponseDto {
  return {
    orderRef: summary.orderGid,
    orderName: summary.orderName,
    lineItems: summary.lineItems.map((line) => ({
      lineRef: line.lineRef,
      title: line.title,
      quantity: line.quantity,
    })),
  };
}
