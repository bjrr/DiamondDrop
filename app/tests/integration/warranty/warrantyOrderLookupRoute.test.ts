import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { sha256Hex } from "~/domain/evidence/hash";
import type { EmailPort, SendEmailInput, SendEmailResult } from "~/lib/email/port";
import * as lookupRoute from "~/routes/apps.carat.warranty-order-lookup";
import { __setWarrantyOrderLookupPortForTests, __setResolveEmailPortForTests, action as lookupAction } from "~/routes/apps.carat.warranty-order-lookup";
import * as verifyRoute from "~/routes/apps.carat.warranty-order-verify";
import { __setWarrantyOrderVerifyLookupPortForTests, action as verifyAction } from "~/routes/apps.carat.warranty-order-verify";
import { RecordingWarrantyOrderLookupPort } from "~/shopify/admin/warrantyOrderLookupAdapter.server";

/**
 * D33 (docs/ARCHITECTURE-MVP1.md) — the warranty order-lookup endpoints
 * against real Postgres. Mirrors `warrantyClaimRoute.test.ts`'s shape: real
 * HMAC signing, `action()` called directly, evidence asserted against the
 * database rather than mocked.
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

function verifyRequest(overrides: Partial<{ query: Record<string, string>; body: unknown; rawBody: string }> = {}) {
  return signedPost(
    "/apps/carat/warranty-order-verify",
    overrides.query ?? { shop: SHOP },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

function callLookup(request: Request) {
  return lookupAction({ request, params: {}, context: {} } as never);
}
function callVerify(request: Request) {
  return verifyAction({ request, params: {}, context: {} } as never);
}

function flushMicrotasks(): Promise<void> {
  // Lets the lookup route's deliberately-unawaited `dispatchVerificationEmail`
  // call finish before a test inspects the fake email port — see that
  // route's own module comment on why the send is fire-and-forget.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class RecordingEmailPort implements EmailPort {
  readonly sent: SendEmailInput[] = [];
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    return { providerMessageId: `test-${this.sent.length}` };
  }
}

function installRecordingEmailPort(): RecordingEmailPort {
  const port = new RecordingEmailPort();
  __setResolveEmailPortForTests(() => ({ configured: true, port, from: "no-reply@example.com", recipients: [] }));
  return port;
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
  __setWarrantyOrderVerifyLookupPortForTests(null);
  __setResolveEmailPortForTests(null);
});

describe("resource-route shape", () => {
  it("neither route has a default export", () => {
    expect("default" in lookupRoute).toBe(false);
    expect(typeof lookupRoute.action).toBe("function");
    expect("default" in verifyRoute).toBe(false);
    expect(typeof verifyRoute.action).toBe("function");
  });
});

describe("method and signature guards", () => {
  it("warranty-order-lookup rejects non-POST with 405 and unsigned with 401", async () => {
    const getResponse = await callLookup(new Request(`https://shop.example.com/apps/carat/warranty-order-lookup?shop=${SHOP}`, { method: "GET" }));
    expect(getResponse.status).toBe(405);

    const unsigned = new Request(`https://shop.example.com/apps/carat/warranty-order-lookup?shop=${SHOP}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await callLookup(unsigned)).status).toBe(401);
  });

  it("warranty-order-verify rejects non-POST with 405 and unsigned with 401", async () => {
    const getResponse = await callVerify(new Request(`https://shop.example.com/apps/carat/warranty-order-verify?shop=${SHOP}`, { method: "GET" }));
    expect(getResponse.status).toBe(405);

    const unsigned = new Request(`https://shop.example.com/apps/carat/warranty-order-verify?shop=${SHOP}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await callVerify(unsigned)).status).toBe(401);
  });
});

describe("guest flow — anti-enumeration", () => {
  it("a matching order+email and a nonexistent order produce byte-identical responses", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    installRecordingEmailPort();

    const [name] = [...port.byName.keys()];
    const hit = await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    const hitText = await hit.text();

    const miss = await callLookup(lookupRequest({ body: { orderNumber: "#999999999", purchaserEmail: "nobody@example.com" } }));
    const missText = await miss.text();

    expect(hit.status).toBe(miss.status);
    expect(hitText).toBe(missText);
  });

  it("a matching order but wrong email also produces the identical response", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    installRecordingEmailPort();
    const [name] = [...port.byName.keys()];

    const response = await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "wrong@example.com" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "verification_requested" });
  });

  it("requires purchaserEmail for a guest lookup", async () => {
    const response = await callLookup(lookupRequest({ body: { orderNumber: "#1001" } }));
    expect(response.status).toBe(400);
  });

  it("creates a verification row and emails a link ONLY on a real match", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    const emailPort = installRecordingEmailPort();
    const [name] = [...port.byName.keys()];

    const before = await prisma.warrantyOrderLookupVerification.count();
    await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    await flushMicrotasks();

    expect(await prisma.warrantyOrderLookupVerification.count()).toBe(before + 1);
    expect(emailPort.sent).toHaveLength(1);
    expect(emailPort.sent[0]!.to).toEqual(["purchaser@example.com"]);
    expect(emailPort.sent[0]!.text).toMatch(/token=/);

    // A miss creates nothing and sends nothing.
    await callLookup(lookupRequest({ body: { orderNumber: "#000000", purchaserEmail: "nobody@example.com" } }));
    await flushMicrotasks();
    expect(await prisma.warrantyOrderLookupVerification.count()).toBe(before + 1);
    expect(emailPort.sent).toHaveLength(1);
  });

  it("durably records a SENT outcome directly on the verification row, with the provider message id", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    installRecordingEmailPort();
    const [name] = [...port.byName.keys()];

    await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    await flushMicrotasks();

    const row = await prisma.warrantyOrderLookupVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(row.verificationEmailStatus).toBe("sent");
    expect(row.verificationEmailProviderMessageId).toBe("test-1");
    expect(row.verificationEmailAttemptedAt).not.toBeNull();
  });

  it("durably records a SKIPPED_UNCONFIGURED outcome on the row when no email port is configured, and never fails the request", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    __setResolveEmailPortForTests(() => ({ configured: false, reason: "email not configured: missing EMAIL_API_KEY" }));
    const [name] = [...port.byName.keys()];

    const response = await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    expect(response.status).toBe(200); // the unawaited dispatch never affects the response
    await flushMicrotasks();

    const row = await prisma.warrantyOrderLookupVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(row.verificationEmailStatus).toBe("skipped_unconfigured");
    expect(row.verificationEmailProviderMessageId).toBeNull();
    expect(row.verificationEmailAttemptedAt).not.toBeNull();
  });

  it("durably records a FAILED outcome on the row when the email port throws, and never fails the request", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    __setResolveEmailPortForTests(() => ({
      configured: true,
      from: "no-reply@example.com",
      recipients: [],
      port: {
        async send() {
          throw new Error("provider unreachable");
        },
      },
    }));
    const [name] = [...port.byName.keys()];

    const response = await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    expect(response.status).toBe(200); // the unawaited dispatch never affects the response
    await flushMicrotasks();

    const row = await prisma.warrantyOrderLookupVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(row.verificationEmailStatus).toBe("failed");
    expect(row.verificationEmailProviderMessageId).toBeNull();
    expect(row.verificationEmailAttemptedAt).not.toBeNull();
  });
});

describe("logged-in flow — ownership, never enumerable", () => {
  it("resolves immediately, with no email involved, when the order belongs to the caller", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName, customerGid: "gid://shopify/Customer/111111" });
    __setWarrantyOrderLookupPortForTests(port);
    const emailPort = installRecordingEmailPort();

    const response = await callLookup(
      lookupRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: { orderNumber: orderName } })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resolved: boolean; order?: { orderRef: string; lineItems: unknown[] } };
    expect(body.resolved).toBe(true);
    expect(body.order?.lineItems).toHaveLength(1);
    expect(emailPort.sent).toHaveLength(0);
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

  it("ignores a client-supplied purchaserEmail entirely once logged in", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName, customerGid: "gid://shopify/Customer/111111", orderEmail: "real-owner@example.com" });
    __setWarrantyOrderLookupPortForTests(port);

    const response = await callLookup(
      lookupRequest({
        query: { shop: SHOP, logged_in_customer_id: "111111" },
        body: { orderNumber: orderName, purchaserEmail: "attacker@example.com" },
      })
    );
    const body = (await response.json()) as { resolved: boolean };
    expect(body.resolved).toBe(true); // ownership matched via signed identity, the bogus email was never consulted
  });
});

describe("end-to-end guest verification", () => {
  function extractToken(verificationUrl: string): string {
    return new URL(verificationUrl).searchParams.get("token")!;
  }

  async function requestAndCaptureToken(orderName: string): Promise<string> {
    const emailPort = installRecordingEmailPort();
    await callLookup(lookupRequest({ body: { orderNumber: orderName, purchaserEmail: "purchaser@example.com" } }));
    await flushMicrotasks();
    const linkMatch = emailPort.sent[0]!.text.match(/(https?:\/\/\S+)/);
    return extractToken(linkMatch![1]!);
  }

  it("redeems a fresh token and returns order/line data re-fetched from Shopify", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName });
    __setWarrantyOrderLookupPortForTests(port);
    const token = await requestAndCaptureToken(orderName);

    // Simulate the order's line items having changed since the lookup was requested.
    const orderGid = [...port.byGid.keys()][0]!;
    const original = port.byGid.get(orderGid)!;
    port.byGid.set(orderGid, {
      ...original,
      lineItems: [{ lineRef: "gid://shopify/LineItem/fresh", title: "Freshly re-fetched line", quantity: 2 }],
    });

    __setWarrantyOrderVerifyLookupPortForTests(port);
    const response = await callVerify(verifyRequest({ body: { token } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resolved: boolean; order: { lineItems: { title: string }[] } };
    expect(body.resolved).toBe(true);
    expect(body.order.lineItems).toEqual([{ lineRef: "gid://shopify/LineItem/fresh", title: "Freshly re-fetched line", quantity: 2 }]);
  });

  it("refuses a second redemption of the same token", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName });
    __setWarrantyOrderLookupPortForTests(port);
    __setWarrantyOrderVerifyLookupPortForTests(port);
    const token = await requestAndCaptureToken(orderName);

    const first = await callVerify(verifyRequest({ body: { token } }));
    expect(first.status).toBe(200);

    const second = await callVerify(verifyRequest({ body: { token } }));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "token_already_used" });
  });

  it("refuses an expired token", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName });
    __setWarrantyOrderLookupPortForTests(port);
    __setWarrantyOrderVerifyLookupPortForTests(port);
    const token = await requestAndCaptureToken(orderName);

    await prisma.warrantyOrderLookupVerification.updateMany({
      where: { tokenHash: sha256Hex(token) },
      data: { expiresAt: new Date(0) },
    });

    const response = await callVerify(verifyRequest({ body: { token } }));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "token_expired" });
  });

  it("refuses a token that was never issued", async () => {
    const response = await callVerify(verifyRequest({ body: { token: "totally-made-up-token-value" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_token" });
  });

  it("rejects a malformed body with 400", async () => {
    const response = await callVerify(verifyRequest({ body: { token: "short" } }));
    expect(response.status).toBe(400);
  });
});
