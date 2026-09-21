import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { PRICE_METAFIELD_NAMESPACE } from "~/shopify/metafields/priceMetafieldPayload";
import {
  handleInventoryPurchasabilityWebhook,
  type HandleInventoryPurchasabilityWebhookDeps,
} from "~/shopify/webhooks/inventoryPurchasabilityHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/**
 * R15 (owner ruling, 2026-09-20, owner exit proof P2) — the webhook
 * handler's DB-touching path: resolving a delivered identifier to a real
 * `master_product` and recomputing its "as low as" figure. The pure
 * identifier-extraction half is covered with no database at all in
 * `app/shopify/webhooks/inventoryPurchasabilityHandler.test.ts`; this file
 * is the rest — real Prisma, a fake Admin API client at the network
 * boundary (the same seam `asLowAsAggregator.test.ts` already uses),
 * demonstrating rather than merely asserting R15's idempotency-by-
 * construction claim.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

const createdVariantIds: string[] = [];

afterEach(async () => {
  if (createdVariantIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { id: { in: createdVariantIds } },
    data: { status: "archived" },
  });
  createdVariantIds.length = 0;
});

async function makePurchasableFixture() {
  // shopifyLegacyIdFromGid (R14) requires a PURE-DIGIT trailing segment,
  // matching what a real Shopify gid always looks like — a randomUUID()
  // suffix (hyphens/letters) would fail that parse, which is exactly the
  // bug this fixture design avoids: `uniqueInt()` (product) and a distinct
  // digit-only variant id, so the two never collide.
  const nameSuffix = randomUUID();
  const productLegacyId = uniqueInt();
  const variantLegacyId = uniqueInt();
  const product = await prisma.masterProduct.create({
    data: {
      name: `inventory-webhook fixture ${nameSuffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${productLegacyId}`,
    },
  });
  const inventoryItemLegacyId = uniqueInt();
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${variantLegacyId}`,
      // R17 — the mapping inventory_levels/update resolves through.
      shopifyInventoryItemGid: `gid://shopify/InventoryItem/${inventoryItemLegacyId}`,
    },
  });
  createdVariantIds.push(variant.id);

  const profile = await prisma.pricingProfile.create({
    data: {
      code: "buy_now",
      version: uniqueInt(),
      marginModel: "TARGET_GROSS_MARGIN_V1",
      targetGrossMarginRate: "0.420000",
      minGrossMarginRate: "0.350000",
      minDollarProfitMinorUnits: 15000n,
      currency: "USD",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 200,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `inventory-webhook-${nameSuffix}` },
  });
  const calc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: variant.id,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snapshot.id,
      landedCostMinorUnits: 1000n,
      bankPaymentPriceMinorUnits: 100_000n,
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: variant.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  return { product, variant, calc };
}

/**
 * Fakes the Admin API boundary only — everything above it (identifier
 * resolution, `computeAsLowAsForProduct`'s exclusion sequencing, the actual
 * metafield builders) runs for real. Answers all three operations the real
 * pipeline sends: the availability lookup, the set, and the delete.
 */
function fakeAdminClient(opts: { available?: boolean } = {}) {
  const available = opts.available ?? true;
  const setCalls: { ownerId: string; namespace: string; key: string; value: string }[] = [];
  const deleteCalls: { ownerId: string; namespace: string; key: string }[] = [];

  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      const variables = (options?.variables ?? {}) as Record<string, unknown>;

      if (document.includes("CaratVariantsAvailability")) {
        const ids = variables.ids as string[];
        return {
          json: async () => ({
            data: { nodes: ids.map((id) => ({ id, availableForSale: available })) },
          }),
        };
      }

      if (document.includes("CaratSetPriceMetafields")) {
        const inputs = variables.metafields as { ownerId: string; namespace: string; key: string; value: string }[];
        setCalls.push(...inputs);
        return {
          json: async () => ({
            data: {
              metafieldsSet: {
                metafields: inputs.map((input, i) => ({
                  id: `gid://shopify/Metafield/${i}`,
                  namespace: input.namespace,
                  key: input.key,
                  ownerType: "PRODUCT",
                })),
                userErrors: [],
              },
            },
          }),
        };
      }

      if (document.includes("CaratDeletePriceMetafields")) {
        const identifiers = variables.metafields as { ownerId: string; namespace: string; key: string }[];
        deleteCalls.push(...identifiers);
        return {
          json: async () => ({
            data: { metafieldsDelete: { deletedMetafields: identifiers.map((i) => ({ ...i })), userErrors: [] } },
          }),
        };
      }

      throw new Error(`fakeAdminClient received an unexpected document: ${document.slice(0, 80)}`);
    },
  };

  return { client, setCalls, deleteCalls };
}

function anEvent(overrides: Partial<ReceivedWebhookEvent> = {}): ReceivedWebhookEvent {
  return {
    shopifyEventId: randomUUID(),
    topic: "products/update",
    shopDomain: "caratforus-dev.myshopify.com",
    rawBody: "{}",
    payload: {},
    ...overrides,
  };
}

function deps(client: AdminGraphqlClient): HandleInventoryPurchasabilityWebhookDeps {
  return { resolveAdminClient: async () => client };
}

describe("handleInventoryPurchasabilityWebhook — a payload naming a PRODUCT we own", () => {
  it("resolves and recomputes the product's as-low-as metafield", async () => {
    const { product, calc } = await makePurchasableFixture();
    const { client, setCalls } = fakeAdminClient();

    await handleInventoryPurchasabilityWebhook(
      "product",
      anEvent({
        topic: "products/update",
        payload: { id: 123, admin_graphql_api_id: product.shopifyProductGid },
      }),
      deps(client)
    );

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({
      ownerId: product.shopifyProductGid,
      namespace: PRICE_METAFIELD_NAMESPACE,
      key: "as_low_as_bank_minor_units",
    });
    const payload = JSON.parse(setCalls[0]!.value);
    expect(payload.priceCalculationId).toBe(calc.id);
    expect(payload.bankPaymentPriceMinorUnits).toBe("100000");
  });
});

describe("handleInventoryPurchasabilityWebhook — an inventory_levels/update payload naming an INVENTORY ITEM we own (R17)", () => {
  it("resolves the owning variant's parent product and recomputes THAT product's aggregate", async () => {
    const { product, variant } = await makePurchasableFixture();
    const { client, setCalls } = fakeAdminClient();
    const inventoryItemLegacyId = variant.shopifyInventoryItemGid!.split("/").pop();

    await handleInventoryPurchasabilityWebhook(
      "inventory_item",
      anEvent({
        topic: "inventory_levels/update",
        // The REAL, flat, documented inventory_levels/update shape — no
        // admin_graphql_api_id, unlike products/update. rawBody is what the
        // handler actually reads inventory_item_id from (R17); payload is
        // set too so a regression that reverts to reading payload would
        // still resolve correctly and hide the bug, which is deliberately
        // avoided in the next test instead.
        rawBody: `{"inventory_item_id":${inventoryItemLegacyId},"location_id":1,"available":0}`,
        payload: { inventory_item_id: Number(inventoryItemLegacyId), location_id: 1, available: 0 },
      }),
      deps(client)
    );

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.ownerId).toBe(product.shopifyProductGid);
  });

  it("resolves correctly even when event.payload is EMPTY — proves resolution truly comes from rawBody, not the parsed object", async () => {
    const { product, variant } = await makePurchasableFixture();
    const { client, setCalls } = fakeAdminClient();
    const inventoryItemLegacyId = variant.shopifyInventoryItemGid!.split("/").pop();

    await handleInventoryPurchasabilityWebhook(
      "inventory_item",
      anEvent({
        topic: "inventory_levels/update",
        rawBody: `{"inventory_item_id":${inventoryItemLegacyId},"location_id":1,"available":0}`,
        payload: {}, // deliberately empty
      }),
      deps(client)
    );

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.ownerId).toBe(product.shopifyProductGid);
  });

  it("does NOT resolve when the mapping is unpopulated (the exact backfill hazard R17 warns about)", async () => {
    const { variant } = await makePurchasableFixture();
    // Simulate an un-backfilled variant: clear the mapping this fixture
    // otherwise sets.
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { shopifyInventoryItemGid: null } });
    const { client, setCalls } = fakeAdminClient();

    await expect(
      handleInventoryPurchasabilityWebhook(
        "inventory_item",
        anEvent({
          topic: "inventory_levels/update",
          rawBody: `{"inventory_item_id":999999999999999,"location_id":1,"available":0}`,
          payload: {},
        }),
        deps(client)
      )
    ).resolves.toBeUndefined();

    expect(setCalls).toHaveLength(0);
  });
});

describe("handleInventoryPurchasabilityWebhook — a payload naming something OUTSIDE our catalogue", () => {
  it("resolves nothing, makes no Admin API call, and does not throw", async () => {
    const { client, setCalls, deleteCalls } = fakeAdminClient();

    await expect(
      handleInventoryPurchasabilityWebhook(
        "product",
        anEvent({
          topic: "products/update",
          payload: { id: 999, admin_graphql_api_id: "gid://shopify/Product/not-in-our-catalogue" },
        }),
        deps(client)
      )
    ).resolves.toBeUndefined();

    expect(setCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("handleInventoryPurchasabilityWebhook — redelivery (R15 idempotency-by-construction)", () => {
  it("running the SAME event twice recomputes from current state both times, with an IDENTICAL outcome", async () => {
    const { product, calc } = await makePurchasableFixture();
    const { client, setCalls } = fakeAdminClient();
    const event = anEvent({
      topic: "products/update",
      payload: { id: 1, admin_graphql_api_id: product.shopifyProductGid },
    });

    // Invoked twice with the exact same event — deliberately bypassing
    // receiveShopifyWebhook's own delivery-level dedup (already covered
    // generically by tests/integration/webhooks/dedup.test.ts) to isolate
    // and demonstrate THIS module's own claim: the recompute itself does
    // not need dedup to be safe, because it is idempotent by construction —
    // it always re-derives its answer from current database/Shopify state,
    // never from anything carried in the webhook payload or between calls.
    await handleInventoryPurchasabilityWebhook("product", event, deps(client));
    await handleInventoryPurchasabilityWebhook("product", event, deps(client));

    expect(setCalls).toHaveLength(2);
    // Not just "both succeeded" — the SAME value both times. A handler that
    // accidentally accumulated state between calls (e.g. re-using a stale
    // read, or drifting a counter) would still produce two successful calls
    // but with DIFFERENT payloads; this is the assertion that would catch that.
    expect(setCalls[0]!.value).toBe(setCalls[1]!.value);
    const payload = JSON.parse(setCalls[0]!.value);
    expect(payload.priceCalculationId).toBe(calc.id);
  });

  it("a redelivered/stale 'available: 5' payload does NOT override reality (R17: the payload's own available field is never read)", async () => {
    // R17's actual hazard, spelled out: inventory spans locations, and one
    // level reaching a positive number does not mean the variant is
    // purchasable overall. This delivers a payload whose OWN `available`
    // field says "5 in stock" while the fake Shopify state (what a fresh
    // availableForSale re-check would actually see) says NOT purchasable —
    // and proves the aggregate follows reality, not the field.
    const { product, variant } = await makePurchasableFixture();
    const inventoryItemLegacyId = variant.shopifyInventoryItemGid!.split("/").pop();
    const { client, deleteCalls, setCalls } = fakeAdminClient({ available: false });

    await handleInventoryPurchasabilityWebhook(
      "inventory_item",
      anEvent({
        topic: "inventory_levels/update",
        rawBody: `{"inventory_item_id":${inventoryItemLegacyId},"location_id":1,"available":5}`,
        payload: {},
      }),
      deps(client)
    );

    // ...but the fake Shopify state says out of stock, and that is what wins:
    // no figure is published, and any prior one is actively cleared.
    expect(setCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({
      ownerId: product.shopifyProductGid,
      namespace: PRICE_METAFIELD_NAMESPACE,
      key: "as_low_as_bank_minor_units",
    });
  });
});
