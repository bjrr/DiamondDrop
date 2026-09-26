import { describe, expect, it } from "vitest";

import { AdminApiError } from "./productClient.server";
import { RecordingWarrantyOrderLookupPort, ShopifyWarrantyOrderLookupAdapter } from "./warrantyOrderLookupAdapter.server";

function fakeClient(response: unknown) {
  const calls: { query: string; variables: Record<string, unknown> | undefined }[] = [];
  return {
    client: {
      async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
        calls.push({ query, variables: options?.variables });
        return { json: async () => response };
      },
    },
    calls,
  };
}

describe("ShopifyWarrantyOrderLookupAdapter.findOrderByName", () => {
  it("sends a name: search filter built from the given order name", async () => {
    const { client, calls } = fakeClient({ data: { orders: { nodes: [] } } });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    await adapter.findOrderByName("#1001");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables).toEqual({ searchQuery: "name:#1001" });
  });

  it("returns null when no order matches", async () => {
    const { client } = fakeClient({ data: { orders: { nodes: [] } } });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    await expect(adapter.findOrderByName("#9999")).resolves.toBeNull();
  });

  it("maps the matched order and its line items", async () => {
    const { client } = fakeClient({
      data: {
        orders: {
          nodes: [
            {
              id: "gid://shopify/Order/1",
              name: "#1001",
              email: "purchaser@example.com",
              customer: { id: "gid://shopify/Customer/1" },
              lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", name: "14k Gold Ring", quantity: 1 }] },
            },
          ],
        },
      },
    });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    const result = await adapter.findOrderByName("#1001");
    expect(result).toEqual({
      orderGid: "gid://shopify/Order/1",
      orderName: "#1001",
      customerGid: "gid://shopify/Customer/1",
      orderEmail: "purchaser@example.com",
      lineItems: [{ lineRef: "gid://shopify/LineItem/1", title: "14k Gold Ring", quantity: 1 }],
    });
  });

  it("handles a guest order with no customer on file (customerGid null)", async () => {
    const { client } = fakeClient({
      data: {
        orders: {
          nodes: [
            {
              id: "gid://shopify/Order/1",
              name: "#1001",
              email: "purchaser@example.com",
              customer: null,
              lineItems: { nodes: [] },
            },
          ],
        },
      },
    });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    const result = await adapter.findOrderByName("#1001");
    expect(result?.customerGid).toBeNull();
  });

  it("throws AdminApiError on a GraphQL error response", async () => {
    const { client } = fakeClient({ errors: [{ message: "Throttled" }] });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    await expect(adapter.findOrderByName("#1001")).rejects.toBeInstanceOf(AdminApiError);
  });
});

describe("ShopifyWarrantyOrderLookupAdapter.findOrderByGid", () => {
  it("queries by id and maps the result", async () => {
    const { client, calls } = fakeClient({
      data: {
        order: {
          id: "gid://shopify/Order/1",
          name: "#1001",
          email: "purchaser@example.com",
          customer: { id: "gid://shopify/Customer/1" },
          lineItems: { nodes: [] },
        },
      },
    });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    const result = await adapter.findOrderByGid("gid://shopify/Order/1");
    expect(calls[0]!.variables).toEqual({ id: "gid://shopify/Order/1" });
    expect(result?.orderName).toBe("#1001");
  });

  it("returns null when the order does not exist", async () => {
    const { client } = fakeClient({ data: { order: null } });
    const adapter = new ShopifyWarrantyOrderLookupAdapter(client);
    await expect(adapter.findOrderByGid("gid://shopify/Order/999")).resolves.toBeNull();
  });
});

describe("RecordingWarrantyOrderLookupPort", () => {
  it("resolves a seeded order by name, and the same order by its GID", async () => {
    const port = new RecordingWarrantyOrderLookupPort();
    port.seedByName("#1001", {
      orderGid: "gid://shopify/Order/1",
      customerGid: null,
      orderEmail: "purchaser@example.com",
      lineItems: [{ lineRef: "gid://shopify/LineItem/1", title: "Ring", quantity: 1 }],
    });

    await expect(port.findOrderByName("#1001")).resolves.toMatchObject({ orderName: "#1001" });
    await expect(port.findOrderByGid("gid://shopify/Order/1")).resolves.toMatchObject({ orderName: "#1001" });
    await expect(port.findOrderByName("#404")).resolves.toBeNull();
  });

  it("records every call made against it", async () => {
    const port = new RecordingWarrantyOrderLookupPort();
    await port.findOrderByName("#1001");
    await port.findOrderByGid("gid://shopify/Order/1");
    expect(port.byNameCalls).toEqual(["#1001"]);
    expect(port.byGidCalls).toEqual(["gid://shopify/Order/1"]);
  });
});
