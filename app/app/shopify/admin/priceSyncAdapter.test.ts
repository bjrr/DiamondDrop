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

  /**
   * ══════════════════════════════════════════════════════════════════════
   * CRITERION 60 — CONTRACT TESTS AGAINST REAL OBSERVED RESPONSES
   * ══════════════════════════════════════════════════════════════════════
   *
   * The payloads below are not invented. They were captured 2026-09-19 from
   * caratforus-dev.myshopify.com, Admin API 2026-07, using a THROWAWAY
   * product created and deleted inside the verification run. A follow-up
   * query for the verification title returned [] — the dev store was left
   * clean and no existing data was touched. No token or secret material was
   * printed, logged or committed: the run read the stored offline session
   * token directly and never emitted it.
   *
   * THE ORDER OF CHECKS IS ITSELF THE CONTRACT, because every failure mode
   * this API has arrives on HTTP 200:
   *
   *   1. HTTP 200 is NEVER sufficient for success.
   *   2. Top-level GraphQL `errors` fail FIRST. A coercion failure never
   *      populates `userErrors`, so checking userErrors first would let a
   *      malformed price through entirely unreported.
   *   3. Then `userErrors`.
   *   4. Then the EXPECTED variant must be present, at the price we sent.
   *   5. Only after all four may the caller mark the intent `synced`.
   *
   * If a future API version changes any of this, these are the tests that
   * should fail — before a real price sync discovers it.
   */
  describe("criterion 60 — case 1: SUCCESS", () => {
    it("accepts the live success payload: userErrors empty, expected variant, price echoed exactly", async () => {
      // 2080.00 is the policy Example D final rounded Regular/Card Price. The
      // live read-back query returned this same string independently of the
      // mutation response, which is what makes it a verified round trip
      // rather than a self-report.
      const { client, calls } = fakeClient({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [
              { id: "gid://shopify/ProductVariant/52378659586349", price: "2080.00" },
            ],
            userErrors: [],
          },
        },
      });

      const result = await new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      });

      expect(result.appliedAt).toBeInstanceOf(Date);
      expect(calls[0]!.variables).toMatchObject({
        variants: [{ id: "gid://shopify/ProductVariant/52378659586349", price: "2080.00" }],
      });
    });

    it("rejects a success-shaped response naming a DIFFERENT variant than requested", async () => {
      // This is a BULK mutation returning an array; nothing in the schema
      // promises the element back is the one asked about. Empty userErrors
      // plus a variant present would otherwise read as success, and the
      // caller would write synced and a compare-and-set anchor on it.
      const { client } = fakeClient({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{ id: "gid://shopify/ProductVariant/999999", price: "2080.00" }],
            userErrors: [],
          },
        },
      });

      await expect(
        new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      })
      ).rejects.toThrow(/expected variant .* but the response named/);
    });

    it("rejects a success-shaped response echoing a DIFFERENT price than sent", async () => {
      // Publishing a price other than the approved one is the worst outcome
      // this slice can produce. If Shopify stores something different from
      // what we sent, that is a sync failure, not a silent success.
      const { client } = fakeClient({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [
              { id: "gid://shopify/ProductVariant/52378659586349", price: "2079.00" },
            ],
            userErrors: [],
          },
        },
      });

      await expect(
        new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      })
      ).rejects.toThrow(/published price mismatch/);
    });
  });

  describe("criterion 60 — case 2: MUTATION-LEVEL REJECTION", () => {
    // Captured verbatim from a bad variant id: HTTP 200, non-empty
    // userErrors, productVariants NULL — not an empty array. Code written
    // against an assumed [] reads ?.[0] on something that is not an array and
    // folds a real "variant does not exist" into a generic "no updated
    // variant", losing the actual reason.
    const LIVE_REJECTION = {
      data: {
        productVariantsBulkUpdate: {
          productVariants: null,
          userErrors: [
            { field: ["variants", "0", "id"], message: "Product variant does not exist" },
          ],
        },
      },
    };

    it("treats a 200 carrying userErrors as a SYNC FAILURE and surfaces the real reason", async () => {
      const { client } = fakeClient(LIVE_REJECTION);
      await expect(
        new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      })
      ).rejects.toThrow(/Product variant does not exist/);
    });

    it("throws AdminApiError specifically, so the caller leaves the intent unsynced", async () => {
      const { client } = fakeClient(LIVE_REJECTION);
      await expect(
        new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      })
      ).rejects.toBeInstanceOf(AdminApiError);
    });
  });

  describe("criterion 60 — case 3: GRAPHQL VARIABLE/COERCION FAILURE", () => {
    it("treats top-level errors on a 200 as a SYNC FAILURE", async () => {
      // Captured verbatim from a malformed price: HTTP 200, top-level errors,
      // and NO productVariantsBulkUpdate payload at all, so userErrors never
      // exists to be checked.
      const { client } = fakeClient({
        errors: [
          {
            message:
              "Variable $variants of type [ProductVariantsBulkInput!]! was provided invalid value for 0.price (invalid money 'not-a-price')",
          },
        ],
      });

      await expect(
        new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      })
      ).rejects.toThrow(/invalid money/);
    });

    it("checks top-level errors BEFORE userErrors — proven with a response carrying both", async () => {
      // The ordering test. A payload with both must report the top-level
      // error, because that is the one explaining why nothing happened.
      // Reversing the order reports a downstream symptom and hides the cause,
      // and for a pure coercion failure there is no userErrors to fall back
      // on at all, so the wrong order loses the failure entirely.
      const { client } = fakeClient({
        errors: [{ message: "TOP LEVEL: invalid money" }],
        data: {
          productVariantsBulkUpdate: {
            productVariants: null,
            userErrors: [
              { field: ["variants"], message: "USER ERROR: must not be reported first" },
            ],
          },
        },
      });

      await expect(
        new ShopifyPriceSyncAdapter(client).applyVariantPrice({
        shopifyProductGid: "gid://shopify/Product/1",
        shopifyVariantGid: "gid://shopify/ProductVariant/52378659586349",
        regularCardPrice: Money.fromMinorUnits(208_000n, "USD"),
        priceCalculationId: "calc-1",
      })
      ).rejects.toThrow(/TOP LEVEL/);
    });
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
