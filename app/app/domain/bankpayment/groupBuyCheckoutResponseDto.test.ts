import { describe, expect, it } from "vitest";

import { buildGroupBuyBankCheckoutResultDto, type QuotedGroupBuyLineForResult } from "./groupBuyCheckoutResponseDto";

const LINE: QuotedGroupBuyLineForResult = {
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  quantity: 2,
  quotedBankPaymentPriceMinorUnits: 90_000n,
  quotedRegularCardPriceMinorUnits: 94_500n,
  currency: "USD",
};

describe("buildGroupBuyBankCheckoutResultDto", () => {
  it("serializes every bigint as a decimal string and every date as ISO-8601", () => {
    const quotedAt = new Date("2026-09-27T00:00:00.000Z");
    const dto = buildGroupBuyBankCheckoutResultDto({
      groupBuyBankPaymentOrderId: "order-1",
      campaignId: "campaign-1",
      campaignCode: "fall-drop",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      shopifyOrderGid: "gid://shopify/Order/1",
      tierNumber: 2,
      quotedAt,
      lines: [LINE],
    });

    expect(dto.quotedAt).toBe("2026-09-27T00:00:00.000Z");
    // quotedAt + 96 hours, exactly.
    expect(dto.paymentDueBy).toBe("2026-10-01T00:00:00.000Z");
    expect(dto.lines).toEqual([
      {
        shopifyVariantId: "gid://shopify/ProductVariant/1",
        quantity: 2,
        quotedBankPaymentPriceMinorUnits: "90000",
        quotedRegularCardPriceMinorUnits: "94500",
        currency: "USD",
      },
    ]);

    // Round-trips through JSON with no bigint/Date serialization failure —
    // the entire point of the string/ISO discipline.
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it("never carries a shipping address or any admin-only figure", () => {
    const dto = buildGroupBuyBankCheckoutResultDto({
      groupBuyBankPaymentOrderId: "order-1",
      campaignId: "campaign-1",
      campaignCode: "fall-drop",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      shopifyOrderGid: "gid://shopify/Order/1",
      tierNumber: 1,
      quotedAt: new Date(),
      lines: [LINE],
    });
    const json = JSON.stringify(dto).toLowerCase();
    expect(json).not.toContain("address");
    expect(json).not.toContain("landedcost");
    expect(json).not.toContain("margin");
  });
});
