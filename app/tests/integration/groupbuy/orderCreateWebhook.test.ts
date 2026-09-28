import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import { getEnv } from "~/lib/env.server";
import { action as ordersCreateAction } from "~/routes/webhooks.carat.orders-create";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { RecordingPriceSyncPort } from "~/jobs/pricing/ports";
import { closeGroupBuyCampaign, getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { handleGroupBuyOrderCreateWebhook } from "~/shopify/webhooks/groupBuyOrderHandler.server";
import { SHOPIFY_EVENT_ID_HEADER, SHOPIFY_HMAC_HEADER, SHOPIFY_TOPIC_HEADER } from "~/shopify/webhooks/headers";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/**
 * `orders/create` Group Buy participation — closes the gap the architect
 * found: `recordUnitEvent` (app/jobs/groupbuy/unitLedger.server.ts) had zero
 * callers, so a placed Group Buy order never counted toward campaign
 * progress. The unit-ledger/tier/price-ladder domain is unchanged and
 * already covered by `tests/integration/groupbuy/unitLedger.test.ts` and
 * `openCampaign.test.ts`; this file proves the webhook wiring that feeds it,
 * and the tier-price-sync side effect, against real Postgres.
 *
 * `handleGroupBuyOrderCreateWebhook` is called DIRECTLY (with an injected
 * fake `ShopifyPriceSyncPort`) for every ledger/sync/idempotency scenario —
 * the only way to assert Admin API call counts precisely without a live
 * Shopify connection. The real route is exercised once, for HMAC/dedup/route
 * wiring only, using an ORDINARY (non-Group-Buy) variant — the route has no
 * seam to inject a fake sync port, and a real Group Buy tier-unlock through
 * it would attempt a genuine Admin API call depending on the machine's
 * SHOPIFY_SHOP_DOMAIN, which this suite must never do (same constraint
 * `tests/integration/luxurysteals/orderCreateWebhook.test.ts` documents for
 * its own real-route test).
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

/**
 * A DEDICATED, FRESH product/variant — deliberately NOT the shared
 * "heaviest active variant" `unitLedger.test.ts`/`openCampaign.test.ts`/
 * `refundLedger.test.ts`/etc. all pick via `orderBy: baseWeightGrams desc`.
 *
 * THE BUG THIS REPLACED: an earlier version of this helper reused that
 * shared row and, when it had no Shopify ids yet (seed data sets neither),
 * UPDATED it in place to add them. Because every Group Buy integration test
 * file shares one disposable database for the whole run
 * (`vitest.integration.config.ts`'s `fileParallelism: false`), that mutation
 * persisted for every test file that ran afterward — so `refundLedger.test.ts`
 * and `groupBuyRepository.test.ts` started finding an ALREADY-linked variant
 * and their `openGroupBuyCampaign` calls (which now also publish tier 1 —
 * see `openCampaign.server.ts`) attempted genuine Shopify Admin API calls
 * they had never made before, and failed. Never mutate a variant another
 * file's fixture might already be relying on being unlinked; create your own
 * instead.
 *
 * `metal: gold` / `purity: GOLD_14K` / `laborSource: india` are exactly the
 * combination several real seeded variants already use (prisma/seed.ts), so
 * `resolveInputsForVariant` resolves metal price, labor rate and every
 * required cost component from the SAME global seed rows those variants do —
 * nothing here is variant-specific except the row itself and its Shopify ids.
 * `sizeAxis: "none"` on the product needs no bands at all
 * (`app/domain/pricing/weight.ts` returns immediately for it).
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
      // HEAVY ON PURPOSE. A light (3g) plain-metal ring's computed Buy Now
      // price clears the minimum-dollar-profit floor at tier 1's full price
      // but NOT at tier 2/3's 1-2% discount — the absolute profit is too
      // close to the floor to survive any discount at all. 50g of gold gives
      // enough absolute margin that a 1-2% Group Buy discount still clears
      // the floor comfortably, which is what `openGroupBuyCampaign`'s own
      // tier-safety check (`evaluateTierSafety`) requires before it will
      // freeze/open at all — unrelated to anything this file is testing.
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid,
      // EXCLUDED from every other Group Buy integration test file's shared
      // "heaviest active, non-Luxury-Steal variant" fixture query
      // (`where: { status: "active", isLuxurySteal: false }, orderBy:
      // baseWeightGrams desc`) — see the module doc comment on
      // `createPriceableVariant` for why a 50g variant would otherwise get
      // PICKED UP by unrelated files the instant it exists, since it out-
      // weighs every seeded variant. `isLuxurySteal` has no bearing on
      // Group Buy pricing/eligibility itself (it is a separate, unrelated
      // merchandising flag), so flipping it here is inert for everything
      // this file actually tests.
      isLuxurySteal: true,
    },
  });

  return { variantId: variant.id, shopifyVariantGid, shopifyProductGid };
}

/**
 * Tier thresholds/multipliers mirror `unitLedger.test.ts`'s own fixture
 * shape. `openPort` is REQUIRED (no default): `openGroupBuyCampaign` now
 * publishes tier 1 as part of opening (the architect's extension of this
 * task, closing the "campaign opens with zero orders and no Shopify price"
 * gap), so every caller must be deliberate about what happens to that first
 * publish rather than silently hitting the real Admin API port.
 */
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
  return { campaignId: draft.id, variantId, shopifyVariantGid, shopifyProductGid };
}

interface RawLineSpec {
  lineId: string;
  /** Bare digits, or omitted for a custom/manual line item with no variant. */
  variantId?: string;
  quantity: number;
}

/** Hand-built raw JSON (never `JSON.stringify`) so `id`/`variant_id` are genuinely unquoted numeric tokens, exercising `preserveShopifyBigIntIds` end to end — same discipline as the Luxury Steal suite's own raw-body builder. */
function buildOrderRawBody(orderId: string, lines: RawLineSpec[], extra: { financialStatus?: string } = {}): string {
  const lineItemsJson = lines
    .map((l) => {
      const variantField = l.variantId !== undefined ? `"variant_id":${l.variantId}` : `"variant_id":null`;
      return `{"id":${l.lineId},"admin_graphql_api_id":"gid://shopify/LineItem/${l.lineId}",${variantField},"quantity":${l.quantity}}`;
    })
    .join(",");
  const financialStatusJson = extra.financialStatus ? `,"financial_status":"${extra.financialStatus}"` : "";
  return `{"id":${orderId},"admin_graphql_api_id":"gid://shopify/Order/${orderId}","created_at":"2026-09-27T00:00:00Z"${financialStatusJson},"line_items":[${lineItemsJson}]}`;
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

describe("a Group Buy eligible line on an open campaign", () => {
  it("counts UNITS, not lines or orders; tier 1 is already published at open, so a same-tier order adds no new call", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid, shopifyProductGid } = await openCampaignFixture(port);

    // ARCHITECT'S EXTENSION (2026-09-27): `openGroupBuyCampaign` now publishes
    // tier 1 as part of opening (see `openCampaign.server.ts`'s
    // `CampaignOpenTierPublishError` doc comment for why) — dedicated
    // coverage for that lives in `openCampaignTierPublish.test.ts`. Asserted
    // again here only as the baseline this file's own call counts build on.
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ shopifyProductGid, shopifyVariantGid });

    const orderId = nextNumericId();
    const rawBody = buildOrderRawBody(orderId, [{ lineId: "1", variantId: shopifyVariantGid.split("/").pop(), quantity: 3 }]);

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => port });

    expect((await getQualifyingUnits(campaignId)).total).toBe(3);

    // Still tier 1 (3 units, threshold for tier 2 is 5) and tier 1 was
    // already fully published at open — no second call.
    expect(port.calls).toHaveLength(1);

    const marker = (await listAuditEventsForEntity("group_buy_campaign", campaignId)).find(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(marker).toMatchObject({ after: { tierNumber: 1 } });
  });

  it("a tier unlock triggers exactly one additional price sync per affected variant, at the new (lower) price", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(port);
    expect(port.calls).toHaveLength(1); // tier 1 published at open
    const numericVariantId = shopifyVariantGid.split("/").pop();

    await handleGroupBuyOrderCreateWebhook(
      receivedEvent(buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 5 }])),
      { resolveSyncPort: async () => port }
    );
    // 5 units -> tier 2. Exactly one campaign, one eligible variant -> exactly
    // one NEW call (two total).
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

describe("redelivery of the same orders/create event", () => {
  it("does NOT double-count the unit and does NOT re-publish an already-synced tier", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(port);
    expect(port.calls).toHaveLength(1); // tier 1 published at open
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 5 }]);

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => port });
    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    expect(port.calls).toHaveLength(2); // tier 1 (open) + tier 2 (this order)

    // Same payload, a fresh delivery — exactly what Shopify redelivery looks
    // like from this handler's point of view (receive.server's own dedup is
    // proven separately in tests/integration/webhooks/dedup.test.ts).
    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => port });

    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    expect(port.calls).toHaveLength(2); // the redelivery adds nothing

    const unitRows = await prisma.groupBuyUnitEvent.count({ where: { campaignId, lineRef: "gid://shopify/LineItem/1" } });
    expect(unitRows).toBe(1);
  });
});

describe("a failed price sync", () => {
  it("is retried on redelivery and eventually completes, WITHOUT re-recording the unit or losing the committed evidence in the meantime", async () => {
    // THE MONEY-CRITICAL CASE: if this handler gated the resync on
    // `recordUnitEvent`'s own `duplicate` flag instead of a completion
    // marker, a redelivery after a failed Admin API call would see
    // `duplicate: true` and skip syncing forever — Shopify would stay stale
    // with nothing left to correct it. This proves that is not what happens.
    const openPort = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(openPort);
    expect(openPort.calls).toHaveLength(1); // tier 1 published cleanly at open

    const numericVariantId = shopifyVariantGid.split("/").pop();
    // Quantity 5 crosses straight to tier 2, which has never been published —
    // the ORDER's own sync attempt is what this test needs to fail and retry.
    const rawBody = buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 5 }]);

    let attempt = 0;
    const failThenSucceed: ShopifyPriceSyncPort = {
      async applyVariantPrice() {
        attempt += 1;
        if (attempt === 1) throw new Error("simulated Shopify Admin API outage");
        return { appliedAt: new Date() };
      },
    };

    // The wrapping error carries the failed variant's error NAME, not its
    // message (tierPriceSync.server.ts logs the full message but only
    // propagates `error.name` into the failure list — criterion 30 keeps
    // cost/detail out of aggregated failure text) — a plain `Error` has name
    // "Error", so the assertion below matches the wrapping text, not the
    // injected message. `openCampaignTierPublish.test.ts`'s equivalent test
    // asserts on the error CLASS instead for the same reason.
    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => failThenSucceed })
    ).rejects.toThrow(/tier price sync incomplete/);

    // Postgres first, Shopify after: the unit (and the tier-2 unlock) is
    // committed even though the tier-2 PUBLISH attempt failed and the
    // handler rejected.
    expect((await getQualifyingUnits(campaignId)).total).toBe(5);
    const markersAfterFailure = (await listAuditEventsForEntity("group_buy_campaign", campaignId)).filter(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(markersAfterFailure.map((m) => (m.after as { tierNumber: number }).tierNumber)).toEqual([1]); // tier 2 not marked yet

    // Redelivery: same event, same handler call. The unit event is a
    // no-op replay (unique externalRef); the sync is NOT a no-op, because no
    // completion marker was ever written for the failed attempt.
    await expect(
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => failThenSucceed })
    ).resolves.toBeUndefined();

    expect(attempt).toBe(2);
    expect((await getQualifyingUnits(campaignId)).total).toBe(5); // no double count from the retry
    const markersAfterRetry = (await listAuditEventsForEntity("group_buy_campaign", campaignId)).filter(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(markersAfterRetry.map((m) => (m.after as { tierNumber: number }).tierNumber).sort()).toEqual([1, 2]);
  });
});

describe("a pending Bank Payment order", () => {
  it("counts toward campaign progress immediately — payment status is never consulted", async () => {
    const port = new RecordingPriceSyncPort();
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(port);
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = buildOrderRawBody(
      nextNumericId(),
      [{ lineId: "1", variantId: numericVariantId, quantity: 2 }],
      { financialStatus: "pending" }
    );

    await handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => port });

    expect((await getQualifyingUnits(campaignId)).total).toBe(2);
  });
});

describe("a variant not eligible for any open campaign", () => {
  it("records nothing and never touches the sync port", async () => {
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
      handleGroupBuyOrderCreateWebhook(receivedEvent(rawBody), { resolveSyncPort: async () => port })
    ).resolves.toBeUndefined();

    expect(port.calls).toHaveLength(0);
    const unitRows = await prisma.groupBuyUnitEvent.count({ where: { masterVariantId: variant.id } });
    expect(unitRows).toBe(0);
  });
});

describe("a campaign closed between the eligibility read and the write", () => {
  it("does not record a unit, does not throw, and leaves the locked final count untouched", async () => {
    const { campaignId, shopifyVariantGid } = await openCampaignFixture(new RecordingPriceSyncPort());
    const numericVariantId = shopifyVariantGid.split("/").pop();

    // One order before close, to give the campaign a non-zero locked count.
    await handleGroupBuyOrderCreateWebhook(
      receivedEvent(buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 2 }])),
      { resolveSyncPort: async () => new RecordingPriceSyncPort() }
    );
    await closeGroupBuyCampaign({ campaignId, closedBy: "integration-test" });

    const port = new RecordingPriceSyncPort();
    await expect(
      handleGroupBuyOrderCreateWebhook(
        receivedEvent(buildOrderRawBody(nextNumericId(), [{ lineId: "1", variantId: numericVariantId, quantity: 1 }])),
        { resolveSyncPort: async () => port }
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
    // inject a fake ShopifyPriceSyncPort, and this suite must never let a
    // tier-unlock reach the real, machine-configured Admin API client. An
    // ordinary order proves the HMAC/dedup/route-composition wiring (both
    // handlers run, in one delivery) without ever reaching
    // `createProductionPriceSyncPort` — matching the constraint
    // `tests/integration/luxurysteals/orderCreateWebhook.test.ts` documents
    // for its own real-route test.
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
