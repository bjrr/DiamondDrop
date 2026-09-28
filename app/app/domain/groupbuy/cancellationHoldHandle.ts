import { FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH } from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";

/**
 * The Group Buy cancellation-acknowledgment fulfilment-hold handle — mirrors
 * `buildLuxuryStealHoldHandle` in
 * `~/shopify/admin/luxuryStealOrderReviewAdapter.server.ts` exactly (owner
 * spec 2026-09-27/28: "reuse the proven D28 machinery rather than building a
 * second hold/idempotency system"), with its OWN namespace so a Group Buy
 * hold is never mistaken for a Luxury Steal one in the Shopify admin UI or in
 * this app's own audit trail.
 *
 * PURE, DETERMINISTIC, PER FULFILMENT ORDER — the SAME handle every time,
 * including on a redelivery, which is what lets Shopify's own
 * `DUPLICATE_FULFILLMENT_HOLD_HANDLE` code work as this app's idempotency
 * signal for the hold itself (see `ShopifyLuxuryStealOrderReviewAdapter
 * .holdFulfillmentOrder`'s own doc comment — this handler passes this
 * function's output as that method's `handle` parameter).
 *
 * `FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH` IS REUSED, NOT RE-DERIVED. That
 * constant is a SHOPIFY PLATFORM limit (`FulfillmentOrderHoldInput.handle`
 * caps at 64 characters — discovered in production, not in the schema, per
 * that module's own header comment), not something specific to Luxury
 * Steals. Re-declaring "64" here as a second magic number would risk the two
 * silently drifting if Shopify's limit is ever revisited in one file and not
 * the other.
 */
const GROUP_BUY_CANCELLATION_HOLD_HANDLE_NAMESPACE = "carat:gb-cancel-unverified";

export function buildGroupBuyCancellationHoldHandle(fulfillmentOrderGid: string): string {
  const numericId = fulfillmentOrderGid.split("/").pop() ?? fulfillmentOrderGid;
  const handle = `${GROUP_BUY_CANCELLATION_HOLD_HANDLE_NAMESPACE}:${numericId}`;
  // BELT AND BRACES, DELIBERATELY REDUNDANT with
  // `ShopifyLuxuryStealOrderReviewAdapter.holdFulfillmentOrder`'s OWN runtime
  // guard (added after `handle` became caller-supplied — see that method's
  // doc comment for the exact failure mode this closes: a silent no-op hold).
  // This check fires first, here, at the moment the handle is BUILT — for a
  // realistic fulfilment order id this comes to ~40 characters, comfortably
  // under the 64-character limit — so a regression is caught at construction
  // time, closer to the actual bug, rather than only at the call site. Never
  // silently truncates a value that would violate the Shopify limit; if this
  // ever fired for real it should fail loudly rather than send a truncated,
  // possibly-colliding handle.
  if (handle.length > FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH) {
    throw new Error(
      `Group Buy cancellation hold handle "${handle}" exceeds Shopify's ${FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH}-character limit`
    );
  }
  return handle;
}
