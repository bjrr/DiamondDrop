import { describe, expect, it } from "vitest";

import { FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH } from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";

import { buildGroupBuyCancellationHoldHandle } from "./cancellationHoldHandle";

describe("buildGroupBuyCancellationHoldHandle", () => {
  it("stays within Shopify's 64-character handle limit, with headroom for longer ids", () => {
    const realistic = buildGroupBuyCancellationHoldHandle("gid://shopify/FulfillmentOrder/8330163061037");
    expect(realistic.length).toBeLessThanOrEqual(FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH);

    const oversized = buildGroupBuyCancellationHoldHandle(`gid://shopify/FulfillmentOrder/${"9".repeat(30)}`);
    expect(oversized.length).toBeLessThanOrEqual(FULFILLMENT_ORDER_HOLD_HANDLE_MAX_LENGTH);
  });

  it("derives the same handle every time for the same fulfilment order, and a different one for a different order", () => {
    const a1 = buildGroupBuyCancellationHoldHandle("gid://shopify/FulfillmentOrder/1");
    const a2 = buildGroupBuyCancellationHoldHandle("gid://shopify/FulfillmentOrder/1");
    const b = buildGroupBuyCancellationHoldHandle("gid://shopify/FulfillmentOrder/2");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("is namespaced so it cannot collide with a hold placed by a merchant, another app, or the Luxury Steal handler", () => {
    const handle = buildGroupBuyCancellationHoldHandle("gid://shopify/FulfillmentOrder/1");
    expect(handle).toMatch(/^carat:/);
    expect(handle).not.toContain("ls-unverified");
    expect(handle).toContain("gb-cancel-unverified");
  });
});
