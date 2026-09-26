import { describe, expect, it } from "vitest";

import {
  buildWarrantyOrderVerificationEmail,
  computeWarrantyOrderVerificationExpiry,
  emailsMatch,
  normalizeEmailForComparison,
  normalizeOrderNumberForSearch,
  toWarrantyOrderLookupResponseDto,
  WARRANTY_ORDER_VERIFICATION_TTL_MINUTES,
} from "./orderLookupVerification";

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

describe("normalizeEmailForComparison / emailsMatch", () => {
  it("lowercases and trims for comparison", () => {
    expect(normalizeEmailForComparison("  Purchaser@Example.COM  ")).toBe("purchaser@example.com");
  });

  it("matches case-insensitively and ignoring surrounding whitespace", () => {
    expect(emailsMatch(" Purchaser@Example.com ", "purchaser@example.com")).toBe(true);
  });

  it("does not match different addresses", () => {
    expect(emailsMatch("purchaser@example.com", "someone-else@example.com")).toBe(false);
  });

  it("never matches when either side is null/undefined — never treated as a wildcard", () => {
    expect(emailsMatch(null, "purchaser@example.com")).toBe(false);
    expect(emailsMatch("purchaser@example.com", undefined)).toBe(false);
    expect(emailsMatch(null, undefined)).toBe(false);
  });

  it("never matches two empty strings — an order with no email on file cannot be claimed by an empty submission", () => {
    expect(emailsMatch("", "")).toBe(false);
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

describe("computeWarrantyOrderVerificationExpiry", () => {
  it(`adds exactly ${WARRANTY_ORDER_VERIFICATION_TTL_MINUTES} minutes`, () => {
    const now = new Date("2026-09-26T00:00:00.000Z");
    const expiry = computeWarrantyOrderVerificationExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(WARRANTY_ORDER_VERIFICATION_TTL_MINUTES * 60 * 1000);
  });
});

describe("buildWarrantyOrderVerificationEmail", () => {
  it("includes the order name, the exact verification URL, and the expiry window", () => {
    const { subject, text } = buildWarrantyOrderVerificationEmail({
      orderName: "#1001",
      verificationUrl: "https://shop.example.com/pages/warranty-claim-verify?token=abc123",
    });
    expect(subject).toContain("#1001");
    expect(text).toContain("https://shop.example.com/pages/warranty-claim-verify?token=abc123");
    expect(text).toContain(`${WARRANTY_ORDER_VERIFICATION_TTL_MINUTES} minutes`);
  });

  it("never mentions shipping/return instructions — this is a lookup email, not a claim-authorization email", () => {
    const { text } = buildWarrantyOrderVerificationEmail({
      orderName: "#1001",
      verificationUrl: "https://shop.example.com/pages/warranty-claim-verify?token=abc123",
    });
    expect(text).not.toMatch(/ship|carrier|insur|tracking/i);
  });
});
