import { describe, expect, it } from "vitest";

import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";

import { buildVariantBankPaymentPriceMetafield } from "./priceMetafieldPayload";
import { NoMetafieldsToWriteError, setPriceMetafields } from "./priceMetafieldWriter.server";

/**
 * Asserts on the SERIALISED GraphQL variables, and on every HTTP-200
 * failure shape the Admin API is documented to use — same discipline as
 * `priceSyncAdapter.test.ts`.
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

function okReply(written: { namespace: string; key: string; ownerType: string }[]) {
  return {
    data: {
      metafieldsSet: {
        metafields: written.map((w, i) => ({ id: `gid://shopify/Metafield/${i}`, ...w })),
        userErrors: [],
      },
    },
  };
}

const A_PRICE_INPUT = buildVariantBankPaymentPriceMetafield("gid://shopify/ProductVariant/9", {
  masterVariantId: "variant-1",
  priceCalculationId: "calc-1",
  bankPaymentPriceMinorUnits: 100_000n,
  regularCardPriceMinorUnits: 104_000n,
  bankPaymentSavingsMinorUnits: 4_000n,
  currency: "USD",
  appliedUpliftRate: "0.040000",
  appliedTierLabel: "$1,000–$2,499.99",
});

describe("setPriceMetafields — sends the exact input as GraphQL variables", () => {
  it("serializes ownerId/namespace/key/type/value for each input", async () => {
    const { client, calls } = fakeClient(
      okReply([{ namespace: "carat", key: "bank_payment_price_minor_units", ownerType: "PRODUCTVARIANT" }])
    );

    const result = await setPriceMetafields(client, [A_PRICE_INPUT]);

    expect(calls[0]?.variables).toEqual({
      metafields: [
        {
          ownerId: "gid://shopify/ProductVariant/9",
          namespace: "carat",
          key: "bank_payment_price_minor_units",
          type: "json",
          value: A_PRICE_INPUT.value,
        },
      ],
    });
    expect(result.writtenKeys).toEqual(["carat.bank_payment_price_minor_units"]);
  });

  it("writes several metafields in one call", async () => {
    const { client } = fakeClient(
      okReply([
        { namespace: "carat", key: "bank_payment_price_minor_units", ownerType: "PRODUCTVARIANT" },
        { namespace: "carat", key: "bank_payment_eligible", ownerType: "PRODUCTVARIANT" },
      ])
    );

    const result = await setPriceMetafields(client, [
      A_PRICE_INPUT,
      { ownerId: "gid://shopify/ProductVariant/9", namespace: "carat", key: "bank_payment_eligible", type: "boolean", value: "true" },
    ]);

    expect(result.writtenKeys).toEqual(["carat.bank_payment_price_minor_units", "carat.bank_payment_eligible"]);
  });
});

describe("boundary and error conditions", () => {
  it("throws NoMetafieldsToWriteError for an empty input list, before any call", async () => {
    const { client, calls } = fakeClient(okReply([]));
    await expect(setPriceMetafields(client, [])).rejects.toBeInstanceOf(NoMetafieldsToWriteError);
    expect(calls).toHaveLength(0);
  });

  it("throws on top-level GraphQL errors", async () => {
    const { client } = fakeClient({ errors: [{ message: "invalid value 'not-json' for type Json" }] });
    await expect(setPriceMetafields(client, [A_PRICE_INPUT])).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws on userErrors", async () => {
    const { client } = fakeClient({
      data: {
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: ["metafields", "0", "value"], message: "Value is invalid for metafield type" }],
        },
      },
    });
    await expect(setPriceMetafields(client, [A_PRICE_INPUT])).rejects.toThrow(/Value is invalid/);
  });

  it("throws when the response has no metafieldsSet payload at all", async () => {
    const { client } = fakeClient({ data: {} });
    await expect(setPriceMetafields(client, [A_PRICE_INPUT])).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws when fewer metafields are confirmed than requested, even with no userErrors", async () => {
    // THE HAZARD THIS TEST PINS: a response reporting neither failure nor
    // full success must not be read as success.
    const { client } = fakeClient(okReply([]));
    await expect(setPriceMetafields(client, [A_PRICE_INPUT])).rejects.toThrow(
      /requested 1 metafield write\(s\) but Shopify confirmed 0/
    );
  });
});
