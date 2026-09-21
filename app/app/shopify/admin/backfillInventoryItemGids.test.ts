import { describe, expect, it } from "vitest";

import { resolveConfirmedInventoryItemGid } from "./backfillInventoryItemGids.server";

/**
 * Unit coverage for the PURE matcher only (R17). The orchestration
 * (`backfillInventoryItemGids`) touches Prisma and the Admin API directly
 * and is integration-test territory — see
 * `tests/integration/shopify/backfillInventoryItemGids.test.ts`.
 */

function node(variantGid: string, inventoryItemGid: string | null, backwardVariantGids: string[] = [variantGid]) {
  return {
    id: variantGid,
    inventoryItem: inventoryItemGid
      ? { id: inventoryItemGid, variants: { nodes: backwardVariantGids.map((id) => ({ id })) } }
      : null,
  };
}

describe("resolveConfirmedInventoryItemGid", () => {
  it("resolves when the forward id AND the backward variants connection both confirm the pairing", () => {
    const nodes = [node("gid://shopify/ProductVariant/1", "gid://shopify/InventoryItem/100")];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/1")).toBe(
      "gid://shopify/InventoryItem/100"
    );
  });

  it("returns null when the variant gid is not present in the response at all", () => {
    const nodes = [node("gid://shopify/ProductVariant/1", "gid://shopify/InventoryItem/100")];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/999")).toBeNull();
  });

  it("returns null when the variant has no inventoryItem at all", () => {
    const nodes = [node("gid://shopify/ProductVariant/1", null)];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/1")).toBeNull();
  });

  it("returns null when the inventory item's OWN variants connection does not name this variant back (the R17 verification this function exists for)", () => {
    const nodes = [
      node("gid://shopify/ProductVariant/1", "gid://shopify/InventoryItem/100", [
        "gid://shopify/ProductVariant/OTHER",
      ]),
    ];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/1")).toBeNull();
  });

  it("returns null when the backward variants connection is empty", () => {
    const nodes = [node("gid://shopify/ProductVariant/1", "gid://shopify/InventoryItem/100", [])];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/1")).toBeNull();
  });

  it("resolves the correct one among several variants on the same product", () => {
    const nodes = [
      node("gid://shopify/ProductVariant/1", "gid://shopify/InventoryItem/100"),
      node("gid://shopify/ProductVariant/2", "gid://shopify/InventoryItem/200"),
      node("gid://shopify/ProductVariant/3", "gid://shopify/InventoryItem/300"),
    ];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/2")).toBe(
      "gid://shopify/InventoryItem/200"
    );
  });

  it("handles a backward connection listing MULTIPLE variants (a legitimately shared inventory item) as long as ours is among them", () => {
    const nodes = [
      node("gid://shopify/ProductVariant/1", "gid://shopify/InventoryItem/100", [
        "gid://shopify/ProductVariant/1",
        "gid://shopify/ProductVariant/2",
      ]),
    ];
    expect(resolveConfirmedInventoryItemGid(nodes, "gid://shopify/ProductVariant/1")).toBe(
      "gid://shopify/InventoryItem/100"
    );
  });

  it("returns null for an empty response", () => {
    expect(resolveConfirmedInventoryItemGid([], "gid://shopify/ProductVariant/1")).toBeNull();
  });
});
