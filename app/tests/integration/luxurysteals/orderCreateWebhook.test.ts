import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import { getLuxuryStealOrderCheck } from "~/db/repositories/luxuryStealRepository.server";
import type { EmailPortResolution } from "~/lib/email/configuredPort.server";
import { getEnv } from "~/lib/env.server";
import type { EmailPort, SendEmailInput } from "~/lib/email/port";
import { action as ordersCreateAction } from "~/routes/webhooks.carat.orders-create";
import type { FulfillmentOrderSummary, LuxuryStealOrderReviewPort } from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";
import { SHOPIFY_EVENT_ID_HEADER, SHOPIFY_HMAC_HEADER, SHOPIFY_TOPIC_HEADER } from "~/shopify/webhooks/headers";
import { handleLuxuryStealOrderCreateWebhook } from "~/shopify/webhooks/luxuryStealOrderHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/**
 * Slice 3 task 3-4 / D28 — `orders/create` verification against real Postgres
 * (docs/specs/SLICE-3-LUXURY-STEALS.md §4.4/§D28, criteria 137-140, 150). This
 * is the load-bearing enforcement D6 relies on with no Cart/Checkout
 * Validation Function shipping in MVP1 — see `luxuryStealOrderHandler.server.ts`'s
 * own doc comment.
 *
 * Two layers are exercised deliberately:
 *   - `handleLuxuryStealOrderCreateWebhook` called DIRECTLY, with an injected
 *     fake `EmailPort` AND a fake `LuxuryStealOrderReviewPort`, for every
 *     matching/tamper/idempotency/tag/hold scenario — this is the only way to
 *     assert dispatch counts precisely, and HMAC verification is already
 *     `receive.server.ts`'s own job, proven in
 *     `tests/integration/webhooks/dedup.test.ts`.
 *   - the real route `action` (`~/routes/webhooks.carat.orders-create`), for
 *     the HMAC-rejection case and one full-chain sanity check using an
 *     ORDINARY (non-Luxury-Steal) order — deliberately not a Luxury Steal
 *     one, since the real route has no seam to inject a fake admin client and
 *     this suite must not attempt a live Shopify Admin API call (the
 *     architect's assigning message: no deploy, no live gate, from this
 *     task).
 */

let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

async function createProduct() {
  return prisma.masterProduct.create({
    data: {
      name: `orders-create fixture ${nextNumericId()}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
}

async function createVariant(
  masterProductId: string,
  overrides: { shopifyVariantGid?: string; isLuxurySteal?: boolean } = {}
) {
  return prisma.masterVariant.create({
    data: {
      masterProductId,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: overrides.shopifyVariantGid ?? `gid://shopify/ProductVariant/${nextNumericId()}`,
      isLuxurySteal: overrides.isLuxurySteal ?? false,
    },
  });
}

/** `variantRef` mirrors what `apps.carat.luxury-acknowledgment.tsx` actually writes: the Shopify variant gid, not the internal master_variant id. */
async function createAcknowledgment(variantGid: string) {
  const policy = await prisma.policyVersion.create({
    data: {
      slug: `orders-create-fixture-policy-${nextNumericId()}`,
      version: 1,
      effectiveFrom: new Date(),
      text: "FINAL SALE ACKNOWLEDGMENT",
      contentHash: `hash-${nextNumericId()}`,
    },
  });
  return prisma.acknowledgment.create({
    data: {
      exactText: "I understand that this item is a Luxury Steal and is FINAL SALE.",
      policyVersionId: policy.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: "I Understand & Agree",
      variantRef: variantGid,
    },
  });
}

function variantIdFromGid(gid: string): string {
  return gid.split("/").pop()!;
}

interface RawLineSpec {
  lineId: string;
  /** Bare digits, or omitted for a custom/manual line item with no variant. */
  variantId?: string;
  ackId?: string;
}

/** Builds the raw JSON text by hand (never via JSON.stringify of a JS object) so `id`/`variant_id` are genuinely unquoted numeric tokens, exactly like a real Shopify delivery — exercising `preserveShopifyBigIntIds` end to end, not just at the unit level. */
function buildOrderRawBody(orderId: string, lines: RawLineSpec[]): string {
  const lineItemsJson = lines
    .map((l) => {
      const variantField = l.variantId !== undefined ? `"variant_id":${l.variantId}` : `"variant_id":null`;
      const propertiesJson = l.ackId
        ? `[{"name":"_carat_ls_ack","value":${JSON.stringify(l.ackId)}}]`
        : `[]`;
      return `{"id":${l.lineId},"admin_graphql_api_id":"gid://shopify/LineItem/${l.lineId}",${variantField},"properties":${propertiesJson}}`;
    })
    .join(",");
  return `{"id":${orderId},"admin_graphql_api_id":"gid://shopify/Order/${orderId}","line_items":[${lineItemsJson}]}`;
}

function receivedEvent(rawBody: string, eventId: string = randomUUID()): ReceivedWebhookEvent {
  return {
    shopifyEventId: eventId,
    topic: "orders/create",
    shopDomain: "caratforus-dev.myshopify.com",
    rawBody,
    payload: JSON.parse(rawBody) as unknown,
  };
}

function fakeEmailPort(): { port: EmailPort; calls: SendEmailInput[] } {
  const calls: SendEmailInput[] = [];
  const port: EmailPort = {
    send: async (input) => {
      calls.push(input);
      return { providerMessageId: `msg-${calls.length}` };
    },
  };
  return { port, calls };
}

function configuredResolver(port: EmailPort): () => EmailPortResolution {
  return () => ({
    configured: true,
    port,
    from: "alerts@caratforus.example",
    recipients: ["staff@example.com"],
  });
}

/**
 * STATEFUL, to make redelivery scenarios meaningful: a successful
 * `holdFulfillmentOrder` call updates the fake's own record of that
 * fulfillment order's status to `ON_HOLD`, so a SECOND call against the SAME
 * fake instance (simulating a redelivered event, or the always-reconcile
 * design's natural repeat) observes it already held via `listFulfillmentOrders`
 * and takes the handler's cheap short-circuit path instead of calling
 * `holdFulfillmentOrder` again — exactly proving "no duplicate hold" at the
 * CALL level, not merely the database level.
 */
function fakeReviewPort(
  options: {
    fulfillmentOrders?: FulfillmentOrderSummary[];
    failTag?: boolean;
    failListFulfillmentOrders?: boolean;
    /** Per fulfillment-order-id override of the default ("apply cleanly") hold outcome. */
    holdOutcomeOverride?: Record<string, "already_held" | "fail">;
  } = {}
) {
  const tagCalls: { orderGid: string; tags: string[] }[] = [];
  const holdCalls: { fulfillmentOrderGid: string; reasonNotes: string }[] = [];
  const listCalls: string[] = [];
  const fulfillmentOrderStatus = new Map<string, string>(
    (options.fulfillmentOrders ?? []).map((fo) => [fo.id, fo.status])
  );

  const port: LuxuryStealOrderReviewPort = {
    async addOrderTags({ orderGid, tags }) {
      tagCalls.push({ orderGid, tags: [...tags] });
      if (options.failTag) throw new Error("simulated tag failure");
    },
    async listFulfillmentOrders(orderGid) {
      listCalls.push(orderGid);
      if (options.failListFulfillmentOrders) throw new Error("simulated fulfillment-order lookup failure");
      return [...fulfillmentOrderStatus.entries()].map(([id, status]) => ({ id, status }));
    },
    async holdFulfillmentOrder({ fulfillmentOrderGid, reasonNotes }) {
      holdCalls.push({ fulfillmentOrderGid, reasonNotes });
      const override = options.holdOutcomeOverride?.[fulfillmentOrderGid];
      if (override === "fail") throw new Error("simulated hold failure");
      fulfillmentOrderStatus.set(fulfillmentOrderGid, "ON_HOLD");
      return {
        status: "ON_HOLD",
        recognizedVia: override === "already_held" ? "duplicate_handle" : "applied",
        userErrorCodes: override === "already_held" ? ["DUPLICATE_FULFILLMENT_HOLD_HANDLE"] : [],
      };
    },
  };

  return { port, tagCalls, holdCalls, listCalls };
}

function reviewPortResolver(port: LuxuryStealOrderReviewPort): (shopDomain: string) => Promise<LuxuryStealOrderReviewPort> {
  return async () => port;
}

/** One open fulfilment order — the default shape most tests below need for the unverified/hold path, with no special-casing. */
function oneOpenFulfillmentOrder(id = "gid://shopify/FulfillmentOrder/1"): FulfillmentOrderSummary[] {
  return [{ id, status: "OPEN" }];
}

function signedRequest(body: string, eventId: string, secret: string): Request {
  const hmac = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  return new Request("https://example.com/webhooks/carat/orders-create", {
    method: "POST",
    headers: {
      [SHOPIFY_HMAC_HEADER]: hmac,
      [SHOPIFY_TOPIC_HEADER]: "orders/create",
      [SHOPIFY_EVENT_ID_HEADER]: eventId,
    },
    body,
  });
}

describe("a line with valid, variant-matching evidence (verified order)", () => {
  it("is recorded as matched, sends no alert, tags the order 'Luxury Steal', and places NO hold", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });
    const ack = await createAcknowledgment(variant.shopifyVariantGid!);

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: ack.id },
    ]);
    const { port: emailPort, calls } = fakeEmailPort();
    const { port: reviewPort, tagCalls, holdCalls, listCalls } = fakeReviewPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    const check = await getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("matched");
    expect(check?.matchedAcknowledgmentId).toBe(ack.id);
    expect(check?.variantRef).toBe(variant.id);
    expect(calls).toHaveLength(0);

    expect(tagCalls).toEqual([{ orderGid: orderRef, tags: ["Luxury Steal"] }]);
    // D28: "no fulfilment hold; normal fulfilment may continue" for a verified order.
    expect(listCalls).toHaveLength(0);
    expect(holdCalls).toHaveLength(0);

    const tagEvents = (await listAuditEventsForEntity("luxury_steal_order", orderRef)).filter(
      (e) => e.action === "luxury_steal_order.tag_applied"
    );
    expect(tagEvents).toHaveLength(1);
    expect(tagEvents[0]?.after).toMatchObject({ tag: "Luxury Steal", verified: true });
  });
});

describe("a line with no _carat_ls_ack property (unverified order)", () => {
  it("is recorded as unmatched, alerted, tagged for review, and the affected fulfilment order is held with reasonNotes", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port: emailPort, calls } = fakeEmailPort();
    const { port: reviewPort, tagCalls, holdCalls } = fakeReviewPort({
      fulfillmentOrders: oneOpenFulfillmentOrder(),
    });

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    const check = await getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
    expect(check?.matchedAcknowledgmentId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toContain(orderRef);
    expect(calls[0]?.text).toContain(variant.id);

    // D28: an obvious review tag, distinct from the plain verified tag.
    expect(tagCalls).toEqual([{ orderGid: orderRef, tags: ["Luxury Steal: Needs Review"] }]);

    // D28: a real hold, with D28's staff-facing explanation in reasonNotes —
    // never Order.note (a shared field a retry could clobber).
    expect(holdCalls).toHaveLength(1);
    expect(holdCalls[0]?.fulfillmentOrderGid).toBe("gid://shopify/FulfillmentOrder/1");
    expect(holdCalls[0]?.reasonNotes).toContain(orderRef);
    expect(holdCalls[0]?.reasonNotes).toContain("gid://shopify/LineItem/1");
    expect(holdCalls[0]?.reasonNotes).not.toMatch(/cost|margin/i);

    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    expect(auditEvents.find((e) => e.action === "luxury_steal_order.alert_email_sent")).toBeTruthy();
    expect(auditEvents.find((e) => e.action === "luxury_steal_order.tag_applied")).toMatchObject({
      after: { tag: "Luxury Steal: Needs Review", verified: false },
    });
    expect(auditEvents.find((e) => e.action === "luxury_steal_order.fulfillment_hold_applied")).toMatchObject({
      after: { fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" },
    });
  });
});

describe("a line whose property names an acknowledgment for a DIFFERENT variant (the tamper case)", () => {
  it("is recorded as unmatched — the acknowledgment is never trusted merely for existing", async () => {
    const product = await createProduct();
    const orderedVariant = await createVariant(product.id, { isLuxurySteal: true });
    const otherVariant = await createVariant(product.id, { isLuxurySteal: true });
    // Captured legitimately, but against the OTHER variant.
    const ack = await createAcknowledgment(otherVariant.shopifyVariantGid!);

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(orderedVariant.shopifyVariantGid!), ackId: ack.id },
    ]);
    const { port: emailPort, calls } = fakeEmailPort();
    const { port: reviewPort } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
    expect(check?.matchedAcknowledgmentId).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("a line naming an acknowledgment id that does not exist", () => {
  it("is recorded as unmatched, and an unconfigured-email outcome is still durably recorded", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: randomUUID() },
    ]);
    const { port: reviewPort } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    const check = await getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");

    // Even with no configured email port, the ATTEMPT's outcome (skipped,
    // unconfigured) is a durable audit_event row, not merely a log line.
    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    const alertEvent = auditEvents.find((e) => e.action === "luxury_steal_order.alert_email_skipped_unconfigured");
    expect(alertEvent).toBeTruthy();
    expect((alertEvent?.after as { emailDeliveryStatus: string } | null)?.emailDeliveryStatus).toBe(
      "skipped_unconfigured"
    );
    expect(alertEvent?.reason).toBe("not configured for this test");
  });
});

describe("a line naming a malformed (non-UUID-shaped) acknowledgment property value", () => {
  it("is recorded as unmatched without the handler throwing", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: "not-a-uuid-at-all" },
    ]);
    const { port: reviewPort } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });

    await expect(
      handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
        resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
        resolveReviewPort: reviewPortResolver(reviewPort),
      })
    ).resolves.toBeUndefined();

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
  });
});

describe("a non-Luxury-Steal order", () => {
  it("gets no evidence row, no alert, no tag and no hold — completely untouched", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: false });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port: emailPort, calls } = fakeEmailPort();
    const { port: reviewPort, tagCalls, holdCalls, listCalls } = fakeReviewPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check).toBeNull();
    expect(calls).toHaveLength(0);
    expect(tagCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(0);
    expect(holdCalls).toHaveLength(0);
  });
});

describe("a custom/manual line item with no variant_id at all", () => {
  it("is skipped: no evidence row, no crash", async () => {
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [{ lineId: "1" }]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
      // No resolveReviewPort injected on purpose: lsLineCount stays 0 for an
      // order with no variant at all, so the reconciliation step (and its
      // real-network default resolver) must never even be reached.
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("a variant this catalogue does not recognise at all", () => {
  it("is skipped rather than treated as a Luxury Steal by default", async () => {
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [{ lineId: "1", variantId: nextNumericId() }]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
      // Same reasoning as above — an unrecognised variant never increments
      // lsLineCount, so no review-port resolution is needed here either.
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("an order mixing a Luxury Steal line with an ordinary line", () => {
  it("checks only the Luxury Steal lines, and holds the order if any one of them is unmatched", async () => {
    const product = await createProduct();
    const matchedVariant = await createVariant(product.id, { isLuxurySteal: true });
    const unmatchedVariant = await createVariant(product.id, { isLuxurySteal: true });
    const ordinaryVariant = await createVariant(product.id, { isLuxurySteal: false });
    const ack = await createAcknowledgment(matchedVariant.shopifyVariantGid!);

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(matchedVariant.shopifyVariantGid!), ackId: ack.id },
      { lineId: "2", variantId: variantIdFromGid(unmatchedVariant.shopifyVariantGid!) },
      { lineId: "3", variantId: variantIdFromGid(ordinaryVariant.shopifyVariantGid!) },
    ]);
    const { port: emailPort, calls } = fakeEmailPort();
    const { port: reviewPort, tagCalls, holdCalls } = fakeReviewPort({
      fulfillmentOrders: oneOpenFulfillmentOrder(),
    });

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    await expect(getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/1")).resolves.toMatchObject({
      outcome: "matched",
    });
    await expect(getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/2")).resolves.toMatchObject({
      outcome: "unmatched",
    });
    await expect(getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/3")).resolves.toBeNull();

    // Exactly one alert for the whole order, even though only one line is unmatched.
    expect(calls).toHaveLength(1);
    // The ORDER-level tag reflects the unverified state — one unmatched line
    // is enough to earn the review tag, even with a matched sibling.
    expect(tagCalls).toEqual([{ orderGid: orderRef, tags: ["Luxury Steal: Needs Review"] }]);
    expect(holdCalls).toHaveLength(1);
    // The hold's reasonNotes names the UNMATCHED line, not the matched one.
    expect(holdCalls[0]?.reasonNotes).toContain("gid://shopify/LineItem/2");
    expect(holdCalls[0]?.reasonNotes).not.toContain("gid://shopify/LineItem/1");
  });
});

describe("multiple fulfilment orders on the same unverified order", () => {
  it("holds every affected fulfilment order, not just the first", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port: reviewPort, holdCalls } = fakeReviewPort({
      fulfillmentOrders: [
        { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
        { id: "gid://shopify/FulfillmentOrder/2", status: "IN_PROGRESS" },
      ],
    });

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    expect(holdCalls.map((c) => c.fulfillmentOrderGid).sort()).toEqual([
      "gid://shopify/FulfillmentOrder/1",
      "gid://shopify/FulfillmentOrder/2",
    ]);

    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    const holdEvents = auditEvents.filter((e) => e.action === "luxury_steal_order.fulfillment_hold_applied");
    expect(holdEvents).toHaveLength(2);
  });

  it("holds the ones it can even when one fails, and makes the partial failure explicit rather than averaging it into ok", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port: reviewPort, holdCalls } = fakeReviewPort({
      fulfillmentOrders: [
        { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
        { id: "gid://shopify/FulfillmentOrder/2", status: "OPEN" },
        { id: "gid://shopify/FulfillmentOrder/3", status: "OPEN" },
      ],
      holdOutcomeOverride: { "gid://shopify/FulfillmentOrder/2": "fail" },
    });

    await expect(
      handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
        resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
        resolveReviewPort: reviewPortResolver(reviewPort),
      })
    ).rejects.toThrow(/FulfillmentOrder\/2/);

    // All three were ATTEMPTED, not just aborted at the first failure.
    expect(holdCalls).toHaveLength(3);

    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    expect(auditEvents.find((e) => e.action === "luxury_steal_order.fulfillment_hold_failed")).toMatchObject({
      after: { fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/2" },
    });
    expect(
      auditEvents.filter((e) => e.action === "luxury_steal_order.fulfillment_hold_applied")
    ).toHaveLength(2);
  });
});

describe("an already-on-hold fulfillment order (recognised via the port's userError-then-recheck contract)", () => {
  it("is treated as a SUCCESS, not a failure, and recorded distinctly from a fresh application", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port: reviewPort, holdCalls } = fakeReviewPort({
      fulfillmentOrders: oneOpenFulfillmentOrder(),
      holdOutcomeOverride: { "gid://shopify/FulfillmentOrder/1": "already_held" },
    });

    await expect(
      handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
        resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
        resolveReviewPort: reviewPortResolver(reviewPort),
      })
    ).resolves.toBeUndefined();

    expect(holdCalls).toHaveLength(1);
    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    expect(
      auditEvents.find((e) => e.action === "luxury_steal_order.fulfillment_hold_already_applied")
    ).toMatchObject({ after: { fulfillmentOrderGid: "gid://shopify/FulfillmentOrder/1", status: "ON_HOLD" } });
    expect(auditEvents.find((e) => e.action === "luxury_steal_order.fulfillment_hold_failed")).toBeUndefined();
  });
});

describe("a tag application failure", () => {
  it("does not lose the already-committed evidence row, even though the handler rejects", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });
    const ack = await createAcknowledgment(variant.shopifyVariantGid!);

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: ack.id },
    ]);
    const { port: reviewPort } = fakeReviewPort({ failTag: true });

    await expect(
      handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
        resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
        resolveReviewPort: reviewPortResolver(reviewPort),
      })
    ).rejects.toThrow();

    // POSTGRES FIRST, SHOPIFY AFTER — the evidence row was already committed
    // before the tag call ran, so a later Shopify-side failure never loses it.
    const check = await getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("matched");

    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    expect(auditEvents.find((e) => e.action === "luxury_steal_order.tag_failed")).toBeTruthy();
  });
});

describe("redelivery of the same orders/create event", () => {
  it("creates exactly one evidence row, sends exactly one alert, and applies exactly one hold (the second delivery recognises it already in place)", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const orderRef = `gid://shopify/Order/${orderId}`;
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port: emailPort, calls } = fakeEmailPort();
    const { port: reviewPort, holdCalls } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });
    // Same payload, a fresh delivery — exactly what Shopify redelivery looks
    // like from this handler's point of view (receive.server's own dedup is
    // proven separately in tests/integration/webhooks/dedup.test.ts). The
    // SAME fakeReviewPort instance is reused, so its internal fulfilment
    // -order state carries over between the two calls exactly as Shopify's
    // real, persistent fulfilment order would.
    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(emailPort),
      resolveReviewPort: reviewPortResolver(reviewPort),
    });

    const rowCount = await prisma.luxuryStealOrderCheck.count({
      where: { orderRef, lineRef: "gid://shopify/LineItem/1" },
    });
    expect(rowCount).toBe(1);
    expect(calls).toHaveLength(1);
    // The actual Admin API hold call happens only ONCE — the second delivery
    // sees ON_HOLD already and takes the free short-circuit instead.
    expect(holdCalls).toHaveLength(1);

    const auditEvents = await listAuditEventsForEntity("luxury_steal_order", orderRef);
    expect(auditEvents.filter((e) => e.action === "luxury_steal_order.alert_email_sent")).toHaveLength(1);
    expect(auditEvents.filter((e) => e.action === "luxury_steal_order.fulfillment_hold_applied")).toHaveLength(1);
    expect(
      auditEvents.filter((e) => e.action === "luxury_steal_order.fulfillment_hold_already_in_place")
    ).toHaveLength(1);
  });
});

describe("HMAC-invalid request", () => {
  it("is rejected with 401 and creates no evidence row", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);

    const request = signedRequest(rawBody, randomUUID(), "definitely-the-wrong-secret");
    const response = await ordersCreateAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(401);
    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check).toBeNull();
  });
});

describe("the real route, end to end, with a valid signature", () => {
  it("records nothing for an ordinary (non-Luxury-Steal) order through the full receiveShopifyWebhook chain", async () => {
    // Deliberately NOT a Luxury Steal line: the real route has no seam to
    // inject a fake LuxuryStealOrderReviewPort, and this suite must not
    // attempt a live Shopify Admin API call for the tag/hold reconciliation
    // step (no deploy, no live gate, from this task's own instructions). An
    // ordinary order proves the HMAC/dedup/route wiring end to end without
    // ever reaching that step (lsLineCount stays 0) — the LS-specific
    // matched/unmatched/tag/hold behaviour is proven directly above, against
    // the handler, with injected fakes.
    const { SHOPIFY_API_SECRET } = getEnv();
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: false });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);

    const request = signedRequest(rawBody, randomUUID(), SHOPIFY_API_SECRET);
    const response = await ordersCreateAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(200);
    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check).toBeNull();
  });
});
