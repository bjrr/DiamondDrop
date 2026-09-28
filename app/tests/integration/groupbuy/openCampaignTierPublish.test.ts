import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import { CampaignOpenTierPublishError, openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { RecordingPriceSyncPort } from "~/jobs/pricing/ports";
import { handleGroupBuyOrderCreateWebhook } from "~/shopify/webhooks/groupBuyOrderHandler.server";

/**
 * Publishing tier 1 at campaign OPEN — the second half of the gap the
 * architect found: `openGroupBuyCampaign` froze pricing in Postgres but
 * never told Shopify, so a campaign with no orders yet could keep showing
 * its pre-campaign (possibly lower, possibly UNDER tier-1) price for its
 * entire life. See `openCampaign.server.ts`'s `CampaignOpenTierPublishError`
 * doc comment for why this is a real safety gap, not merely a cosmetic one:
 * `docs/ARCHITECTURE-MVP1.md` §6.1's "a stale cart can only hold a HIGHER
 * price" argument is only true once the published price actually starts at
 * tier 1.
 *
 * `tests/integration/groupbuy/openCampaign.test.ts`,
 * `tests/integration/groupbuy/unitLedger.test.ts`, and friends all call
 * `openGroupBuyCampaign` without a `resolveSyncPort` and their fixture
 * variants carry no Shopify ids at all — proving here, explicitly, that
 * this is the COMMON case and stays a normal, non-throwing open (test
 * "opens with zero linked variants...") is what keeps all of them green
 * after this change, and is worth pinning as its own regression test rather
 * than trusting that the other files merely happen to still pass.
 *
 * EVERY "LINKED" TEST BELOW USES ITS OWN FRESH PRODUCT/VARIANT, CREATED with
 * Shopify ids already set, rather than reusing and then mutating the shared
 * "heaviest active variant" `eligibleVariant()` below (and every OTHER Group
 * Buy integration test file) resolves. An earlier version of this file
 * called that shared helper and then UPDATEd it in place to add Shopify ids
 * — and because every file in this directory shares one disposable database
 * for the whole run (`vitest.integration.config.ts`'s `fileParallelism:
 * false`), that mutation leaked into every test file that ran afterward,
 * making `refundLedger.test.ts` and `groupBuyRepository.test.ts` find an
 * unexpectedly-linked variant and attempt genuine Shopify Admin API calls
 * they had never made before. `eligibleVariant()` here is therefore used
 * ONLY by the "zero linked variants" test, and is never written to.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

/** Read-only. See the module doc comment for why nothing below ever writes to what this returns. */
async function eligibleVariant() {
  return prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });
}

/**
 * A DEDICATED, FRESH, ALREADY-LINKED product/variant. `metal: gold` /
 * `purity: GOLD_14K` / `laborSource: india` match several real seeded
 * variants (prisma/seed.ts), so `resolveInputsForVariant` resolves metal
 * price, labor rate and every required cost component from the same global
 * seed rows those variants do. `sizeAxis: "none"` needs no bands
 * (`app/domain/pricing/weight.ts` returns immediately for it).
 */
async function createLinkedPriceableVariant() {
  const product = await prisma.masterProduct.create({
    data: {
      name: `open-publish priceable fixture ${nextNumericId()}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/test-open-publish-${nextNumericId()}`,
    },
  });
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      // HEAVY ON PURPOSE — see the identical comment in
      // orderCreateWebhook.test.ts's `createPriceableVariant`. A light
      // fixture clears the tier-safety floor at tier 1 but not at the
      // discounted deeper tiers this file's own campaigns use.
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${nextNumericId()}`,
      // EXCLUDED from every other file's shared "heaviest active,
      // non-Luxury-Steal" fixture query — see the identical comment in
      // `orderCreateWebhook.test.ts`'s `createPriceableVariant` for why a
      // 50g variant must not be selectable by unrelated files' `eligibleVariant()`.
      isLuxurySteal: true,
    },
  });

  return { variantId: variant.id, shopifyVariantGid: variant.shopifyVariantGid!, shopifyProductGid: product.shopifyProductGid! };
}

async function draftCampaign(variantId: string) {
  return prisma.groupBuyCampaign.create({
    data: {
      code: `gb-open-publish-${uniq()}`,
      name: "open-publish fixture",
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
}

describe("publishing tier 1 at open", () => {
  it("publishes every linked eligible variant's tier-1 price as part of open, exactly once", async () => {
    const { variantId, shopifyVariantGid, shopifyProductGid } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);
    const port = new RecordingPriceSyncPort();

    const result = await openGroupBuyCampaign({
      campaignId: draft.id,
      openedBy: "staff",
      asOf: ASOF,
      resolveSyncPort: async () => port,
    });

    expect(result.tierOnePublish).toMatchObject({ tierNumber: 1, syncedVariantCount: 1, skipped: false, unresolvedVariantCount: 0 });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ shopifyProductGid, shopifyVariantGid });

    const marker = (await listAuditEventsForEntity("group_buy_campaign", draft.id)).find(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(marker).toMatchObject({ after: { tierNumber: 1 } });
  });

  it("opens successfully with zero linked variants — no publish attempted, nothing thrown (the shape every other Group Buy fixture in this suite already uses)", async () => {
    const variant = await eligibleVariant(); // deliberately NOT linked, and never mutated
    const draft = await draftCampaign(variant.id);

    const result = await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    expect(result.tierOnePublish).toMatchObject({ tierNumber: 1, syncedVariantCount: 0, unresolvedVariantCount: 1 });
    // No completion marker either — a later link + order should still try.
    const marker = (await listAuditEventsForEntity("group_buy_campaign", draft.id)).find(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(marker).toBeUndefined();

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(opened.status).toBe("open");
  });

  it("does NOT republish tier 1 when the immediate first order does not change the tier (the idempotency the marker exists for)", async () => {
    const { variantId, shopifyVariantGid } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);
    const port = new RecordingPriceSyncPort();

    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => port });
    expect(port.calls).toHaveLength(1);

    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = `{"id":${nextNumericId()},"line_items":[{"id":"1","admin_graphql_api_id":"gid://shopify/LineItem/1","variant_id":${numericVariantId},"quantity":2}]}`;

    await handleGroupBuyOrderCreateWebhook(
      {
        shopifyEventId: `evt-${uniq()}`,
        topic: "orders/create",
        shopDomain: "caratforus-dev.myshopify.com",
        rawBody,
        payload: JSON.parse(rawBody) as unknown,
      },
      { resolveSyncPort: async () => port }
    );

    // Still tier 1 (2 units, threshold for tier 2 is 5) and tier 1 was
    // already fully published at open — no second call.
    expect(port.calls).toHaveLength(1);
  });

  it("throws CampaignOpenTierPublishError when a LINKED variant's publish genuinely fails, but the campaign is still open in the database", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);

    const failingPort: ShopifyPriceSyncPort = {
      async applyVariantPrice() {
        throw new Error("simulated Shopify Admin API outage");
      },
    };

    await expect(
      openGroupBuyCampaign({
        campaignId: draft.id,
        openedBy: "staff",
        asOf: ASOF,
        resolveSyncPort: async () => failingPort,
      })
    ).rejects.toBeInstanceOf(CampaignOpenTierPublishError);

    // THE FREEZE STILL COMMITTED. Rolling it back over a transient publish
    // failure would discard a legitimate, already safety-checked freeze —
    // see the error class's own doc comment for the full reasoning.
    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(opened.status).toBe("open");

    const marker = (await listAuditEventsForEntity("group_buy_campaign", draft.id)).find(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(marker).toBeUndefined();
  });

  it("recovers from a failed open-time publish via the very next order, with no manual re-open", async () => {
    const { variantId, shopifyVariantGid } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);

    const failingPort: ShopifyPriceSyncPort = {
      async applyVariantPrice() {
        throw new Error("simulated Shopify Admin API outage");
      },
    };
    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => failingPort })
    ).rejects.toBeInstanceOf(CampaignOpenTierPublishError);

    const recordingPort = new RecordingPriceSyncPort();
    const numericVariantId = shopifyVariantGid.split("/").pop();
    const rawBody = `{"id":${nextNumericId()},"line_items":[{"id":"1","admin_graphql_api_id":"gid://shopify/LineItem/1","variant_id":${numericVariantId},"quantity":1}]}`;

    await handleGroupBuyOrderCreateWebhook(
      {
        shopifyEventId: `evt-${uniq()}`,
        topic: "orders/create",
        shopDomain: "caratforus-dev.myshopify.com",
        rawBody,
        payload: JSON.parse(rawBody) as unknown,
      },
      { resolveSyncPort: async () => recordingPort }
    );

    expect(recordingPort.calls).toHaveLength(1);
    const marker = (await listAuditEventsForEntity("group_buy_campaign", draft.id)).find(
      (e) => e.action === "groupbuy.tier_price_synced"
    );
    expect(marker).toMatchObject({ after: { tierNumber: 1 } });
  });
});
