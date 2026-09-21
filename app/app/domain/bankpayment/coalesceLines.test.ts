import { describe, expect, it } from "vitest";

import { CoalescedQuantityOverflowError, coalesceCheckoutLines, type RawCheckoutLine } from "./coalesceLines";

describe("coalesceCheckoutLines", () => {
  it("leaves distinct variants unchanged", () => {
    const lines: RawCheckoutLine[] = [
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 2 },
      { masterVariantId: "v2", shopifyVariantGid: "gid://shopify/ProductVariant/2", quantity: 5 },
    ];

    expect(coalesceCheckoutLines(lines)).toEqual(lines);
  });

  it("sums quantity when the same variant appears on two request lines", () => {
    const lines: RawCheckoutLine[] = [
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 2 },
      { masterVariantId: "v2", shopifyVariantGid: "gid://shopify/ProductVariant/2", quantity: 1 },
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 3 },
    ];

    const result = coalesceCheckoutLines(lines);

    expect(result).toEqual([
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 5 },
      { masterVariantId: "v2", shopifyVariantGid: "gid://shopify/ProductVariant/2", quantity: 1 },
    ]);
  });

  it("sums quantity across MORE than two occurrences of the same variant", () => {
    const lines: RawCheckoutLine[] = [
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 1 },
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 1 },
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 1 },
    ];

    expect(coalesceCheckoutLines(lines)).toEqual([
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 3 },
    ]);
  });

  it("preserves first-seen order across the coalesced result", () => {
    const lines: RawCheckoutLine[] = [
      { masterVariantId: "v3", shopifyVariantGid: "gid://shopify/ProductVariant/3", quantity: 1 },
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 1 },
      { masterVariantId: "v3", shopifyVariantGid: "gid://shopify/ProductVariant/3", quantity: 1 },
      { masterVariantId: "v2", shopifyVariantGid: "gid://shopify/ProductVariant/2", quantity: 1 },
    ];

    expect(coalesceCheckoutLines(lines).map((l) => l.masterVariantId)).toEqual(["v3", "v1", "v2"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(coalesceCheckoutLines([])).toEqual([]);
  });

  it("throws CoalescedQuantityOverflowError rather than silently wrapping past Number.MAX_SAFE_INTEGER", () => {
    const lines: RawCheckoutLine[] = [
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: Number.MAX_SAFE_INTEGER },
      { masterVariantId: "v1", shopifyVariantGid: "gid://shopify/ProductVariant/1", quantity: 10 },
    ];

    expect(() => coalesceCheckoutLines(lines)).toThrow(CoalescedQuantityOverflowError);
  });
});
