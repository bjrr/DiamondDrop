import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import { getGroupBuyOrderCancellationCheck } from "~/db/repositories/groupBuyOrderCancellationCheckRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
import type { EmailPort, SendEmailInput } from "~/lib/email/port";
import type { EmailPortResolution } from "~/lib/email/configuredPort.server";
import { getEnv } from "~/lib/env.server";
import { action as ordersCreateAction } from "~/routes/webhooks.carat.orders-create";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { RecordingPriceSyncPort } from "~/jobs/pricing/ports";
import { closeGroupBuyCampaign, getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import type { FulfillmentOrderSummary, LuxuryStealOrderReviewPort } from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";
import { handleGroupBuyOrderCreateWebhook } from "~/shopify/webhooks/groupBuyOrderHandler.server";
import { SHOPIFY_EVENT_ID_HEADER, SHOPIFY_HMAC_HEADER, SHOPIFY_TOPIC_HEADER } from "~/shopify/webhooks/headers";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/**
 * `orders/create` Group Buy participation AND order-time cancellation
 * -acknowledgment verification (owner spec 2026-09-27/28) — against real
 * Postgres. See `groupBuyOrderHandler.server.ts`'s own module comment for the
 * full design; this file proves it end to end, mirroring
 * `tests/integration/luxurysteals/orderCreateWebhook.test.ts`'s shape
 * deliberately (fake review port + fake email port injected directly into
 * `handleGroupBuyOrderCreateWebhook`, real route exercised once for HMAC/
 * dedup/route-composition only, using an ORDINARY non-Group-Buy order so the
 * real route never reaches a live Shopify Admin API client).
 *
 * THE CRITICAL ORDERING UNDER TEST, REPEATEDLY: a unit is recorded IF AND
 * ONLY IF the line's cancellation acknowledgment verifies. A missing,
 * copied, or mismatched acknowledgment must produce ZERO units — not a unit
 * plus a hold — because Group Buy progress is monotonic and cannot be safely
 * un-counted after the fact (see the handler's own doc comment).
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

function customerGidFromNumericId(id: string): string {
  return `gid://shopify/Customer/${id}`;
}

/**
 * A DEDICATED, FRESH product/variant — deliberately NOT the shared
 * "heaviest active variant" other Group Buy integration files pick. See the
 * git history of this file for the bug that pattern caused when it was
 * shared: a mutation to a shared row persisted across the whole disposable
 * database for the suite's run (`fileParallelism: false`).
 */
async function createPriceableVariant() {
  const product = await prisma.masterProduct.create({
    data: {
      name: `order-webhook priceable fixture ${nextNumericId()}`,
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
  const shopifyProductGid = `gid://shopify/Product/test-${product.id}`;
  await prisma.masterProduct.update({ where: { id: product.id }, data: { shopifyProductGid } });

  const shopifyVariantGid = `gid://shopify/ProductVariant/${nextNumericId()}`;
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      // HEAVY ON PURPOSE — see the original fixture's own comment: enough
      // absolute margin that a 1-2% Group Buy discount still clears
      // `evaluateTierSafety`'s floor.
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid,
      isLuxurySteal: true, // EXCLUDED from every other file's shared "heaviest, non-Luxury-Steal" fixture query
    },
  });

  return { variantId: variant.id, shopifyVariantGid, shopifyProductGid };
}

async function openCampaignFixture(openPort: ShopifyPriceSyncPort) {
  const { variantId, shopifyVariantGid, shopifyProductGid } = await createPriceableVariant();

  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-order-webhook-${uniq()}`,
      name: "order webhook fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          { tierNumber: 3, minQualifyingUnits: 10, priceMultiplier: "0.980000" },
        ],
      },
      variants: {
        create: [{ masterVariantId: variantId, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n }],
      },
    },
  });

  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => openPort });
  return { campaignId: draft.id, campaignCode: draft.code, variantId, shopifyVariantGid, shopifyProductGid };
}

// ---------------------------------------------------------------------------
// Cancellation-acknowledgment fixtures — REAL provisioned policy_version row
// (the migration already applies to this disposable database, exactly as it
// would in production), never a synthetic duplicate under the same slug.
// ---------------------------------------------------------------------------

async function resolveRealCancellationPolicyVersion() {
  const pv = await getLatestPolicyVersion(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!pv) {
    throw new Error(
      "expected the Group Buy cancellation policy_version migration to already be applied to this database"
    );
  }
  return pv;
}

/** A fully valid acknowledgment — captured for THIS customer, THIS campaign, at the CURRENT required text/label/policy version. */
async function createValidCancellationAcknowledgment(input: { customerGid: string; campaignCode: string }) {
  const pv = await resolveRealCancellationPolicyVersion();
  return prisma.acknowledgment.create({
    data: {
      exactText: pv.text,
      policyVersionId: pv.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
      customerRef: input.customerGid,
      campaignRef: input.campaignCode,
    },
  });
}

interface RawLineSpec {
  lineId: string;
  /** Bare digits, or omitted for a custom/manual line item with no variant. */
  variantId?: string;
  quantity: number;
  /** The `_carat_gb_cancel_ack` line item property value, or omitted for "no acknowledgment attached at all". */
  ackId?: string;
}

/** Hand-built raw JSON (never `JSON.stringify`) so `id`/`variant_id`/`customer.id` are genuinely unquoted numeric tokens, exercising `preserveShopifyBigIntIds` end to end. */
function buildOrderRawBody(
  orderId: string,
  lines: RawLineSpec[],
  extra: { financialStatus?: string; customerId?: string } = {}
): string {
  const lineItemsJson = lines
    .map((l) => {
      const variantField = l.variantId !== undefined ? `"variant_id":${l.variantId}` : `"variant_id":null`;
      const propertiesJson = l.ackId ? `[{"name":"_carat_gb_cancel_ack","value":${JSON.stringify(l.ackId)}}]` : `[]`;
      return `{"id":${l.lineId},"admin_graphql_api_id":"gid://shopify/LineItem/${l.lineId}",${variantField},"quantity":${l.quantity},"properties":${propertiesJson}}`;
    })
    .join(",");
  const financialStatusJson = extra.financialStatus ? `,"financial_status":"${extra.financialStatus}"` : "";
  const customerJson = extra.customerId
    ? `,"customer":{"id":${extra.customerId},"admin_graphql_api_id":"gid://shopify/Customer/${extra.customerId}"}`
    : "";
  return `{"id":${orderId},"admin_graphql_api_id":"gid://shopify/Order/${orderId}","created_at":"2026-09-27T00:00:00Z"${financialStatusJson}${customerJson},"line_items":[${lineItemsJson}]}`;
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

// ---------------------------------------------------------------------------
// Fake review/email ports — mirror
// `tests/integration/luxurysteals/orderCreateWebhook.test.ts`'s identically
// -shaped fixtures, adapted for the caller-supplied `handle` parameter
// (`holdFulfillmentOrder`'s signature after this task's generalization).
// ---------------------------------------------------------------------------

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
  return () => ({ configured: true, port, from: "alerts@caratforus.example", recipients: ["staff@example.com"] });
}

/** STATEFUL, same reasoning as the Luxury Steal suite's own fixture: a successful hold updates the fake's own status map, so a second call against the SAME instance observes ON_HOLD and short-circuits. */
function fakeReviewPort(
  options: {
    fulfillmentOrders?: FulfillmentOrderSummary[];
    failTag?: boolean;
    failListFulfillmentOrders?: boolean;
    holdOutcomeOverride?: Record<string, "already_held" | "fail">;
  } = {}
) {
  const tagCalls: { orderGid: string; tags: string[] }[] = [];
  const holdCalls: { fulfillmentOrderGid: string; reasonNotes: string; handle: string }[] = [];
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
    async holdFulfillmentOrder({ fulfillmentOrderGid, reasonNotes, handle }) {
      holdCalls.push({ fulfillmentOrderGid, reasonNotes, handle });
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

function oneOpenFulfillmentOrder(id = "gid://shopify/FulfillmentOrder/1"): FulfillmentOrderSummary[] {
  return [{ id, status: "OPEN" }];
}

describe("a Group Buy eligible line with a VALID, fully verified cancellation acknowledgment", () => {
  it("counts UNITS, tags the order Group Buy (verified), and never holds", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid, shopifyProductGid } = await openCampaignFixture(port);
    expect(port.calls).toHaveLength(1); // tier 1 published at open
    expect(port.calls[0]).toMatchObject({ shopifyProductGid, shopifyVariantGid });

    const customerId = nextNumericId();
    const customerGid = customerGidFromNumericId(customerId);
    const ack = await createValidCancellationAcknowledgment({ customerGid, campaignCode });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(
      orderId,
      [{ lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 3, ackId: ack.id }],
      { customerId }
    );

    const { port: reviewPort, tagCalls, holdCalls } = fakeReviewPort();
    const { port: emailPort, calls: emailCalls } = fakeEmailPort();

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(emailPort),
    });

    expect((await getQualifyingUnits(campaignId)).total).toBe(3);
    expect(port.calls).toHaveLength(1); // still tier 1 — no new price sync

    expect(tagCalls).toEqual([{ orderGid: `gid://shopify/Order/${orderId}`, tags: ["Group Buy"] }]);
    expect(holdCalls).toHaveLength(0);
    expect(emailCalls).toHaveLength(0); // nothing held, nothing to alert on

    const orderGid = `gid://shopify/Order/${orderId}`;
    const check = await getGroupBuyOrderCancellationCheck(orderGid, "gid://shopify/LineItem/1", campaignCode);
    expect(check).toMatchObject({ outcome: "matched", matchedAcknowledgmentId: ack.id, mismatchReason: null });
  });

  it("a tier unlock still triggers exactly one additional price sync", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(port);
    expect(port.calls).toHaveLength(1);
    const numericVariantId = shopifyVariantGid.split("/").pop();

    const customerId = nextNumericId();
    const ack = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(customerId),
      campaignCode,
    });

    await handleGroupBuyOrderCreateWebhook(
      receivedEvent(
        buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 5, ackId: ack.id }], {
          customerId,
        })
      ),
      {
        resolveSyncPort: async () => port,
        resolveReviewPort: reviewPortResolver(fakeReviewPort().port),
        resolveEmailPort: configuredResolver(fakeEmailPort().port),
      }
    );

    expect(port.calls).toHaveLength(2);
    expect(BigInt(port.calls[1]!.regularCardPriceMinorUnits)).toBeLessThan(
      BigInt(port.calls[0]!.regularCardPriceMinorUnits)
    );
    const markers = (await listAuditEventsForEntity("group_buy_campaign", campaignId)).filter(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(markers.map((m) => (m.after as { tierNumber: number }).tierNumber).sort()).toEqual([1, 2]);
  });
});

describe("THE ATTACK THIS CLOSES — a missing, copied, or mismatched acknowledgment", () => {
  it("no acknowledgment property at all — zero units, tagged for review, and the fulfilment order is held", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(port);
    const customerId = nextNumericId();
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(
      orderId,
      [{ lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 5 }], // no ackId at all
      { customerId }
    );

    const { port: reviewPort, tagCalls, holdCalls } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });
    const { port: emailPort, calls: emailCalls } = fakeEmailPort();

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(emailPort),
    });

    // THE PROTECTION THAT ACTUALLY MATTERS: zero units, even though 5 would
    // have crossed the tier-2 threshold. Monotonic progress was never
    // touched by this order at all.
    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
    expect(port.calls).toHaveLength(1); // tier 1 (open only) — no sync attempt from this order

    expect(tagCalls).toEqual([{ orderGid: `gid://shopify/Order/${orderId}`, tags: ["Group Buy: Needs Review"] }]);
    expect(holdCalls).toHaveLength(1);
    expect(holdCalls[0]!.handle).toMatch(/^carat:gb-cancel-unverified:/);
    expect(emailCalls).toHaveLength(1);

    const check = await getGroupBuyOrderCancellationCheck(
      `gid://shopify/Order/${orderId}`,
      "gid://shopify/LineItem/1",
      campaignCode
    );
    expect(check).toMatchObject({ outcome: "unmatched", matchedAcknowledgmentId: null, mismatchReason: "no_candidate" });
  });

  it("THE COPIED CASE — a real, resolvable acknowledgment belonging to a DIFFERENT customer must NOT pass", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(port);

    // A perfectly real acknowledgment — just captured by SOMEONE ELSE.
    const someoneElseAck = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(nextNumericId()),
      campaignCode,
    });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(
      orderId,
      [{ lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 2, ackId: someoneElseAck.id }],
      { customerId: nextNumericId() } // the ORDER's own (different) customer
    );

    const { port: reviewPort, tagCalls, holdCalls } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(fakeEmailPort().port),
    });

    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
    expect(tagCalls).toEqual([{ orderGid: `gid://shopify/Order/${orderId}`, tags: ["Group Buy: Needs Review"] }]);
    expect(holdCalls).toHaveLength(1);

    const check = await getGroupBuyOrderCancellationCheck(
      `gid://shopify/Order/${orderId}`,
      "gid://shopify/LineItem/1",
      campaignCode
    );
    expect(check).toMatchObject({ outcome: "unmatched", mismatchReason: "customer_mismatch" });
  });

  it("THE COPIED CASE — the customer's OWN acknowledgment from a DIFFERENT campaign must NOT pass", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(port);
    const customerId = nextNumericId();

    // Real acknowledgment, real customer — just for a DIFFERENT campaign.
    const wrongCampaignAck = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(customerId),
      campaignCode: `some-other-campaign-${uniq()}`,
    });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(
      orderId,
      [{ lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 1, ackId: wrongCampaignAck.id }],
      { customerId }
    );

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() }).port),
      resolveEmailPort: configuredResolver(fakeEmailPort().port),
    });

    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
  });

  it("a syntactically invalid (non-UUID) acknowledgment property value is unmatched, not a crash", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(port);
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(
      orderId,
      [{ lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 1, ackId: "not-a-uuid-at-all" }],
      { customerId: nextNumericId() }
    );

    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
        resolveSyncPort: async () => port,
        resolveReviewPort: reviewPortResolver(fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() }).port),
        resolveEmailPort: configuredResolver(fakeEmailPort().port),
      })
    ).resolves.toBeUndefined();

    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
  });

  it("a guest order (no Shopify customer at all) can never verify, even with an otherwise-real acknowledgment id", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(port);
    // A real acknowledgment for a REAL customer — but this order carries NO customer at all.
    const ack = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(nextNumericId()),
      campaignCode,
    });
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 1, ackId: ack.id },
    ]); // no customerId at all

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() }).port),
      resolveEmailPort: configuredResolver(fakeEmailPort().port),
    });

    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
  });
});

describe("redelivery of the same orders/create event", () => {
  it("does NOT double-count the unit, does NOT re-tag/re-hold via a second call, and does not re-publish an already-synced tier", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(port);
    const customerId = nextNumericId();
    const ack = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(customerId),
      campaignCode,
    });
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = buildOrderRawBody(
      nextNumericId(),
      [{ lineId: "1", variantId: numericVariantId, quantity: 5, ackId: ack.id }],
      { customerId }
    );
    const event = receivedEvent(rawBody);

    const { port: reviewPort, tagCalls } = fakeReviewPort();

    await handleGroupBuyOrderCreateWebhook(event, {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(fakeEmailPort().port),
    });
    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    expect(port.calls).toHaveLength(2); // tier 1 (open) + tier 2 (this order)
    expect(tagCalls).toHaveLength(1);

    // Same payload, a fresh delivery — exactly what Shopify redelivery looks
    // like from this handler's point of view.
    await handleGroupBuyOrderCreateWebhook(event, {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(fakeEmailPort().port),
    });

    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    expect(port.calls).toHaveLength(2); // the redelivery adds nothing
    expect(tagCalls).toHaveLength(2); // tagsAdd is naturally idempotent — called again, no error, no new tag

    const unitRows = await prisma.groupBuyUnitEvent.count({ where: { campaignId, lineRef: "gid://shopify/LineItem/1" } });
    expect(unitRows).toBe(1);
    // Scoped by campaignRef (unique per test), not bare lineRef — every test
    // in this file reuses lineId "1", so an unscoped count would see every
    // OTHER test's rows too.
    const checkRows = await prisma.groupBuyOrderCancellationCheck.count({
      where: { lineRef: "gid://shopify/LineItem/1", campaignRef: campaignCode },
    });
    expect(checkRows).toBe(1); // the unique (orderRef, lineRef, campaignRef) constraint held
  });

  it("an unmatched line's redelivery holds again (idempotently, via DUPLICATE_FULFILLMENT_HOLD_HANDLE) but sends only ONE alert email", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(port);
    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 1 }, // no acknowledgment
    ]);
    const event = receivedEvent(rawBody);

    const { port: reviewPort, holdCalls } = fakeReviewPort({ fulfillmentOrders: oneOpenFulfillmentOrder() });
    const { port: emailPort, calls: emailCalls } = fakeEmailPort();

    await handleGroupBuyOrderCreateWebhook(event, {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(emailPort),
    });
    expect(holdCalls).toHaveLength(1);
    expect(emailCalls).toHaveLength(1);

    // Redelivery: the fake's OWN state already shows this fulfilment order
    // ON_HOLD (see fakeReviewPort's own doc comment), so the handler's cheap
    // short-circuit means holdFulfillmentOrder is not even called again.
    await handleGroupBuyOrderCreateWebhook(event, {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(reviewPort),
      resolveEmailPort: configuredResolver(emailPort),
    });

    expect(holdCalls).toHaveLength(1); // no second hold call at all
    expect(emailCalls).toHaveLength(1); // no second alert
    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
  });
});

describe("a failed price sync", () => {
  it("is retried on redelivery and eventually completes, without re-recording the unit or losing committed evidence", async () => {
    const openPort = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(openPort);
    expect(openPort.calls).toHaveLength(1);

    const customerId = nextNumericId();
    const ack = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(customerId),
      campaignCode,
    });
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = buildOrderRawBody(
      nextNumericId(),
      [{ lineId: "1", variantId: numericVariantId, quantity: 5, ackId: ack.id }],
      { customerId }
    );

    let attempt = 0;
    const failThenSucceed: ShopifyPriceSyncPort = {
      async applyVariantPrice() {
        attempt += 1;
        if (attempt === 1) throw new Error("simulated Shopify Admin API outage");
        return { appliedAt: new Date() };
      },
    };

    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
        resolveSyncPort: async () => failThenSucceed,
        resolveReviewPort: reviewPortResolver(fakeReviewPort().port),
        resolveEmailPort: configuredResolver(fakeEmailPort().port),
      })
    ).rejects.toThrow(/tier price sync incomplete/);

    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    const markersAfterFailure = (await listAuditEventsForEntity("group_buy_campaign", campaignId)).filter(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(markersAfterFailure.map((m) => (m.after as { tierNumber: number }).tierNumber)).toEqual([1]);

    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
        resolveSyncPort: async () => failThenSucceed,
        resolveReviewPort: reviewPortResolver(fakeReviewPort().port),
        resolveEmailPort: configuredResolver(fakeEmailPort().port),
      })
    ).resolves.toBeUndefined();

    expect(attempt).toBe(2);
    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    const markersAfterRetry = (await listAuditEventsForEntity("group_buy_campaign", campaignId)).filter(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(markersAfterRetry.map((m) => (m.after as { tierNumber: number }).tierNumber).sort()).toEqual([1, 2]);
  });
});

describe("a pending Bank Payment order", () => {
  it("counts toward campaign progress immediately when verified — payment status is never consulted", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(port);
    const customerId = nextNumericId();
    const ack = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(customerId),
      campaignCode,
    });
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = buildOrderRawBody(
      nextNumericId(),
      [{ lineId: "1", variantId: numericVariantId, quantity: 2, ackId: ack.id }],
      { financialStatus: "pending", customerId }
    );

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
      resolveSyncPort: async () => port,
      resolveReviewPort: reviewPortResolver(fakeReviewPort().port),
      resolveEmailPort: configuredResolver(fakeEmailPort().port),
    });

    expect((await getQualifyingUnits(campaignId)).total).toBe(2);
  });
});

describe("a variant not eligible for any open campaign", () => {
  it("records nothing, checks nothing, and never touches the sync or review port", async () => {
    const product = await prisma.masterProduct.create({
      data: {
        name: `order-webhook non-groupbuy fixture ${nextNumericId()}`,
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
    const variant = await prisma.masterVariant.create({
      data: {
        masterProductId: product.id,
        metal: "gold",
        purity: "GOLD_14K",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
        laborSource: "india",
        shopifyVariantGid: `gid://shopify/ProductVariant/${nextNumericId()}`,
      },
    });

    const port = new RecordingPriceSyncPort();
    const rawBody = buildOrderRawBody(nextNumericId(), [
      { lineId: "1", variantId: variant.shopifyVariantGid!.split("/").pop(), quantity: 4 },
    ]);

    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
        resolveSyncPort: async () => port,
        resolveReviewPort: async () => {
          throw new Error("must not be called — no Group Buy line was ever checked");
        },
        resolveEmailPort: () => {
          throw new Error("must not be called");
        },
      })
    ).resolves.toBeUndefined();

    expect(port.calls).toHaveLength(0);
    const unitRows = await prisma.groupBuyUnitEvent.count({ where: { masterVariantId: variant.id } });
    expect(unitRows).toBe(0);
  });
});

describe("a campaign closed between the eligibility read and the write", () => {
  it("does not record a unit, does not throw, and leaves the locked final count untouched", async () => {
    const { campaignId, campaignCode, shopifyVariantGid } = await openCampaignFixture(new RecordingPriceSyncPort());
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const customerId = nextNumericId();
    const firstAck = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(customerId),
      campaignCode,
    });

    // One order before close, to give the campaign a non-zero locked count.
    await handleGroupBuyOrderCreateWebhook(
      receivedEvent(
        buildOrderRawBody(
          nextNumericId(),
          [{ lineId: "1", variantId: numericVariantId, quantity: 2, ackId: firstAck.id }],
          { customerId }
        )
      ),
      {
        resolveSyncPort: async () => new RecordingPriceSyncPort(),
        resolveReviewPort: reviewPortResolver(fakeReviewPort().port),
        resolveEmailPort: configuredResolver(fakeEmailPort().port),
      }
    );
    await closeGroupBuyCampaign({ campaignId, closedBy: "integration-test" });

    const port = new RecordingPriceSyncPort();
    const secondCustomerId = nextNumericId();
    const secondAck = await createValidCancellationAcknowledgment({
      customerGid: customerGidFromNumericId(secondCustomerId),
      campaignCode,
    });
    await expect(
      handleGroupBuyOrderCreateWebhook(
        receivedEvent(
          buildOrderRawBody(
            nextNumericId(),
            [{ lineId: "1", variantId: numericVariantId, quantity: 1, ackId: secondAck.id }],
            { customerId: secondCustomerId }
          )
        ),
        {
          resolveSyncPort: async () => port,
          resolveReviewPort: reviewPortResolver(fakeReviewPort().port),
          resolveEmailPort: configuredResolver(fakeEmailPort().port),
        }
      )
    ).resolves.toBeUndefined();

    expect(port.calls).toHaveLength(0);
    const closed = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(closed.finalQualifyingUnits).toBe(2);
  });
});

describe("a custom/manual line item with no variant_id at all", () => {
  it("is skipped: no evidence row, no crash", async () => {
    const rawBody = buildOrderRawBody(nextNumericId(), [{ lineId: "1", quantity: 1 }]);
    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), {
        resolveSyncPort: async () => {
          throw new Error("must not be called — no touched campaign");
        },
        resolveReviewPort: async () => {
          throw new Error("must not be called — no Group Buy line was ever checked");
        },
        resolveEmailPort: () => {
          throw new Error("must not be called");
        },
      })
    ).resolves.toBeUndefined();
  });
});

describe("HMAC-invalid request", () => {
  it("is rejected with 401 and records no unit", async () => {
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(new RecordingPriceSyncPort());
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 1 }]);

    const request = signedRequest(rawBody, randomUUID(), "definitely-the-wrong-secret");
    const response = await ordersCreateAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(401);
    expect((await getQualifyingUnits(campaignId)).total).toBe(0);
  });
});

describe("the real route, end to end, with a valid signature", () => {
  it("processes an ordinary (non-Group-Buy) order through the full receiveShopifyWebhook chain without touching any Shopify Admin API", async () => {
    // Deliberately NOT a Group Buy variant: the real route has no seam to
    // inject a fake sync/review port, and this suite must never let this
    // reach the real, machine-configured Admin API client — same constraint
    // the Luxury Steal suite documents for its own real-route test.
    const { SHOPIFY_API_SECRET } = getEnv();
    const product = await prisma.masterProduct.create({
      data: {
        name: `order-webhook real-route fixture ${nextNumericId()}`,
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
    const variant = await prisma.masterVariant.create({
      data: {
        masterProductId: product.id,
        metal: "gold",
        purity: "GOLD_14K",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
        laborSource: "india",
        shopifyVariantGid: `gid://shopify/ProductVariant/${nextNumericId()}`,
      },
    });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [
      { lineId: "1", variantId: variant.shopifyVariantGid!.split("/").pop(), quantity: 1 },
    ]);

    const request = signedRequest(rawBody, randomUUID(), SHOPIFY_API_SECRET);
    const response = await ordersCreateAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(200);
    const unitRows = await prisma.groupBuyUnitEvent.count({ where: { masterVariantId: variant.id } });
    expect(unitRows).toBe(0);
  });
});
