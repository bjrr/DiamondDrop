import { describe, expect, it } from "vitest";

import { normalizeShopifyVariantGid } from "./shopifyVariantId";

describe("normalizeShopifyVariantGid", () => {
  it("prefixes a bare numeric id", () => {
    expect(normalizeShopifyVariantGid("4455")).toBe("gid://shopify/ProductVariant/4455");
  });

  it("leaves an already-qualified gid unchanged", () => {
    expect(normalizeShopifyVariantGid("gid://shopify/ProductVariant/4455")).toBe(
      "gid://shopify/ProductVariant/4455"
    );
  });

  it("does not prefix an id that merely starts with digits resembling a gid fragment", () => {
    expect(normalizeShopifyVariantGid("123gid")).toBe("gid://shopify/ProductVariant/123gid");
  });
});
