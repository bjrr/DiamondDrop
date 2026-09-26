/**
 * PURE helpers for the warranty claim order-lookup flow (owner decision D33,
 * docs/ARCHITECTURE-MVP1.md, docs/WARRANTY-CLAIMS.md §2). A customer knows
 * their order as "#1001", not `gid://shopify/Order/7184178970925` —
 * `apps.carat.warranty-order-lookup.tsx` and `apps.carat.warranty-order-
 * verify.tsx` resolve that human-readable number into the GIDs
 * `apps.carat.warranty-claim.tsx` already requires, without ever letting an
 * unauthenticated caller learn whether ANY given order number/email exists
 * (D33's "reveal nothing" requirement).
 *
 * Everything here is deliberately side-effect-free so the two routes' most
 * security-sensitive decisions (does this order number look valid, does this
 * email match, what goes in the response DTO) are unit-testable without a
 * database or a network call.
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

/** Case-insensitive, whitespace-trimmed email comparison — the ONLY check the guest flow performs before issuing a verification link (D33). */
export function normalizeEmailForComparison(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeEmailForComparison(a) === normalizeEmailForComparison(b);
}

/**
 * The closed allow-list response shape for BOTH routes' success cases —
 * mirrors `apps.carat.warranty-claim.tsx`'s `buildConfirmationDto` discipline
 * (criterion 156's "closed allow-list of fields" pattern). Only what a
 * storefront claim-form needs to let the customer pick a line item and then
 * call the existing warranty-claim intake endpoint: no email, no customer
 * id, no financial/cost data (CLAUDE.md rule 10).
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

/** How long a guest verification link stays valid — "short-lived" per D33; not an owner-pinned number, adjust freely if a different window is wanted. */
export const WARRANTY_ORDER_VERIFICATION_TTL_MINUTES = 30;

export function computeWarrantyOrderVerificationExpiry(now: Date): Date {
  return new Date(now.getTime() + WARRANTY_ORDER_VERIFICATION_TTL_MINUTES * 60 * 1000);
}

/**
 * Functional (not legally pinned) copy — unlike
 * `guaranteeCancellationEmail.ts`'s owner-approved text, D33 specifies the
 * MECHANISM (short-lived, single-use, generic before verification) but not
 * exact wording, so this is a reasonable default the owner can revise
 * without touching any evidence/acknowledgment record — no acknowledgment is
 * captured here, this is a transactional "click to continue" email only.
 */
export function buildWarrantyOrderVerificationEmail(input: {
  orderName: string;
  verificationUrl: string;
}): { subject: string; text: string } {
  return {
    subject: `Verify your warranty claim lookup for order ${input.orderName}`,
    text:
      `We received a request to look up order ${input.orderName} to start a CaratForUs warranty claim. ` +
      "To continue, open this link:\n\n" +
      `${input.verificationUrl}\n\n` +
      `This link expires in ${WARRANTY_ORDER_VERIFICATION_TTL_MINUTES} minutes and can only be used once. ` +
      "If you did not request this, you can safely ignore this email — no claim has been started.",
  };
}
