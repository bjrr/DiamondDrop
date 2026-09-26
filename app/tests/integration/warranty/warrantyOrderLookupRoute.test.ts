import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { sha256Hex } from "~/domain/evidence/hash";
import type { EmailPort, SendEmailInput, SendEmailResult } from "~/lib/email/port";
import * as lookupRoute from "~/routes/apps.carat.warranty-order-lookup";
import { __setWarrantyOrderLookupPortForTests, __setResolveEmailPortForTests, action as lookupAction } from "~/routes/apps.carat.warranty-order-lookup";
import * as verifyRoute from "~/routes/apps.carat.warranty-order-verify";
import { __setWarrantyOrderVerifyLookupPortForTests, action as verifyAction } from "~/routes/apps.carat.warranty-order-verify";
import type { WarrantyOrderLookupPort } from "~/shopify/admin/warrantyOrderLookupAdapter.server";
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

/**
 * Yields ONE macrotask turn — safe ONLY for letting the lookup route's
 * deliberately-unawaited `dispatchVerificationEmail` call progress far
 * enough to have pushed onto the IN-MEMORY `RecordingEmailPort.sent` array
 * (a synchronous push wrapped in an already-resolved promise, with no real
 * I/O before it in the "sent" path). Renamed from the original
 * `flushMicrotasks` — team-lead review note: that name was itself part of a
 * bug. It claimed to flush microtasks; a `setTimeout` callback actually runs
 * in the MACROTASK queue, and the two failing assertions that used it were
 * both waiting on genuine Postgres I/O (`verificationEmailStatus` written by
 * `recordWarrantyOrderLookupVerificationEmailOutcome`), not an in-memory
 * push — one macrotask turn happened to be enough locally but was never
 * guaranteed to be, and stopped being enough the moment connection-pool
 * contention changed. DO NOT use this for anything that touches the
 * database — use `waitForCondition` below instead, which polls with a
 * bounded timeout and fails loudly rather than silently racing.
 */
function yieldOneEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Polls `getter` until `isReady` is satisfied, or fails with a message
 * naming exactly what was never observed within `timeoutMs` — the
 * team-lead-requested fix for the two tests that used to race
 * `yieldOneEventLoopTurn` (formerly `flushMicrotasks`) against a real database
 * write. A single fixed delay long enough to "usually" work is exactly the
 * flakiness this replaces: this fails LOUDLY and DETERMINISTICALLY on a
 * timeout instead of silently passing or failing depending on how fast
 * Postgres happened to answer that run.
 */
async function waitForCondition<T>(
  getter: () => Promise<T>,
  isReady: (value: T) => boolean,
  description: string,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await getter();
    if (isReady(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${description}: not observed within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

class RecordingEmailPort implements EmailPort {
  readonly sent: SendEmailInput[] = [];
  /**
   * An artificial delay before `.send()` resolves — used ONLY by the tests
   * that must PROVE the route's response does not wait for the send, by
   * asserting the response returns in well under this delay. Zero (the
   * default) for every other test, where the delay would only slow the
   * suite for no benefit.
   */
  constructor(private readonly sendDelayMs = 0) {}
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (this.sendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    this.sent.push(input);
    return { providerMessageId: `test-${this.sent.length}` };
  }
}

function installRecordingEmailPort(sendDelayMs = 0): RecordingEmailPort {
  const port = new RecordingEmailPort(sendDelayMs);
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
    await yieldOneEventLoopTurn();

    expect(await prisma.warrantyOrderLookupVerification.count()).toBe(before + 1);
    expect(emailPort.sent).toHaveLength(1);
    expect(emailPort.sent[0]!.to).toEqual(["purchaser@example.com"]);
    expect(emailPort.sent[0]!.text).toMatch(/token=/);

    // A miss creates nothing and sends nothing.
    await callLookup(lookupRequest({ body: { orderNumber: "#000000", purchaserEmail: "nobody@example.com" } }));
    await yieldOneEventLoopTurn();
    expect(await prisma.warrantyOrderLookupVerification.count()).toBe(before + 1);
    expect(emailPort.sent).toHaveLength(1);
  });

  /**
   * Both of these use an ARTIFICIALLY DELAYED email port and assert the
   * response returns in well under that delay — team-lead review note: a
   * fix that only polls afterward would ALSO pass if the route were
   * regressed to `await dispatchVerificationEmail(...)` before responding,
   * which means it would no longer be testing the property that matters. The
   * response-latency assertion is what still fails if that regression ever
   * happens; the polling below is only for the SEPARATE concern of not
   * racing the real Postgres write when checking the eventual outcome.
   *
   * THE MARGIN MUST BE QUALITATIVE, NOT A NARROW RACE OF ITS OWN (second
   * team-lead review note). An earlier version of this used a 250ms delay
   * against a 120ms ceiling — only a 130ms margin, on a real response path
   * that itself does a signature check, a fake-port call and a genuine
   * Postgres INSERT before returning. On a loaded machine that ceiling could
   * fail for reasons that have nothing to do with the property being
   * guarded, and the failure message would look exactly like a real
   * regression. `RESPONSE_MUST_RETURN_WITHIN_MS` is now DERIVED from
   * `SEND_DELAY_MS` (half of it) specifically so the two numbers cannot
   * silently drift apart in a later edit: a regressed, awaiting route takes
   * at least the full delay and fails unambiguously; a normal response would
   * have to take HALF the delay — twelve times its realistic worst case at
   * the current 3s setting — to false-fail.
   */
  const SEND_DELAY_MS = 3000;
  const RESPONSE_MUST_RETURN_WITHIN_MS = SEND_DELAY_MS / 2;
  // The eventual-consistency poll below must wait AT LEAST SEND_DELAY_MS
  // (the write cannot land before the artificial delay elapses) plus real
  // margin for the Postgres round trip itself — `waitForCondition`'s 3000ms
  // default is NOT automatically long enough once SEND_DELAY_MS grows, so
  // this is derived explicitly rather than left implicit.
  const POLL_TIMEOUT_MS = SEND_DELAY_MS + 3000;

  it("durably records a SENT outcome directly on the verification row, with the provider message id — without waiting for the send", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    installRecordingEmailPort(SEND_DELAY_MS);
    const [name] = [...port.byName.keys()];

    const startedAt = Date.now();
    await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs, `response took ${elapsedMs}ms — should return well before the ${SEND_DELAY_MS}ms artificial send delay`).toBeLessThan(
      RESPONSE_MUST_RETURN_WITHIN_MS
    );

    const row = await waitForCondition(
      () => prisma.warrantyOrderLookupVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } }),
      (r) => r.verificationEmailStatus !== null,
      "verificationEmailStatus (expected sent)",
      { timeoutMs: POLL_TIMEOUT_MS }
    );
    expect(row.verificationEmailStatus).toBe("sent");
    expect(row.verificationEmailProviderMessageId).toBe("test-1");
    expect(row.verificationEmailAttemptedAt).not.toBeNull();
  });

  it("durably records a SKIPPED_UNCONFIGURED outcome on the row when no email port is configured, and never fails the request", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    __setResolveEmailPortForTests(() => ({ configured: false, reason: "email not configured: missing EMAIL_API_KEY" }));
    const [name] = [...port.byName.keys()];

    // No slow dependency exists on this branch to race against (resolveEmailPort()
    // is synchronous and .send() is never called) — the response-latency proof
    // above does not apply here; this test instead only fixes the flakiness of
    // observing the eventual write via bounded polling rather than a fixed delay.
    const response = await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    expect(response.status).toBe(200); // the unawaited dispatch never affects the response

    const row = await waitForCondition(
      () => prisma.warrantyOrderLookupVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } }),
      (r) => r.verificationEmailStatus !== null,
      "verificationEmailStatus (expected skipped_unconfigured)"
    );
    expect(row.verificationEmailStatus).toBe("skipped_unconfigured");
    expect(row.verificationEmailProviderMessageId).toBeNull();
    expect(row.verificationEmailAttemptedAt).not.toBeNull();
  });

  it("durably records a FAILED outcome on the row when the email port throws, and never fails the request — without waiting for the throw", async () => {
    const port = seededPort({ orderName: `#${uniq().replace("-", "")}` });
    __setWarrantyOrderLookupPortForTests(port);
    __setResolveEmailPortForTests(() => ({
      configured: true,
      from: "no-reply@example.com",
      recipients: [],
      port: {
        async send() {
          await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
          throw new Error("provider unreachable");
        },
      },
    }));
    const [name] = [...port.byName.keys()];

    const startedAt = Date.now();
    const response = await callLookup(lookupRequest({ body: { orderNumber: name, purchaserEmail: "purchaser@example.com" } }));
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(200); // the unawaited dispatch never affects the response
    expect(elapsedMs, `response took ${elapsedMs}ms — should return well before the ${SEND_DELAY_MS}ms artificial delay before the throw`).toBeLessThan(
      RESPONSE_MUST_RETURN_WITHIN_MS
    );

    const row = await waitForCondition(
      () => prisma.warrantyOrderLookupVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } }),
      (r) => r.verificationEmailStatus !== null,
      "verificationEmailStatus (expected failed)",
      { timeoutMs: POLL_TIMEOUT_MS }
    );
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
    await yieldOneEventLoopTurn();
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

describe("PEEK-THEN-FETCH-THEN-CONSUME ORDERING — team-lead review note: a transient Shopify failure must not strand the token", () => {
  function extractToken(verificationUrl: string): string {
    return new URL(verificationUrl).searchParams.get("token")!;
  }

  async function requestAndCaptureToken(orderName: string): Promise<string> {
    const emailPort = installRecordingEmailPort();
    await callLookup(lookupRequest({ body: { orderNumber: orderName, purchaserEmail: "purchaser@example.com" } }));
    await yieldOneEventLoopTurn();
    const linkMatch = emailPort.sent[0]!.text.match(/(https?:\/\/\S+)/);
    return extractToken(linkMatch![1]!);
  }

  it("a Shopify fetch THROW leaves the token unconsumed — a retry with the SAME token then succeeds", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName });
    __setWarrantyOrderLookupPortForTests(port);
    const token = await requestAndCaptureToken(orderName);

    let calls = 0;
    const flakyPort: WarrantyOrderLookupPort = {
      findOrderByName: (name) => port.findOrderByName(name),
      async findOrderByGid(orderGid) {
        calls += 1;
        if (calls === 1) throw new Error("Shopify unavailable");
        return port.findOrderByGid(orderGid);
      },
    };
    __setWarrantyOrderVerifyLookupPortForTests(flakyPort);

    const failed = await callVerify(verifyRequest({ body: { token } }));
    expect(failed.status).toBe(502);

    const row = await prisma.warrantyOrderLookupVerification.findFirstOrThrow({ where: { tokenHash: sha256Hex(token) } });
    expect(row.consumedAt).toBeNull(); // NOT spent by the failed attempt

    const retry = await callVerify(verifyRequest({ body: { token } }));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { resolved: boolean }).resolved).toBe(true);
  });

  it("a Shopify fetch returning NULL leaves the token unconsumed — a retry with the SAME token then succeeds", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName });
    __setWarrantyOrderLookupPortForTests(port);
    const token = await requestAndCaptureToken(orderName);

    let calls = 0;
    const flakyPort: WarrantyOrderLookupPort = {
      findOrderByName: (name) => port.findOrderByName(name),
      async findOrderByGid(orderGid) {
        calls += 1;
        if (calls === 1) return null;
        return port.findOrderByGid(orderGid);
      },
    };
    __setWarrantyOrderVerifyLookupPortForTests(flakyPort);

    const notResolvable = await callVerify(verifyRequest({ body: { token } }));
    expect(notResolvable.status).toBe(404);

    const row = await prisma.warrantyOrderLookupVerification.findFirstOrThrow({ where: { tokenHash: sha256Hex(token) } });
    expect(row.consumedAt).toBeNull(); // NOT spent by the not-found attempt

    const retry = await callVerify(verifyRequest({ body: { token } }));
    expect(retry.status).toBe(200);
  });

  it("END-TO-END CONCURRENCY: two simultaneous verify POSTs for the same token — exactly one 200, one 409", async () => {
    const orderName = `#${uniq().replace("-", "")}`;
    const port = seededPort({ orderName });
    __setWarrantyOrderLookupPortForTests(port);
    __setWarrantyOrderVerifyLookupPortForTests(port);
    const token = await requestAndCaptureToken(orderName);

    const [a, b] = await Promise.all([
      callVerify(verifyRequest({ body: { token } })),
      callVerify(verifyRequest({ body: { token } })),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const row = await prisma.warrantyOrderLookupVerification.findFirstOrThrow({ where: { tokenHash: sha256Hex(token) } });
    expect(row.consumedAt).not.toBeNull();
  });
});
