import { describe, expect, it } from "vitest";

import {
  computeGroupBuyBankCheckoutIdempotencyKey,
  type GroupBuyCheckoutIdempotencyKeyLine,
} from "./groupBuyCheckoutIdempotencyKey";

const CUSTOMER_GID = "gid://shopify/Customer/222222";
const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";

const lineA: GroupBuyCheckoutIdempotencyKeyLine = {
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  quantity: 2,
  unitPriceMinorUnits: "100000",
  currency: "USD",
};
const lineB: GroupBuyCheckoutIdempotencyKeyLine = {
  shopifyVariantGid: "gid://shopify/ProductVariant/2",
  quantity: 1,
  unitPriceMinorUnits: "50000",
  currency: "USD",
};

describe("computeGroupBuyBankCheckoutIdempotencyKey", () => {
  it("is deterministic for identical input", () => {
    const a = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA, lineB]);
    const b = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA, lineB]);
    expect(a).toBe(b);
  });

  it("is independent of line order", () => {
    const forward = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA, lineB]);
    const reversed = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineB, lineA]);
    expect(forward).toBe(reversed);
  });

  it("differs when the customer gid differs", () => {
    const a = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA]);
    const b = computeGroupBuyBankCheckoutIdempotencyKey("gid://shopify/Customer/999999", CAMPAIGN_ID, [lineA]);
    expect(a).not.toBe(b);
  });

  it("differs when the campaign differs — two campaigns for one customer must never collide into one key", () => {
    const a = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA]);
    const b = computeGroupBuyBankCheckoutIdempotencyKey(
      CUSTOMER_GID,
      "22222222-2222-2222-2222-222222222222",
      [lineA]
    );
    expect(a).not.toBe(b);
  });

  it("differs when a line's quantity differs", () => {
    const a = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA]);
    const b = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [
      { ...lineA, quantity: 3 },
    ]);
    expect(a).not.toBe(b);
  });

  it("differs when a line's resolved unit price differs — a genuine tier change is a new attempt, not a replay", () => {
    const a = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA]);
    const b = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [
      { ...lineA, unitPriceMinorUnits: "100001" },
    ]);
    expect(a).not.toBe(b);
  });

  it("differs when the set of lines differs even if totals coincidentally match", () => {
    const a = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA, lineB]);
    const b = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA]);
    expect(a).not.toBe(b);
  });

  it("is stable across independent runs (no time/random component)", () => {
    const key = computeGroupBuyBankCheckoutIdempotencyKey(CUSTOMER_GID, CAMPAIGN_ID, [lineA, lineB]);
    expect(key).toMatch(/^group_buy_bank_checkout:[0-9a-f]{64}$/);
  });
});
