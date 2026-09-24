import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { getLuxuryStealOrderCheck } from "~/db/repositories/luxuryStealRepository.server";
import type { EmailPortResolution } from "~/lib/email/configuredPort.server";
import { getEnv } from "~/lib/env.server";
import type { EmailPort, SendEmailInput } from "~/lib/email/port";
import { action as ordersCreateAction } from "~/routes/webhooks.carat.orders-create";
import { SHOPIFY_EVENT_ID_HEADER, SHOPIFY_HMAC_HEADER, SHOPIFY_TOPIC_HEADER } from "~/shopify/webhooks/headers";
import { handleLuxuryStealOrderCreateWebhook } from "~/shopify/webhooks/luxuryStealOrderHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/**
 * Slice 3 task 3-4 — `orders/create` verification against real Postgres
 * (docs/specs/SLICE-3-LUXURY-STEALS.md §4.4, criteria 137-140, 150). This is
 * the load-bearing enforcement D6 relies on with no Cart/Checkout Validation
 * Function shipping in MVP1 — see `luxuryStealOrderHandler.server.ts`'s own
 * doc comment.
 *
 * Two layers are exercised deliberately:
 *   - `handleLuxuryStealOrderCreateWebhook` called DIRECTLY, with an injected
 *     fake `EmailPort`, for every matching/tamper/idempotency scenario — this
 *     is the only way to assert the alert-dispatch count precisely, and HMAC
 *     verification is already `receive.server.ts`'s own job, proven in
 *     `tests/integration/webhooks/dedup.test.ts`.
 *   - the real route `action` (`~/routes/webhooks.carat.orders-create`), for
 *     the HMAC-rejection case and one full-chain sanity check, so the actual
 *     wiring this ships behind is proven at least once end-to-end.
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

describe("a line with valid, variant-matching evidence", () => {
  it("is recorded as matched and sends no alert", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });
    const ack = await createAcknowledgment(variant.shopifyVariantGid!);

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: ack.id },
    ]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("matched");
    expect(check?.matchedAcknowledgmentId).toBe(ack.id);
    expect(check?.variantRef).toBe(variant.id);
    expect(calls).toHaveLength(0);
  });
});

describe("a line with no _carat_ls_ack property", () => {
  it("is recorded as unmatched, held, and alerted", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
    expect(check?.matchedAcknowledgmentId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toContain(`gid://shopify/Order/${orderId}`);
    expect(calls[0]?.text).toContain(variant.id);
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
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
    expect(check?.matchedAcknowledgmentId).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("a line naming an acknowledgment id that does not exist", () => {
  it("is recorded as unmatched", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: randomUUID() },
    ]);

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
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

    await expect(
      handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
        resolveEmailPort: () => ({ configured: false, reason: "not configured for this test" }),
      })
    ).resolves.toBeUndefined();

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("unmatched");
  });
});

describe("a non-Luxury-Steal line", () => {
  it("gets no evidence row, no alert, and leaves the order otherwise untouched", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: false });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });

    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("a custom/manual line item with no variant_id at all", () => {
  it("is skipped: no evidence row, no crash", async () => {
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [{ lineId: "1" }]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
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
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(matchedVariant.shopifyVariantGid!), ackId: ack.id },
      { lineId: "2", variantId: variantIdFromGid(unmatchedVariant.shopifyVariantGid!) },
      { lineId: "3", variantId: variantIdFromGid(ordinaryVariant.shopifyVariantGid!) },
    ]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });

    const orderRef = `gid://shopify/Order/${orderId}`;
    await expect(getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/1")).resolves.toMatchObject({
      outcome: "matched",
    });
    await expect(getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/2")).resolves.toMatchObject({
      outcome: "unmatched",
    });
    await expect(getLuxuryStealOrderCheck(orderRef, "gid://shopify/LineItem/3")).resolves.toBeNull();

    // Exactly one alert for the whole order, even though only one line is unmatched.
    expect(calls).toHaveLength(1);
  });
});

describe("redelivery of the same orders/create event", () => {
  it("creates exactly one evidence row and sends exactly one alert", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!) },
    ]);
    const { port, calls } = fakeEmailPort();

    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });
    // Same payload, a fresh delivery — exactly what Shopify redelivery looks
    // like from this handler's point of view (receive.server's own dedup is
    // proven separately in tests/integration/webhooks/dedup.test.ts).
    await handleLuxuryStealOrderCreateWebhook(receivedEvent(rawBody), {
      resolveEmailPort: configuredResolver(port),
    });

    const rowCount = await prisma.luxuryStealOrderCheck.count({
      where: { orderRef: `gid://shopify/Order/${orderId}`, lineRef: "gid://shopify/LineItem/1" },
    });
    expect(rowCount).toBe(1);
    expect(calls).toHaveLength(1);
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
  it("records the check through the full receiveShopifyWebhook chain", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });
    const ack = await createAcknowledgment(variant.shopifyVariantGid!);

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variantIdFromGid(variant.shopifyVariantGid!), ackId: ack.id },
    ]);

    const request = signedRequest(rawBody, randomUUID(), SHOPIFY_API_SECRET);
    const response = await ordersCreateAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(200);
    const check = await getLuxuryStealOrderCheck(`gid://shopify/Order/${orderId}`, "gid://shopify/LineItem/1");
    expect(check?.outcome).toBe("matched");
  });
});
