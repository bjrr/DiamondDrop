import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import { ShopifyRmaRemedyExecutionAdapter } from "./rmaRemedyExecutionAdapter.server";

/** Same fake-client shape as `luxuryStealOrderReviewAdapter.test.ts` — a queue of replies, one per sequential `graphql()` call. */
function fakeClient(replies: unknown[]) {
  const queue = [...replies];
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

const ORDER_GID = "gid://shopify/Order/1";
const LINE_GID = "gid://shopify/LineItem/1";
const CUSTOMER_GID = "gid://shopify/Customer/1";

/**
 * D10 FENCE — store credit must NEVER be given an expiry.
 *
 * This is a source-text check and that is deliberate. Live introspection on
 * 2026-09-27 confirmed `StoreCreditAccountCreditInput` really does expose an
 * `expiresAt` field, so setting one is a single plausible-looking line away.
 * D10 (docs/ARCHITECTURE-MVP1.md) is explicit: merchandise credit does not
 * expire and no expiration date is to be set in Shopify. A behavioural test
 * cannot catch this — issuing real store credit to prove we did not set an
 * expiry is money movement, not a test — so the guard is that the adapter
 * never names the field at all.
 */
describe("D10 — the adapter cannot set a store-credit expiry", () => {
  const adapterSource = readFileSync(
    fileURLToPath(new URL("./rmaRemedyExecutionAdapter.server.ts", import.meta.url)),
    "utf8"
  );

  it("never mentions expiresAt, the one input field D10 forbids", () => {
    expect(adapterSource).not.toMatch(/expiresAt/);
  });

  it("GUARDS THE GUARD — the source it reads is the real adapter, not an empty string", () => {
    // Without this, a bad path would make the assertion above vacuously true.
    expect(adapterSource).toMatch(/storeCreditAccountCredit/);
    expect(adapterSource.length).toBeGreaterThan(1000);
  });
});

describe("getSuggestedRefundForLine", () => {
  it("returns the merchandise/tax split from Shopify's own suggested refund", async () => {
    const { client, calls } = fakeClient([
      { data: { order: { id: ORDER_GID, currencyCode: "USD", lineItems: { nodes: [{ id: LINE_GID, refundableQuantity: 1 }] } } } },
      {
        data: {
          order: {
            id: ORDER_GID,
            suggestedRefund: {
              subtotalSet: { shopMoney: { amount: "250.00", currencyCode: "USD" } },
              totalTaxSet: { shopMoney: { amount: "18.75", currencyCode: "USD" } },
            },
          },
        },
      },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);

    const result = await adapter.getSuggestedRefundForLine({ orderGid: ORDER_GID, lineItemGid: LINE_GID });

    expect(result).toEqual({ merchandiseAmountMinorUnits: 25000n, taxAmountMinorUnits: 1875n, currency: "USD" });
    expect(calls[1]?.variables).toEqual({ orderId: ORDER_GID, refundLineItems: [{ lineItemId: LINE_GID, quantity: 1 }] });
  });

  it("returns null — never zero, never a guess — when the line has nothing left to refund", async () => {
    const { client } = fakeClient([
      { data: { order: { id: ORDER_GID, currencyCode: "USD", lineItems: { nodes: [{ id: LINE_GID, refundableQuantity: 0 }] } } } },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);

    const result = await adapter.getSuggestedRefundForLine({ orderGid: ORDER_GID, lineItemGid: LINE_GID });
    expect(result).toBeNull();
  });

  it("returns null when the order does not resolve", async () => {
    const { client } = fakeClient([{ data: { order: null } }]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    expect(await adapter.getSuggestedRefundForLine({ orderGid: ORDER_GID, lineItemGid: LINE_GID })).toBeNull();
  });

  it("returns null rather than a partial figure when Shopify's suggestedRefund carries no tax set", async () => {
    const { client } = fakeClient([
      { data: { order: { id: ORDER_GID, currencyCode: "USD", lineItems: { nodes: [{ id: LINE_GID, refundableQuantity: 1 }] } } } },
      { data: { order: { id: ORDER_GID, suggestedRefund: { subtotalSet: { shopMoney: { amount: "250.00", currencyCode: "USD" } } } } } },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    expect(await adapter.getSuggestedRefundForLine({ orderGid: ORDER_GID, lineItemGid: LINE_GID })).toBeNull();
  });

  it("throws on a top-level GraphQL error rather than swallowing it", async () => {
    const { client } = fakeClient([{ errors: [{ message: "Access denied" }] }]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    await expect(adapter.getSuggestedRefundForLine({ orderGid: ORDER_GID, lineItemGid: LINE_GID })).rejects.toBeInstanceOf(
      AdminApiError
    );
  });
});

describe("issueStoreCredit", () => {
  it("credits an existing store credit account and returns its transaction id", async () => {
    const { client, calls } = fakeClient([
      { data: { customer: { id: CUSTOMER_GID, storeCreditAccounts: { nodes: [{ id: "gid://shopify/StoreCreditAccount/1" }] } } } },
      { data: { storeCreditAccountCredit: { storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountTransaction/1" }, userErrors: [] } } },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);

    const result = await adapter.issueStoreCredit({ customerGid: CUSTOMER_GID, amountMinorUnits: 25000n, currency: "USD" });

    expect(result).toEqual({ reference: "gid://shopify/StoreCreditAccountTransaction/1" });
    expect(calls[1]?.variables).toEqual({
      id: "gid://shopify/StoreCreditAccount/1",
      creditInput: { creditAmount: { amount: "250.00", currencyCode: "USD" } },
    });
  });

  it("returns null (never a gift card) when the customer has no store credit account — D5", async () => {
    const { client, calls } = fakeClient([{ data: { customer: { id: CUSTOMER_GID, storeCreditAccounts: { nodes: [] } } } }]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);

    const result = await adapter.issueStoreCredit({ customerGid: CUSTOMER_GID, amountMinorUnits: 25000n, currency: "USD" });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1); // never attempts the credit mutation with no account to credit
  });

  it("throws on a userError rather than treating it as credited", async () => {
    const { client } = fakeClient([
      { data: { customer: { id: CUSTOMER_GID, storeCreditAccounts: { nodes: [{ id: "gid://shopify/StoreCreditAccount/1" }] } } } },
      { data: { storeCreditAccountCredit: { storeCreditAccountTransaction: null, userErrors: [{ field: ["creditInput"], message: "invalid amount" }] } } },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    await expect(
      adapter.issueStoreCredit({ customerGid: CUSTOMER_GID, amountMinorUnits: 25000n, currency: "USD" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });
});

describe("createRefund", () => {
  const TRANSACTIONS_REPLY = {
    data: {
      order: {
        id: ORDER_GID,
        transactions: [
          { id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "bogus", parentTransaction: null },
        ],
        lineItems: { nodes: [{ id: LINE_GID, refundableQuantity: 1 }] },
      },
    },
  };

  it("refunds the exact supplied total against the original sale transaction, tied to the line item", async () => {
    const { client, calls } = fakeClient([
      TRANSACTIONS_REPLY,
      { data: { refundCreate: { refund: { id: "gid://shopify/Refund/1" }, userErrors: [] } } },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);

    const result = await adapter.createRefund({
      orderGid: ORDER_GID,
      lineItemGid: LINE_GID,
      totalAmountMinorUnits: 26875n,
      currency: "USD",
    });

    expect(result).toEqual({ reference: "gid://shopify/Refund/1" });
    const input = calls[1]?.variables?.input as {
      transactions: { amount: string; parentId: string; kind: string }[];
      refundLineItems: { lineItemId: string; quantity: number }[];
    };
    expect(input.transactions).toEqual([
      { orderId: ORDER_GID, parentId: "gid://shopify/OrderTransaction/1", gateway: "bogus", kind: "REFUND", amount: "268.75" },
    ]);
    // Live-introspected 2026-09-27: RefundInput.refundLineItems reuses the
    // SAME input type as Order.suggestedRefund's argument — see the
    // adapter's own comment at this call site.
    expect(input.refundLineItems).toEqual([{ lineItemId: LINE_GID, quantity: 1 }]);
  });

  it("throws rather than refunding against nothing when no successful sale/capture transaction exists", async () => {
    const { client } = fakeClient([{ data: { order: { id: ORDER_GID, transactions: [], lineItems: { nodes: [] } } } }]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    await expect(
      adapter.createRefund({ orderGid: ORDER_GID, lineItemGid: LINE_GID, totalAmountMinorUnits: 100n, currency: "USD" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws rather than refunding a line with no refundable quantity left", async () => {
    const { client } = fakeClient([
      {
        data: {
          order: {
            id: ORDER_GID,
            transactions: [{ id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "bogus", parentTransaction: null }],
            lineItems: { nodes: [{ id: LINE_GID, refundableQuantity: 0 }] },
          },
        },
      },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    await expect(
      adapter.createRefund({ orderGid: ORDER_GID, lineItemGid: LINE_GID, totalAmountMinorUnits: 100n, currency: "USD" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });

  it("throws on a userError rather than treating it as refunded", async () => {
    const { client } = fakeClient([
      TRANSACTIONS_REPLY,
      { data: { refundCreate: { refund: null, userErrors: [{ field: ["transactions"], message: "amount exceeds refundable" }] } } },
    ]);
    const adapter = new ShopifyRmaRemedyExecutionAdapter(client);
    await expect(
      adapter.createRefund({ orderGid: ORDER_GID, lineItemGid: LINE_GID, totalAmountMinorUnits: 100n, currency: "USD" })
    ).rejects.toBeInstanceOf(AdminApiError);
  });
});
