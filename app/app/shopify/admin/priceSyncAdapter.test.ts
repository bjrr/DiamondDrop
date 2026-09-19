import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import { ShopifyPriceSyncAdapter, minorUnitsToDecimalString } from "./priceSyncAdapter.server";

/**
 * Asserts on the SERIALISED GraphQL variables, never an intermediate object —
 * the whole class of bug this adapter exists to prevent is a correct-looking
 * value serialising to the wrong number.
 */
function fakeClient(reply: unknown) {
  const calls: { document: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      calls.push({ document, variables: options?.variables });
      return { json: async () => reply };
    },
  };
  return { client, calls };
}

function okReply(id: string, price: string) {
  return {
    data: {
      productVariantsBulkUpdate: {
        product: { id: "gid://shopify/Product/1" },
        productVariants: [{ id, price }],
        userErrors: [],
      },
    },
  };
}

describe("minorUnitsToDecimalString", () => {
  it("formats a typical price with cents", () => {
    expect(minorUnitsToDecimalString(123456n)).toBe("1234.56");
  });

  it("pads a sub-dollar minor amount", () => {
    expect(minorUnitsToDecimalString(5n)).toBe("0.05");
  });

  it("formats an exact multiple of the major unit with .00", () => {
    expect(minorUnitsToDecimalString(500000n)).toBe("5000.00");
  });

  it("formats zero", () => {
    expect(minorUnitsToDecimalString(0n)).toBe("0.00");
  });

  it("refuses a negative amount rather than emitting a signed price", () => {
    expect(() => minorUnitsToDecimalString(-100n)).toThrow(/negative/);
  });

  it("supports a 3-decimal minor unit ratio without truncation", () => {
    // Not a currency this app uses today, but the function must not silently
    // assume 2 decimal places forever (see resolveInputs.server.ts's own note
    // on the same hard-coded-100 hazard).
    expect(minorUnitsToDecimalString(1234n, 1000n)).toBe("1.234");
  });
});

describe("ShopifyPriceSyncAdapter — sends the exact price it was given", () => {
  it("sends productId, variant id and the exact decimal price as GraphQL variables", async () => {
    const { client, calls } = fakeClient(okReply("gid://shopify/ProductVariant/9", "1234.56"));
    const adapter = new ShopifyPriceSyncAdapter(client);

    await adapter.applyVariantPrice({
      shopifyProductGid: "gid://shopify/Product/1",
      shopifyVariantGid: "gid://shopify/ProductVariant/9",
      regularCardPrice: Money.fromMinorUnits(123456n, "USD"),
      priceCalculationId: "calc-1",
    });

    expect(calls[0]?.variables).toEqual({
      productId: "gid://shopify/Product/1",
      variants: [{ id: "gid://shopify/ProductVariant/9", price: "1234.56" }],
    });
  });

  it("the mutation document names productVariantsBulkUpdate and takes a productId — not a single-variant mutation", async () => {
    // productVariantUpdate does not exist for price on this API surface —
    // pinned so a future "simplification" back to a per-variant mutation
    // fails here rather than at the first real store.
    const { client, calls } = fakeClient(okReply("gid://x", "1.00"));
    const adapter = new ShopifyPriceSyncAdapter(client);
    await adapter.applyVariantPrice({
      shopifyProductGid: "gid://shopify/Product/1",
      shopifyVariantGid: "gid://x",
      regularCardPrice: Money.fromMinorUnits(100n, "USD"),
      priceCalculationId: "calc-1",
    });
    expect(calls[0]?.document).toMatch(/productVariantsBulkUpdate/);
    expect(calls[0]?.document).toMatch(/\$productId:\s*ID!/);
  });

  /**
   * GUARD THE GUARD. A test that passed because the bank and card price
   * happened to match a fixture would prove nothing — this fixture is chosen
   * so the two figures differ by a large, unmistakable margin ($1,000 vs
   * $1,050), so a regression that accidentally published the bank price
   * instead of the card price fails this test loudly rather than sliding
   * through on a coincidence.
   */
  it("publishes the CARD price it is handed, not some other value — proven with prices that visibly differ", async () => {
    const bankPaymentPriceMinorUnits = 100000n; // $1,000.00 — NOT what should be sent
    const regularCardPriceMinorUnits = 105000n; // $1,050.00 — what MUST be sent

    const { client, calls } = fakeClient(okReply("gid://x", "1050.00"));
    const adapter = new ShopifyPriceSyncAdapter(client);

    await adapter.applyVariantPrice({
      shopifyProductGid: "gid://shopify/Product/1",
      shopifyVariantGid: "gid://x",
      regularCardPrice: Money.fromMinorUnits(regularCardPriceMinorUnits, "USD"),
      priceCalculationId: "calc-1",
    });

    const sentPrice = (calls[0]?.variables?.variants as { price: string }[])[0]?.price;
    expect(sentPrice).toBe("1050.00");
    expect(sentPrice).not.toBe(minorUnitsToDecimalString(bankPaymentPriceMinorUnits));
  });
});

describe("ShopifyPriceSyncAdapter — the Admin API's 200-with-userErrors hazard", () => {
  it("throws AdminApiError when userErrors is non-empty, even though the HTTP call succeeded", async () => {
    const { client } = fakeClient({
      data: {
        productVariantsBulkUpdate: {
          product: null,
          productVariants: [],
          userErrors: [{ field: ["variants", "0", "price"], message: "Price must be greater than 0" }],
        },
      },
    });
    const adapter = new ShopifyPriceSyncAdapter(client);

    await expect(
      adapter.applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://x",
        regularCardPrice: Money.fromMinorUnits(0n, "USD"),
        priceCalculationId: "calc-1",
      })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws on top-level GraphQL errors", async () => {
    const { client } = fakeClient({ errors: [{ message: "Throttled" }] });
    const adapter = new ShopifyPriceSyncAdapter(client);

    await expect(
      adapter.applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://x",
        regularCardPrice: Money.fromMinorUnits(100n, "USD"),
        priceCalculationId: "calc-1",
      })
    ).rejects.toThrow(/Throttled/);
  });

  it("throws when the envelope carries no productVariantsBulkUpdate payload at all", async () => {
    const { client } = fakeClient({ data: {} });
    const adapter = new ShopifyPriceSyncAdapter(client);

    await expect(
      adapter.applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://x",
        regularCardPrice: Money.fromMinorUnits(100n, "USD"),
        priceCalculationId: "calc-1",
      })
    ).rejects.toThrow(/no productVariantsBulkUpdate payload/);
  });

  it("throws when neither userErrors nor an updated variant is present", async () => {
    const { client } = fakeClient({
      data: { productVariantsBulkUpdate: { product: { id: "gid://1" }, productVariants: [], userErrors: [] } },
    });
    const adapter = new ShopifyPriceSyncAdapter(client);

    await expect(
      adapter.applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://x",
        regularCardPrice: Money.fromMinorUnits(100n, "USD"),
        priceCalculationId: "calc-1",
      })
    ).rejects.toThrow(/no.*updated variant/);
  });

  it("returns an appliedAt timestamp on success", async () => {
    const { client } = fakeClient(okReply("gid://x", "1.00"));
    const adapter = new ShopifyPriceSyncAdapter(client);

    const result = await adapter.applyVariantPrice({
      shopifyProductGid: "gid://shopify/Product/1",
      shopifyVariantGid: "gid://x",
      regularCardPrice: Money.fromMinorUnits(100n, "USD"),
      priceCalculationId: "calc-1",
    });

    expect(result.appliedAt).toBeInstanceOf(Date);
  });
});
