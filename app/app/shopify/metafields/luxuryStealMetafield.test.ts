import { describe, expect, it } from "vitest";

import {
  LUXURY_STEAL_METAFIELD_KEY,
  LUXURY_STEAL_METAFIELD_NAMESPACE,
  buildLuxuryStealMetafield,
} from "./luxuryStealMetafield";

describe("buildLuxuryStealMetafield", () => {
  it("shapes an assigned variant as ownerId/namespace/key/type=boolean/value='true'", () => {
    const input = buildLuxuryStealMetafield({
      shopifyVariantGid: "gid://shopify/ProductVariant/9",
      isLuxurySteal: true,
    });

    expect(input).toEqual({
      ownerId: "gid://shopify/ProductVariant/9",
      namespace: LUXURY_STEAL_METAFIELD_NAMESPACE,
      key: LUXURY_STEAL_METAFIELD_KEY,
      type: "boolean",
      value: "true",
    });
  });

  it("shapes an unassigned variant with an explicit 'false' value, never omitting it (criterion 128)", () => {
    const input = buildLuxuryStealMetafield({
      shopifyVariantGid: "gid://shopify/ProductVariant/9",
      isLuxurySteal: false,
    });

    expect(input.value).toBe("false");
    expect(input.type).toBe("boolean");
  });

  it("uses the owner-named namespace and key exactly (D26/D27)", () => {
    expect(LUXURY_STEAL_METAFIELD_NAMESPACE).toBe("carat");
    expect(LUXURY_STEAL_METAFIELD_KEY).toBe("luxury_steal");
  });

  it("targets the variant gid passed in, not any product gid — D27's variant-level assignment", () => {
    const input = buildLuxuryStealMetafield({
      shopifyVariantGid: "gid://shopify/ProductVariant/555",
      isLuxurySteal: true,
    });
    expect(input.ownerId).toBe("gid://shopify/ProductVariant/555");
  });
});
