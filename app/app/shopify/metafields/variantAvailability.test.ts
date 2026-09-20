import { describe, expect, it } from "vitest";

import { AdminApiError, type AdminGraphqlClient } from "~/shopify/admin/productClient.server";

import { getVariantsAvailability } from "./variantAvailability.server";

/** Same discipline as priceMetafieldWriter.test.ts / priceSyncAdapter.test.ts. */
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

describe("getVariantsAvailability", () => {
  it("returns [] immediately with no Admin API call for an empty id list", async () => {
    const { client, calls } = fakeClient({ data: { nodes: [] } });
    const result = await getVariantsAvailability(client, []);
    expect(result.size).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("sends every requested id as GraphQL variables in one call", async () => {
    const { client, calls } = fakeClient({
      data: {
        nodes: [
          { id: "gid://shopify/ProductVariant/1", availableForSale: true },
          { id: "gid://shopify/ProductVariant/2", availableForSale: false },
        ],
      },
    });

    await getVariantsAvailability(client, [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0]?.variables).toEqual({
      ids: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"],
    });
  });

  it("maps each returned node's availableForSale by id", async () => {
    const { client } = fakeClient({
      data: {
        nodes: [
          { id: "gid://shopify/ProductVariant/1", availableForSale: true },
          { id: "gid://shopify/ProductVariant/2", availableForSale: false },
        ],
      },
    });

    const result = await getVariantsAvailability(client, [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    expect(result.get("gid://shopify/ProductVariant/1")).toBe(true);
    expect(result.get("gid://shopify/ProductVariant/2")).toBe(false);
  });

  it("omits an id from the map when Shopify returns null for it (deleted/unresolvable) — never defaults it to available", async () => {
    const { client } = fakeClient({
      data: {
        nodes: [null, { id: "gid://shopify/ProductVariant/2", availableForSale: true }],
      },
    });

    const result = await getVariantsAvailability(client, [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    expect(result.has("gid://shopify/ProductVariant/1")).toBe(false);
    expect(result.get("gid://shopify/ProductVariant/2")).toBe(true);
  });

  it("omits a node whose availableForSale is not a boolean (e.g. a non-ProductVariant node type)", async () => {
    const { client } = fakeClient({
      data: {
        nodes: [{ id: "gid://shopify/Product/1" }],
      },
    });

    const result = await getVariantsAvailability(client, ["gid://shopify/Product/1"]);
    expect(result.has("gid://shopify/Product/1")).toBe(false);
  });

  it("throws on top-level GraphQL errors, checked before inspecting nodes", async () => {
    const { client } = fakeClient({ errors: [{ message: "field does not exist" }] });
    await expect(getVariantsAvailability(client, ["gid://shopify/ProductVariant/1"])).rejects.toThrow(
      AdminApiError
    );
  });

  it("throws when the response has no nodes payload at all", async () => {
    const { client } = fakeClient({ data: {} });
    await expect(getVariantsAvailability(client, ["gid://shopify/ProductVariant/1"])).rejects.toThrow(
      AdminApiError
    );
  });
});
