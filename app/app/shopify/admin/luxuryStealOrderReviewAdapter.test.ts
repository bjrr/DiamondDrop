import { describe, expect, it } from "vitest";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import { ShopifyLuxuryStealOrderReviewAdapter, buildLuxuryStealHoldHandle } from "./luxuryStealOrderReviewAdapter.server";

/** Same fake-client shape as `draftOrderAdapter.test.ts` — asserts on the SERIALISED variables, never an intermediate object. */
function fakeClient(replies: unknown[] | unknown) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: { document: string; variables?: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      calls.push({ document, variables: options?.variables });
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      return { json: async () => reply };
    },
  };
  return { client, calls };
}

describe("ShopifyLuxuryStealOrderReviewAdapter.addOrderTags", () => {
  it("sends tagsAdd with the exact order id and tags", async () => {
    const { client, calls } = fakeClient({
      data: { tagsAdd: { node: { id: "gid://shopify/Order/1" }, userErrors: [] } },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await adapter.addOrderTags({ orderGid: "gid://shopify/Order/1", tags: ["Luxury Steal"] });

    expect(calls[0]?.document).toMatch(/tagsAdd/);
    expect(calls[0]?.variables).toEqual({ id: "gid://shopify/Order/1", tags: ["Luxury Steal"] });
  });

  it("makes no call at all for an empty tag list", async () => {
    const { client, calls } = fakeClient({});
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await adapter.addOrderTags({ orderGid: "gid://shopify/Order/1", tags: [] });

    expect(calls).toHaveLength(0);
  });

  it("throws on a userError rather than treating it as applied", async () => {
    const { client } = fakeClient({
      data: { tagsAdd: { node: null, userErrors: [{ field: ["tags"], message: "invalid tag" }] } },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.addOrderTags({ orderGid: "gid://shopify/Order/1", tags: ["Luxury Steal"] })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws when the response names a different order than the one sent", async () => {
    const { client } = fakeClient({
      data: { tagsAdd: { node: { id: "gid://shopify/Order/999" }, userErrors: [] } },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.addOrderTags({ orderGid: "gid://shopify/Order/1", tags: ["Luxury Steal"] })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws on a top-level GraphQL error (coercion/authorization) rather than swallowing it", async () => {
    const { client } = fakeClient({ errors: [{ message: "Access denied" }] });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.addOrderTags({ orderGid: "gid://shopify/Order/1", tags: ["Luxury Steal"] })
    ).rejects.toBeInstanceOf(AdminApiError);
  });
});

describe("ShopifyLuxuryStealOrderReviewAdapter.listFulfillmentOrders", () => {
  it("returns every fulfilment order node with its status", async () => {
    const { client, calls } = fakeClient({
      data: {
        order: {
          id: "gid://shopify/Order/1",
          fulfillmentOrders: {
            nodes: [
              { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
              { id: "gid://shopify/FulfillmentOrder/2", status: "IN_PROGRESS" },
            ],
          },
        },
      },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    const result = await adapter.listFulfillmentOrders("gid://shopify/Order/1");

    expect(result).toEqual([
      { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
      { id: "gid://shopify/FulfillmentOrder/2", status: "IN_PROGRESS" },
    ]);
    expect(calls[0]?.variables).toEqual({ id: "gid://shopify/Order/1" });
  });

  it("returns [] rather than throwing when the order has no fulfilment orders yet", async () => {
    const { client } = fakeClient({
      data: { order: { id: "gid://shopify/Order/1", fulfillmentOrders: { nodes: [] } } },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(adapter.listFulfillmentOrders("gid://shopify/Order/1")).resolves.toEqual([]);
  });

  it("returns [] rather than throwing when the order node itself is null", async () => {
    const { client } = fakeClient({ data: { order: null } });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(adapter.listFulfillmentOrders("gid://shopify/Order/1")).resolves.toEqual([]);
  });
});

describe("buildLuxuryStealHoldHandle", () => {
  it("derives the same handle every time for the same fulfilment order, and a different one for a different order", () => {
    // Redelivery recomputes the handle from the payload alone. Anything
    // time-based or random here would silently defeat the duplicate
    // detection the handle exists to enable — this is what pins that.
    const a1 = buildLuxuryStealHoldHandle("gid://shopify/FulfillmentOrder/1");
    const a2 = buildLuxuryStealHoldHandle("gid://shopify/FulfillmentOrder/1");
    const b = buildLuxuryStealHoldHandle("gid://shopify/FulfillmentOrder/2");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("is namespaced so it cannot collide with a hold placed by a merchant or another app", () => {
    expect(buildLuxuryStealHoldHandle("gid://shopify/FulfillmentOrder/1")).toMatch(/^carat:/);
  });
});

describe("ShopifyLuxuryStealOrderReviewAdapter.holdFulfillmentOrder", () => {
  /**
   * FIELD NAME ASSERTED, NOT JUST VALUE — same discipline
   * `draftOrderAdapter.test.ts` uses for `priceOverride`. `reason` MUST be
   * the enum value `OTHER`, `reasonNotes` MUST carry exactly what was given
   * (D28 forbids writing to `Order.note`, so this is the only place the
   * staff explanation can go), and `handle` MUST be the deterministic,
   * namespaced value `buildLuxuryStealHoldHandle` computes — live-verified
   * real on the 2026-07 schema, 2026-09-24.
   */
  it("sends reason OTHER, the exact reasonNotes, and the deterministic handle — and nothing else", async () => {
    const { client, calls } = fakeClient({
      data: {
        fulfillmentOrderHold: {
          fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await adapter.holdFulfillmentOrder({
      fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1",
      reasonNotes: "Unverified Luxury Steal acknowledgment — staff review required.",
    });

    expect(calls[0]?.document).toMatch(/fulfillmentOrderHold/);
    expect(calls[0]?.variables).toEqual({
      id: "gid://shopify/FulfillmentOrder/1",
      fulfillmentHold: {
        reason: "OTHER",
        reasonNotes: "Unverified Luxury Steal acknowledgment — staff review required.",
        handle: buildLuxuryStealHoldHandle("gid://shopify/FulfillmentOrder/1"),
      },
    });
  });

  it("applies the hold and returns the resulting status when there are no userErrors", async () => {
    const { client } = fakeClient({
      data: {
        fulfillmentOrderHold: {
          fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
          userErrors: [],
        },
      },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    const result = await adapter.holdFulfillmentOrder({
      fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1",
      reasonNotes: "Unverified Luxury Steal acknowledgment — staff review required.",
    });

    expect(result).toEqual({ status: "ON_HOLD", recognizedVia: "applied", userErrorCodes: [] });
  });

  /**
   * THE PRIMARY IDEMPOTENCY PATH (live-verified 2026-09-24). Shopify's own
   * typed `DUPLICATE_FULFILLMENT_HOLD_HANDLE` code — returned because we
   * sent a stable handle — is recognised WITHOUT a status re-query: exactly
   * one call, the mutation itself.
   */
  it("treats DUPLICATE_FULFILLMENT_HOLD_HANDLE as already-held-by-us, with no status re-query", async () => {
    const { client, calls } = fakeClient({
      data: {
        fulfillmentOrderHold: {
          fulfillmentOrder: null,
          userErrors: [
            {
              field: ["fulfillmentHold", "handle"],
              message: "Hold handle has already been taken",
              code: "DUPLICATE_FULFILLMENT_HOLD_HANDLE",
            },
          ],
        },
      },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    const result = await adapter.holdFulfillmentOrder({
      fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1",
      reasonNotes: "Unverified Luxury Steal acknowledgment — staff review required.",
    });

    expect(result).toEqual({
      status: "ON_HOLD",
      recognizedVia: "duplicate_handle",
      userErrorCodes: ["DUPLICATE_FULFILLMENT_HOLD_HANDLE"],
    });
    // Exactly one call: the mutation. No status re-query was needed.
    expect(calls).toHaveLength(1);
  });

  /**
   * THE SECONDARY FALLBACK PATH. A userError with NO duplicate-handle code
   * is followed by a re-query for status; ON_HOLD is recognised as success
   * regardless of what the error actually said, but is reported distinctly
   * from the primary path (`recognizedVia: "status_fallback"`, less precise
   * — this fulfilment order is protected, but not provably by OUR handle).
   */
  it("falls back to a status re-check for any OTHER userError, and reports it distinctly from the primary path", async () => {
    const { client, calls } = fakeClient([
      {
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: null,
            userErrors: [{ field: ["fulfillmentOrder"], message: "some unpredictable wording" }],
          },
        },
      },
      { data: { fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" } } },
    ]);
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    const result = await adapter.holdFulfillmentOrder({
      fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1",
      reasonNotes: "reason",
    });

    expect(result).toEqual({ status: "ON_HOLD", recognizedVia: "status_fallback", userErrorCodes: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.document).toMatch(/fulfillmentOrderStatus|FulfillmentOrderStatus/i);
  });

  /**
   * TWO REAL, DISTINCT CODES ARE NEVER SWALLOWED AS GENERIC (live-verified
   * 2026-09-24) — both fall through to the status fallback (a fulfilment
   * order blocked for either reason may still be genuinely protected by
   * something else), but `userErrorCodes` always names exactly which code
   * fired, so neither is indistinguishable from an unrecognised failure in
   * the handler's audit trail.
   */
  it.each(["FULFILLMENT_ORDER_HOLD_LIMIT_REACHED", "TAKEN"])(
    "carries the %s code through in userErrorCodes rather than losing it in a generic fallback",
    async (code) => {
      const { client } = fakeClient([
        {
          data: {
            fulfillmentOrderHold: {
              fulfillmentOrder: null,
              userErrors: [{ field: null, message: "distinct real code", code }],
            },
          },
        },
        { data: { fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" } } },
      ]);
      const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

      const result = await adapter.holdFulfillmentOrder({
        fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1",
        reasonNotes: "x",
      });

      expect(result).toEqual({ status: "ON_HOLD", recognizedVia: "status_fallback", userErrorCodes: [code] });
    }
  );

  it("throws when a userError is returned and the re-check finds the fulfillment order NOT on hold — a genuine failure", async () => {
    const { client } = fakeClient([
      {
        data: {
          fulfillmentOrderHold: {
            fulfillmentOrder: null,
            userErrors: [{ field: ["id"], message: "some other rejection" }],
          },
        },
      },
      { data: { fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" } } },
    ]);
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.holdFulfillmentOrder({ fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1", reasonNotes: "x" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws when the re-check itself finds no such fulfillment order", async () => {
    const { client } = fakeClient([
      {
        data: {
          fulfillmentOrderHold: { fulfillmentOrder: null, userErrors: [{ field: null, message: "not found" }] },
        },
      },
      { data: { fulfillmentOrder: null } },
    ]);
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.holdFulfillmentOrder({ fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1", reasonNotes: "x" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws on a top-level GraphQL error immediately, without attempting a follow-up status query", async () => {
    const { client, calls } = fakeClient({ errors: [{ message: "Throttled" }] });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.holdFulfillmentOrder({ fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1", reasonNotes: "x" })
    ).rejects.toBeInstanceOf(AdminApiError);
    expect(calls).toHaveLength(1);
  });

  it("throws when the response carries no userErrors but also no fulfillmentOrder (the neither-succeeded-nor-errored case)", async () => {
    const { client } = fakeClient({
      data: { fulfillmentOrderHold: { fulfillmentOrder: null, userErrors: [] } },
    });
    const adapter = new ShopifyLuxuryStealOrderReviewAdapter(client);

    await expect(
      adapter.holdFulfillmentOrder({ fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1", reasonNotes: "x" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });
});
