import { describe, expect, it } from "vitest";

import { extractShopifyIdentifiers } from "./inventoryPurchasabilityHandler.server";

/**
 * Unit coverage for the PURE half only (R15) — no database, no network.
 * `resolveMasterProduct`/`handleInventoryPurchasabilityWebhook` touch Prisma
 * and the Admin API directly (no injected deps, matching the established
 * pattern in `syncApprovedIntent.server.ts`/`runRecalculation.server.ts`,
 * neither of which has a unit-level counterpart either) and are therefore
 * integration-test territory, not this file's.
 */

describe("extractShopifyIdentifiers — kind: product (products/update)", () => {
  it("prefers admin_graphql_api_id when it is a Product gid", () => {
    const result = extractShopifyIdentifiers("product", {
      id: 123,
      admin_graphql_api_id: "gid://shopify/Product/123",
    });
    expect(result).toEqual({ productGid: "gid://shopify/Product/123" });
  });

  it("falls back to constructing a Product gid from the legacy id", () => {
    const result = extractShopifyIdentifiers("product", { id: 999 });
    expect(result).toEqual({ productGid: "gid://shopify/Product/999" });
  });

  it("ignores an admin_graphql_api_id of the WRONG resource type (defensive against a malformed/unexpected payload)", () => {
    const result = extractShopifyIdentifiers("product", {
      id: 42,
      admin_graphql_api_id: "gid://shopify/ProductVariant/42",
    });
    // Falls back to the legacy id rather than trusting a mistyped gid.
    expect(result).toEqual({ productGid: "gid://shopify/Product/42" });
  });

  it("returns {} when nothing usable is present", () => {
    expect(extractShopifyIdentifiers("product", {})).toEqual({});
    expect(extractShopifyIdentifiers("product", { some_other_field: "x" })).toEqual({});
  });

  it("returns {} rather than throwing for a non-object payload", () => {
    expect(extractShopifyIdentifiers("product", "not an object")).toEqual({});
    expect(extractShopifyIdentifiers("product", null)).toEqual({});
    expect(extractShopifyIdentifiers("product", 42)).toEqual({});
  });

  it("accepts a string-typed numeric id (payloads are not guaranteed to send JSON numbers)", () => {
    const result = extractShopifyIdentifiers("product", { id: "555" });
    expect(result).toEqual({ productGid: "gid://shopify/Product/555" });
  });
});

describe("extractShopifyIdentifiers — kind: variant (variants/out_of_stock, variants/in_stock)", () => {
  it("prefers admin_graphql_api_id when it is a ProductVariant gid", () => {
    const result = extractShopifyIdentifiers("variant", {
      id: 9,
      admin_graphql_api_id: "gid://shopify/ProductVariant/9",
    });
    expect(result).toEqual({ variantGid: "gid://shopify/ProductVariant/9" });
  });

  it("prefers product_id over variant_id/id — resolves the product in one query", () => {
    const result = extractShopifyIdentifiers("variant", { id: 9, product_id: 1, variant_id: 9 });
    expect(result).toEqual({ productGid: "gid://shopify/Product/1" });
  });

  it("falls back to variant_id when there is no product_id", () => {
    const result = extractShopifyIdentifiers("variant", { variant_id: 9 });
    expect(result).toEqual({ variantGid: "gid://shopify/ProductVariant/9" });
  });

  it("falls back to a bare top-level id, treated as the variant's own id, as a last resort", () => {
    const result = extractShopifyIdentifiers("variant", { id: 9 });
    expect(result).toEqual({ variantGid: "gid://shopify/ProductVariant/9" });
  });

  it("ignores an admin_graphql_api_id of the WRONG resource type", () => {
    const result = extractShopifyIdentifiers("variant", {
      id: 9,
      admin_graphql_api_id: "gid://shopify/Product/9",
    });
    // Falls through to the next rule rather than trusting a mistyped gid —
    // admin_graphql_api_id is a Product gid here, so product_id/variant_id/id
    // decide instead.
    expect(result).toEqual({ variantGid: "gid://shopify/ProductVariant/9" });
  });

  it("returns {} when nothing usable is present", () => {
    expect(extractShopifyIdentifiers("variant", {})).toEqual({});
  });

  it("returns {} rather than throwing for a non-object payload", () => {
    expect(extractShopifyIdentifiers("variant", "not an object")).toEqual({});
    expect(extractShopifyIdentifiers("variant", null)).toEqual({});
  });
});
