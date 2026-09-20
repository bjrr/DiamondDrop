import { describe, expect, it } from "vitest";

import type { PublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";

import {
  MalformedPriceMetafieldValueError,
  MalformedShopifyGidError,
  PRICE_METAFIELD_NAMESPACE,
  buildProductAsLowAsMetafield,
  buildVariantBankPaymentEligibleMetafield,
  buildVariantBankPaymentPriceMetafield,
  buildVariantSyncSuspendedMetafield,
  compareMetafieldToPublishedCalculation,
  parsePriceBearingMetafieldValue,
  shopifyLegacyIdFromGid,
} from "./priceMetafieldPayload";

function aPublishedPrice(overrides: Partial<PublishedVariantPrice> = {}): PublishedVariantPrice {
  return {
    masterVariantId: "variant-1",
    priceCalculationId: "calc-1",
    bankPaymentPriceMinorUnits: 100_000n,
    regularCardPriceMinorUnits: 104_000n,
    bankPaymentSavingsMinorUnits: 4_000n,
    currency: "USD",
    appliedUpliftRate: "0.040000",
    appliedTierLabel: "$1,000–$2,499.99",
    ...overrides,
  };
}

describe("shopifyLegacyIdFromGid (R14)", () => {
  it("extracts the trailing numeric id from a well-formed variant gid, as a decimal string", () => {
    // Verified live against caratforus-dev.myshopify.com, 2026-09-20:
    // ProductVariant.legacyResourceId equals this exact trailing segment.
    expect(shopifyLegacyIdFromGid("gid://shopify/ProductVariant/52379059290413")).toBe("52379059290413");
  });

  it("throws MalformedShopifyGidError for a gid with no trailing digits", () => {
    expect(() => shopifyLegacyIdFromGid("gid://shopify/ProductVariant/")).toThrow(MalformedShopifyGidError);
    expect(() => shopifyLegacyIdFromGid("not-a-gid")).toThrow(MalformedShopifyGidError);
  });
});

describe("buildVariantBankPaymentPriceMetafield", () => {
  it("shapes namespace/key/type/ownerId and embeds the calculation id in the value", () => {
    const input = buildVariantBankPaymentPriceMetafield("gid://shopify/ProductVariant/9", aPublishedPrice());

    expect(input.ownerId).toBe("gid://shopify/ProductVariant/9");
    expect(input.namespace).toBe(PRICE_METAFIELD_NAMESPACE);
    expect(input.key).toBe("bank_payment_price_minor_units");
    expect(input.type).toBe("json");

    const payload = JSON.parse(input.value);
    expect(payload).toEqual({
      masterVariantId: "variant-1",
      priceCalculationId: "calc-1",
      currency: "USD",
      bankPaymentPriceMinorUnits: "100000",
      regularCardPriceMinorUnits: "104000",
      bankPaymentSavingsMinorUnits: "4000",
      shopifyVariantId: "9",
      cardPriceAnchorMinorUnits: "104000",
    });
  });

  it("R14 (architect ruling 2026-09-20): shopifyVariantId and cardPriceAnchorMinorUnits are decimal strings, like every other field in this payload", () => {
    const input = buildVariantBankPaymentPriceMetafield("gid://shopify/ProductVariant/9", aPublishedPrice());
    const payload = JSON.parse(input.value);
    expect(typeof payload.shopifyVariantId).toBe("string");
    expect(typeof payload.cardPriceAnchorMinorUnits).toBe("string");
  });

  it("R14: the anchor tracks regularCardPriceMinorUnits exactly, in minor units", () => {
    const input = buildVariantBankPaymentPriceMetafield(
      "gid://shopify/ProductVariant/1",
      aPublishedPrice({ regularCardPriceMinorUnits: 208_000n })
    );
    expect(JSON.parse(input.value).cardPriceAnchorMinorUnits).toBe("208000");
  });

  it("R14: shopifyVariantId is derived from the gid, matching Liquid's variant.id form", () => {
    const input = buildVariantBankPaymentPriceMetafield("gid://shopify/ProductVariant/52379059290413", aPublishedPrice());
    expect(JSON.parse(input.value).shopifyVariantId).toBe("52379059290413");
  });

  it("propagates MalformedShopifyGidError for a malformed variant gid", () => {
    expect(() => buildVariantBankPaymentPriceMetafield("not-a-gid", aPublishedPrice())).toThrow(
      MalformedShopifyGidError
    );
  });

  it("never carries the internal uplift rate or tier label (C-S5 / R14)", () => {
    const input = buildVariantBankPaymentPriceMetafield(
      "gid://shopify/ProductVariant/9",
      aPublishedPrice({ appliedUpliftRate: "0.999999", appliedTierLabel: "SECRET TIER" })
    );

    expect(input.value).not.toContain("appliedUpliftRate");
    expect(input.value).not.toContain("appliedTierLabel");
    expect(input.value).not.toContain("0.999999");
    expect(input.value).not.toContain("SECRET TIER");
  });

  it("serializes minor-unit money amounts (including the R14 anchor) as decimal strings, never as JS numbers that could lose precision", () => {
    const input = buildVariantBankPaymentPriceMetafield(
      "gid://shopify/ProductVariant/9",
      aPublishedPrice({
        bankPaymentPriceMinorUnits: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
        regularCardPriceMinorUnits: 9_007_199_254_740_995n,
      })
    );

    expect(input.value).toContain('"bankPaymentPriceMinorUnits":"9007199254740993"');
    // The R14 anchor is regularCardPriceMinorUnits, and must survive an
    // absurdly large value exactly, since it is a decimal string with no
    // numeric-widening conversion anywhere in this path.
    expect(input.value).toContain('"cardPriceAnchorMinorUnits":"9007199254740995"');
  });
});

describe("buildProductAsLowAsMetafield", () => {
  it("shapes the product-level payload around the winning variant's price and the SOURCE variant's Shopify id", () => {
    const input = buildProductAsLowAsMetafield(
      "gid://shopify/Product/1",
      aPublishedPrice({ masterVariantId: "variant-cheapest", priceCalculationId: "calc-cheapest" }),
      "gid://shopify/ProductVariant/42"
    );

    expect(input.ownerId).toBe("gid://shopify/Product/1");
    expect(input.key).toBe("as_low_as_bank_minor_units");
    expect(input.type).toBe("json");
    expect(JSON.parse(input.value)).toEqual({
      masterVariantId: "variant-cheapest",
      priceCalculationId: "calc-cheapest",
      currency: "USD",
      bankPaymentPriceMinorUnits: "100000",
      shopifyVariantId: "42",
      cardPriceAnchorMinorUnits: "104000",
    });
  });

  it("R14: the source variant id is the SHOPIFY id, not masterVariantId — this is the whole point", () => {
    const input = buildProductAsLowAsMetafield(
      "gid://shopify/Product/1",
      aPublishedPrice({ masterVariantId: "internal-uuid-not-liquid-resolvable" }),
      "gid://shopify/ProductVariant/999"
    );
    const payload = JSON.parse(input.value);
    expect(payload.shopifyVariantId).toBe("999");
    // The internal uuid is still present (audit/admin correlation) but is a
    // SEPARATE field the theme never resolves against product.variants.
    expect(payload.masterVariantId).toBe("internal-uuid-not-liquid-resolvable");
  });

  it("propagates MalformedShopifyGidError for a malformed winning-variant gid", () => {
    expect(() => buildProductAsLowAsMetafield("gid://shopify/Product/1", aPublishedPrice(), "bad-gid")).toThrow(
      MalformedShopifyGidError
    );
  });
});

describe("non-price-bearing boolean metafields", () => {
  it("bank_payment_eligible carries no calculation id — it is not price-bearing", () => {
    const on = buildVariantBankPaymentEligibleMetafield("gid://shopify/ProductVariant/9", true);
    expect(on).toEqual({
      ownerId: "gid://shopify/ProductVariant/9",
      namespace: PRICE_METAFIELD_NAMESPACE,
      key: "bank_payment_eligible",
      type: "boolean",
      value: "true",
    });

    const off = buildVariantBankPaymentEligibleMetafield("gid://shopify/ProductVariant/9", false);
    expect(off.value).toBe("false");
  });

  it("sync_suspended", () => {
    const suspended = buildVariantSyncSuspendedMetafield("gid://shopify/ProductVariant/9", true);
    expect(suspended.key).toBe("sync_suspended");
    expect(suspended.value).toBe("true");
  });
});

describe("parsePriceBearingMetafieldValue", () => {
  it("round-trips a value produced by a builder above, including the R14 fields", () => {
    const input = buildVariantBankPaymentPriceMetafield("gid://shopify/ProductVariant/9", aPublishedPrice());
    const parsed = parsePriceBearingMetafieldValue(input.value);

    expect(parsed).toEqual({
      masterVariantId: "variant-1",
      priceCalculationId: "calc-1",
      currency: "USD",
      bankPaymentPriceMinorUnits: "100000",
      shopifyVariantId: "9",
      cardPriceAnchorMinorUnits: "104000",
    });
  });

  it("throws MalformedPriceMetafieldValueError for invalid JSON", () => {
    expect(() => parsePriceBearingMetafieldValue("not json")).toThrow(MalformedPriceMetafieldValueError);
  });

  it("throws for a JSON value that is not an object", () => {
    expect(() => parsePriceBearingMetafieldValue("42")).toThrow(MalformedPriceMetafieldValueError);
    expect(() => parsePriceBearingMetafieldValue("null")).toThrow(MalformedPriceMetafieldValueError);
  });

  it("throws when a required field is missing", () => {
    expect(() => parsePriceBearingMetafieldValue(JSON.stringify({ masterVariantId: "v1" }))).toThrow(
      MalformedPriceMetafieldValueError
    );
  });

  it("throws when a required field has the wrong type", () => {
    expect(() =>
      parsePriceBearingMetafieldValue(
        JSON.stringify({
          masterVariantId: "v1",
          priceCalculationId: "c1",
          currency: "USD",
          bankPaymentPriceMinorUnits: 100000, // number, not string — the exact hazard this guards against
          shopifyVariantId: "9",
          cardPriceAnchorMinorUnits: "104000",
        })
      )
    ).toThrow(MalformedPriceMetafieldValueError);
  });

  it("throws when shopifyVariantId or cardPriceAnchorMinorUnits is missing or the wrong type (R14)", () => {
    const base = {
      masterVariantId: "v1",
      priceCalculationId: "c1",
      currency: "USD",
      bankPaymentPriceMinorUnits: "100000",
    };
    expect(() => parsePriceBearingMetafieldValue(JSON.stringify(base))).toThrow(MalformedPriceMetafieldValueError);
    expect(() =>
      parsePriceBearingMetafieldValue(JSON.stringify({ ...base, shopifyVariantId: 9, cardPriceAnchorMinorUnits: "104000" }))
    ).toThrow(MalformedPriceMetafieldValueError);
    expect(() =>
      parsePriceBearingMetafieldValue(JSON.stringify({ ...base, shopifyVariantId: "9", cardPriceAnchorMinorUnits: 104000 }))
    ).toThrow(MalformedPriceMetafieldValueError);
  });
});

describe("compareMetafieldToPublishedCalculation", () => {
  it("is coherent when the embedded id equals the published id", () => {
    expect(compareMetafieldToPublishedCalculation("calc-1", "calc-1")).toEqual({
      coherent: true,
      embeddedPriceCalculationId: "calc-1",
      publishedPriceCalculationId: "calc-1",
    });
  });

  it("is incoherent when the embedded id differs from the published id", () => {
    const result = compareMetafieldToPublishedCalculation("calc-old", "calc-new");
    expect(result.coherent).toBe(false);
  });

  it("is incoherent when the variant has never published anything (null)", () => {
    const result = compareMetafieldToPublishedCalculation("calc-1", null);
    expect(result.coherent).toBe(false);
    expect(result.publishedPriceCalculationId).toBeNull();
  });
});
