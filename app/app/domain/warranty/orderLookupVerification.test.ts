import { describe, expect, it } from "vitest";

import { normalizeOrderNumberForSearch, toWarrantyOrderLookupResponseDto } from "./orderLookupVerification";

describe("normalizeOrderNumberForSearch", () => {
  it("adds a leading # when the customer omits it", () => {
    expect(normalizeOrderNumberForSearch("1001")).toBe("#1001");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOrderNumberForSearch("  1001  ")).toBe("#1001");
  });

  it("leaves an already-#-prefixed number alone", () => {
    expect(normalizeOrderNumberForSearch("#1001")).toBe("#1001");
  });

  it("trims whitespace before checking for the # prefix", () => {
    expect(normalizeOrderNumberForSearch("  #1001  ")).toBe("#1001");
  });
});

describe("toWarrantyOrderLookupResponseDto", () => {
  it("is a closed allow-list — no email, customer id, or cost/pricing data can leak through", () => {
    const dto = toWarrantyOrderLookupResponseDto({
      orderGid: "gid://shopify/Order/1",
      orderName: "#1001",
      lineItems: [{ lineRef: "gid://shopify/LineItem/1", title: "14k Gold Ring", quantity: 1 }],
    });
    expect(Object.keys(dto).sort()).toEqual(["lineItems", "orderName", "orderRef"]);
    expect(Object.keys(dto.lineItems[0]!).sort()).toEqual(["lineRef", "quantity", "title"]);
  });

  it("maps every line item, preserving order", () => {
    const dto = toWarrantyOrderLookupResponseDto({
      orderGid: "gid://shopify/Order/1",
      orderName: "#1001",
      lineItems: [
        { lineRef: "gid://shopify/LineItem/1", title: "A", quantity: 1 },
        { lineRef: "gid://shopify/LineItem/2", title: "B", quantity: 2 },
      ],
    });
    expect(dto.lineItems).toEqual([
      { lineRef: "gid://shopify/LineItem/1", title: "A", quantity: 1 },
      { lineRef: "gid://shopify/LineItem/2", title: "B", quantity: 2 },
    ]);
  });

  it("handles zero line items", () => {
    const dto = toWarrantyOrderLookupResponseDto({ orderGid: "gid://shopify/Order/1", orderName: "#1001", lineItems: [] });
    expect(dto.lineItems).toEqual([]);
  });
});
