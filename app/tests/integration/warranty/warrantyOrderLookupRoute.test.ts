import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import * as lookupRoute from "~/routes/apps.carat.warranty-order-lookup";
import { __setWarrantyOrderLookupPortForTests, action as lookupAction } from "~/routes/apps.carat.warranty-order-lookup";
import { RecordingWarrantyOrderLookupPort } from "~/shopify/admin/warrantyOrderLookupAdapter.server";

/**
 * D33 (docs/ARCHITECTURE-MVP1.md), RETIRED TO AUTHENTICATED-ONLY per
 * `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` (LOCKED OWNER REQUIREMENT,
 * 2026-09-26) — the warranty order-lookup endpoint against real Postgres.
 * Mirrors `warrantyClaimRoute.test.ts`'s shape: real HMAC signing, `action()`
 * called directly.
 *
 * The guest flow (order number + email, emailed single-use token, the
 * sibling `apps.carat.warranty-order-verify.tsx` route, and their tests) is
 * DELETED, not disabled — see that route's own removal and
 * `warrantyOrderLookupVerificationRepository.server.ts`'s removal. This file
 * now covers only the authenticated path that survives.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;
const SHOP = "caratforus-dev.myshopify.com";

function signedPost(path: string, queryParams: Record<string, string>, body: unknown, options: { rawBody?: string } = {}): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(queryParams)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function lookupRequest(overrides: Partial<{ query: Record<string, string>; body: unknown; rawBody: string }> = {}) {
  return signedPost(
    "/apps/carat/warranty-order-lookup",
    overrides.query ?? { shop: SHOP },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

function callLookup(request: Request) {
  return lookupAction({ request, params: {}, context: {} } as never);
}

function seededPort(overrides: { orderName?: string; customerGid?: string | null; orderEmail?: string } = {}) {
  const port = new RecordingWarrantyOrderLookupPort();
  const orderName = overrides.orderName ?? "#1001";
  port.seedByName(orderName, {
    orderGid: `gid://shopify/Order/${uniq()}`,
    customerGid: overrides.customerGid ?? null,
    orderEmail: overrides.orderEmail ?? "purchaser@example.com",
    lineItems: [{ lineRef: `gid://shopify/LineItem/${uniq()}`, title: "14k Gold Ring", quantity: 1 }],
  });
  return port;
}

afterEach(() => {
  __setWarrantyOrderLookupPortForTests(null);
});

describe("resource-route shape", () => {
  it("has no default export", () => {
    expect("default" in lookupRoute).toBe(false);
    expect(typeof lookupRoute.action).toBe("function");
  });
});

describe("method and signature guards", () => {
  it("rejects non-POST with 405 and unsigned with 401", async () => {
    const getResponse = await callLookup(new Request(`https://shop.example.com/apps/carat/warranty-order-lookup?shop=${SHOP}`, { method: "GET" }));
    expect(getResponse.status).toBe(405);

    const unsigned = new Request(`https://shop.example.com/apps/carat/warranty-order-lookup?shop=${SHOP}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await callLookup(unsigned)).status).toBe(401);
  });
});

describe("authenticated-only — the guest path is gone, not merely unreachable by accident", () => {
  it("refuses a signed-out caller with login_required, before any body parsing or Shopify lookup", async () => {
    const response = await callLookup(lookupRequest({ rawBody: "{not json" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "login_required" });
  });

  it("the request schema has no purchaserEmail field at all — order info can never be requested by order number + email", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName, customerGid: "gid://shopify/Customer/111111", orderEmail: "real-owner@example.com" });
    __setWarrantyOrderLookupPortForTests(port);

    // A logged-in caller supplying an email anyway is simply ignored — there
    // is no code path left that reads it.
    const response = await callLookup(
      lookupRequest({
        query: { shop: SHOP, logged_in_customer_id: "111111" },
        body: { orderNumber: orderName, purchaserEmail: "attacker@example.com" },
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resolved: boolean };
    expect(body.resolved).toBe(true); // ownership matched via signed identity, the extra field was never consulted
  });
});

describe("authenticated flow — ownership, never enumerable", () => {
  it("resolves immediately when the order belongs to the caller", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName, customerGid: "gid://shopify/Customer/111111" });
    __setWarrantyOrderLookupPortForTests(port);

    const response = await callLookup(
      lookupRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: { orderNumber: orderName } })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resolved: boolean; order?: { orderRef: string; lineItems: unknown[] } };
    expect(body.resolved).toBe(true);
    expect(body.order?.lineItems).toHaveLength(1);
  });

  it("refuses when the resolved order belongs to a DIFFERENT logged-in customer — asserted directly", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName, customerGid: "gid://shopify/Customer/999999" });
    __setWarrantyOrderLookupPortForTests(port);

    const response = await callLookup(
      lookupRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: { orderNumber: orderName } })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resolved: false });
  });

  it("a nonexistent order produces the SAME shape as an order belonging to someone else", async () => {
    const port = new RecordingWarrantyOrderLookupPort(); // resolves nothing
    __setWarrantyOrderLookupPortForTests(port);

    const notMine = await callLookup(
      lookupRequest({
        query: { shop: SHOP, logged_in_customer_id: "111111" },
        body: { orderNumber: "#anything" },
      })
    );
    expect(await notMine.json()).toEqual({ resolved: false });
  });

  it("rejects a malformed body with 400 once authenticated", async () => {
    const response = await callLookup(
      lookupRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, rawBody: "{not json" })
    );
    expect(response.status).toBe(400);
  });
});
