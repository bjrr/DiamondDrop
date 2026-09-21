import { describe, expect, it } from "vitest";

import { extractInventoryItemGidFromRawBody, extractShopifyIdentifiers } from "./inventoryPurchasabilityHandler.server";

/**
 * Unit coverage for the PURE halves only (R15/R17) — no database, no
 * network. `resolveMasterProduct`/`handleInventoryPurchasabilityWebhook`
 * touch Prisma and the Admin API directly (no injected deps, matching the
 * established pattern in `syncApprovedIntent.server.ts`/
 * `runRecalculation.server.ts`) and are integration-test territory — see
 * `tests/integration/shopify/inventoryPurchasabilityWebhook.test.ts`.
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

describe("extractInventoryItemGidFromRawBody — kind: inventory_item (inventory_levels/update, R17)", () => {
  it("extracts inventory_item_id from the flat, documented payload shape", () => {
    const rawBody = JSON.stringify({
      inventory_item_id: 808950810,
      location_id: 655441491,
      available: 1,
      updated_at: "2026-09-20T00:00:00-00:00",
    });
    expect(extractInventoryItemGidFromRawBody(rawBody)).toBe("gid://shopify/InventoryItem/808950810");
  });

  it("R17's whole point: a 64-bit id beyond Number.MAX_SAFE_INTEGER is preserved EXACTLY, digit for digit", () => {
    // A value chosen specifically beyond 2^53 - 1 (9_007_199_254_740_991).
    // If this were ever parsed through JSON.parse into a JS number (the
    // exact hazard this function exists to avoid), it would silently round
    // to a DIFFERENT digit string -- this test would then fail loudly
    // rather than the production bug failing silently.
    const hugeId = "9007199254740993"; // MAX_SAFE_INTEGER + 2, deliberately unrepresentable exactly as a JS number
    const rawBody = `{"inventory_item_id":${hugeId},"location_id":1,"available":0}`;
    expect(extractInventoryItemGidFromRawBody(rawBody)).toBe(`gid://shopify/InventoryItem/${hugeId}`);
  });

  it("proves the hazard is real: JSON.parse alone on the same body loses precision, which is exactly why this function reads the raw text instead", () => {
    const hugeId = "9007199254740993";
    const rawBody = `{"inventory_item_id":${hugeId}}`;
    const parsed = JSON.parse(rawBody) as { inventory_item_id: number };
    // The naive path (JSON.parse then String(...)) does NOT round-trip exactly.
    expect(String(parsed.inventory_item_id)).not.toBe(hugeId);
    // The raw-text extraction this module actually uses DOES.
    expect(extractInventoryItemGidFromRawBody(rawBody)).toBe(`gid://shopify/InventoryItem/${hugeId}`);
  });

  it("tolerates whitespace variations around the colon", () => {
    expect(extractInventoryItemGidFromRawBody('{"inventory_item_id"  :   42}')).toBe(
      "gid://shopify/InventoryItem/42"
    );
  });

  it("returns null when the field is absent", () => {
    expect(extractInventoryItemGidFromRawBody('{"location_id":1,"available":0}')).toBeNull();
  });

  it("returns null rather than throwing for malformed/non-JSON raw bodies", () => {
    expect(extractInventoryItemGidFromRawBody("not json at all")).toBeNull();
    expect(extractInventoryItemGidFromRawBody("")).toBeNull();
  });

  it("never reads the payload's available/location_id fields at all — the function's return type cannot carry them", () => {
    // Structural proof, not just behavioural: the function returns a bare
    // string | null, so there is no code path by which a quantity or
    // location value could leak into the identifier this module resolves
    // against.
    const rawBody = JSON.stringify({ inventory_item_id: 1, location_id: 999, available: 12345 });
    const result = extractInventoryItemGidFromRawBody(rawBody);
    expect(result).toBe("gid://shopify/InventoryItem/1");
    expect(typeof result).toBe("string");
  });
});
