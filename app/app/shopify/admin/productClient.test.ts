import { describe, expect, it } from "vitest";

import {
  AdminApiError,
  type AdminGraphqlClient,
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  renameProduct,
} from "./productClient.server";

/**
 * The Admin API reports failures with HTTP 200, which is the whole reason this
 * wrapper exists. A malformed document returns `errors`; a rejected mutation
 * returns `userErrors` inside an otherwise successful response. Most of these
 * tests are about those two paths, because the happy path is the one that
 * cannot silently lie to us.
 */

/** Records what was sent and replies with a canned envelope. */
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

describe("listProducts", () => {
  it("returns the products the API reported", async () => {
    const { client } = fakeClient({
      data: { products: { nodes: [{ id: "gid://shopify/Product/1", title: "Ring", status: "ACTIVE" }] } },
    });

    await expect(listProducts(client)).resolves.toEqual([
      { id: "gid://shopify/Product/1", title: "Ring", status: "ACTIVE" },
    ]);
  });

  it("returns an empty array for an empty catalog, and does not throw", async () => {
    // A store with no products is a normal state, not a failure — a fresh
    // development store starts this way.
    const { client } = fakeClient({ data: { products: { nodes: [] } } });
    await expect(listProducts(client)).resolves.toEqual([]);
  });

  it("tolerates a missing nodes collection", async () => {
    const { client } = fakeClient({ data: { products: {} } });
    await expect(listProducts(client)).resolves.toEqual([]);
  });

  it("passes the requested limit as a variable", async () => {
    const { client, calls } = fakeClient({ data: { products: { nodes: [] } } });
    await listProducts(client, 3);
    expect(calls[0]?.variables).toEqual({ first: 3 });
  });

  it("throws on top-level GraphQL errors despite a 200 response", async () => {
    const { client } = fakeClient({ errors: [{ message: "Field 'nope' doesn't exist" }] });
    await expect(listProducts(client)).rejects.toThrow(AdminApiError);
    await expect(listProducts(client)).rejects.toThrow(/nope/);
  });

  it("throws when the envelope carries no data at all", async () => {
    const { client } = fakeClient({});
    await expect(listProducts(client)).rejects.toThrow(/no data/);
  });
});

describe("getProduct", () => {
  it("returns null when the id does not resolve", async () => {
    // Shopify answers a missing product with data.product = null and no error.
    const { client } = fakeClient({ data: { product: null } });
    await expect(getProduct(client, "gid://shopify/Product/404")).resolves.toBeNull();
  });
});

describe("createProduct", () => {
  it("creates as DRAFT so a probe can never be purchasable", async () => {
    const { client, calls } = fakeClient({
      data: { productCreate: { product: { id: "gid://1", title: "probe", status: "DRAFT" }, userErrors: [] } },
    });

    await createProduct(client, "probe");
    expect(calls[0]?.variables).toEqual({ product: { title: "probe", status: "DRAFT" } });
  });

  it("uses the 2026-07 argument name, not the older one", async () => {
    // productCreate took `input:` in older API versions and takes `product:`
    // in this one. Verified by introspection against the live API; pinned here
    // so an example copied from older docs fails in CI rather than at runtime.
    const { client, calls } = fakeClient({
      data: { productCreate: { product: { id: "gid://1", title: "p", status: "DRAFT" }, userErrors: [] } },
    });
    await createProduct(client, "p");

    expect(calls[0]?.document).toMatch(/\$product:\s*ProductCreateInput!/);
    expect(calls[0]?.document).not.toMatch(/\$input:\s*ProductInput/);
  });

  it("THROWS on userErrors even though the HTTP call succeeded", async () => {
    // The defect this wrapper exists to prevent: a mutation that was rejected
    // being reported as a success because the response was 200.
    const { client } = fakeClient({
      data: {
        productCreate: {
          product: null,
          userErrors: [{ field: ["title"], message: "can't be blank" }],
        },
      },
    });

    await expect(createProduct(client, "")).rejects.toThrow(AdminApiError);
    await expect(createProduct(client, "")).rejects.toThrow(/title: can't be blank/);
  });
});

describe("renameProduct", () => {
  it("sends the id and the new title together", async () => {
    const { client, calls } = fakeClient({
      data: { productUpdate: { product: { id: "gid://1", title: "after", status: "DRAFT" }, userErrors: [] } },
    });

    const result = await renameProduct(client, "gid://1", "after");
    expect(calls[0]?.variables).toEqual({ product: { id: "gid://1", title: "after" } });
    expect(result.title).toBe("after");
  });

  it("throws on a rejected update", async () => {
    const { client } = fakeClient({
      data: { productUpdate: { product: null, userErrors: [{ field: null, message: "Product not found" }] } },
    });
    await expect(renameProduct(client, "gid://404", "x")).rejects.toThrow(/\(general\): Product not found/);
  });
});

describe("deleteProduct", () => {
  it("returns the deleted id, using the input: argument this mutation takes", async () => {
    // productDelete differs from create/update on this API version — it still
    // takes `input:`. Asserted because the inconsistency is easy to normalise
    // away by mistake.
    const { client, calls } = fakeClient({
      data: { productDelete: { deletedProductId: "gid://1", userErrors: [] } },
    });

    await expect(deleteProduct(client, "gid://1")).resolves.toBe("gid://1");
    expect(calls[0]?.document).toMatch(/\$input:\s*ProductDeleteInput!/);
    expect(calls[0]?.variables).toEqual({ input: { id: "gid://1" } });
  });

  it("throws rather than reporting a deletion that did not happen", async () => {
    const { client } = fakeClient({
      data: { productDelete: { deletedProductId: null, userErrors: [{ message: "not allowed" }] } },
    });
    await expect(deleteProduct(client, "gid://1")).rejects.toThrow(/not allowed/);
  });
});
