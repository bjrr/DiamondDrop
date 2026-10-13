import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { getGroupBuyCampaignTierPublishStatus } from "~/db/repositories/groupBuyRepository.server";
import { CampaignOpenTierPublishError, openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { ensureGroupBuyCampaignSyncedToCurrentTier } from "~/jobs/groupbuy/tierPriceSync.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { RecordingPriceSyncPort } from "~/jobs/pricing/ports";

/**
 * `getGroupBuyCampaignTierPublishStatus` (`groupBuyRepository.server.ts`) —
 * the read that makes the `app.group-buy-campaigns` admin surface's tier-
 * price-sync gap VISIBLE, and the resync action's own idempotent no-op
 * behaviour, exercised at the repository/job layer this admin route calls
 * into. See `app.group-buy-campaigns.$id.tsx`'s header comment ("TIER-PRICE-
 * SYNC RECOVERY") and `openCampaignTierPublish.test.ts` (which proves
 * `openGroupBuyCampaign`'s own publish-at-open behaviour) for the rest of the
 * story; this file adds only what neither already covers: the STATUS READ
 * itself, across every reachable state.
 *
 * DEDICATED, ALREADY-LINKED FIXTURES ONLY — never the shared `eligibleVariant()`
 * pattern other Group Buy integration files use, for the exact reason
 * `openCampaignTierPublish.test.ts`'s header comment gives: every file in
 * this directory shares one disposable database for the whole run
 * (`fileParallelism: false`), and mutating a shared fixture leaks into every
 * file that runs afterward.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

async function createLinkedPriceableVariant() {
  const product = await prisma.masterProduct.create({
    data: {
      name: `tier-publish-status fixture ${nextNumericId()}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/test-tier-publish-status-${nextNumericId()}`,
    },
  });
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      // HEAVY ON PURPOSE — see the identical comment in
      // openCampaignTierPublish.test.ts's own `createLinkedPriceableVariant`.
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${nextNumericId()}`,
      isLuxurySteal: true,
    },
  });

  return { variantId: variant.id };
}

async function draftCampaign(variantId: string) {
  return prisma.groupBuyCampaign.create({
    data: {
      code: `gb-tier-publish-status-${uniq()}`,
      name: "tier-publish-status fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [{ masterVariantId: variantId, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n }],
      },
    },
  });
}

const FAILING_PORT: ShopifyPriceSyncPort = {
  async applyVariantPrice() {
    throw new Error("simulated Shopify Admin API outage");
  },
};

describe("getGroupBuyCampaignTierPublishStatus", () => {
  it("returns null for a draft campaign — nothing is frozen yet to publish", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);

    expect(await getGroupBuyCampaignTierPublishStatus(draft.id)).toBeNull();
  });

  it("reports published: true once campaign open successfully publishes tier 1", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);
    const port = new RecordingPriceSyncPort();

    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => port });

    const status = await getGroupBuyCampaignTierPublishStatus(draft.id);
    expect(status).toMatchObject({ tierNumber: 1, published: true });
  });

  it("reports published: false — THE GAP — when campaign open commits but tier 1's publish fails", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);

    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => FAILING_PORT })
    ).rejects.toBeInstanceOf(CampaignOpenTierPublishError);

    // The campaign IS open (openGroupBuyCampaign does not roll back the
    // freeze) but its tier price never reached Shopify — exactly the state
    // this read exists to surface.
    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(opened.status).toBe("open");

    const status = await getGroupBuyCampaignTierPublishStatus(draft.id);
    expect(status).toMatchObject({ tierNumber: 1, published: false });
  });

  it("returns null for a closed campaign — frozen pricing stays exactly as it was, regardless of Shopify's last-known price", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);
    const port = new RecordingPriceSyncPort();

    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => port });

    // Force-close directly for this fixture's purposes — the unit ledger's
    // own close mechanics are exercised elsewhere (unitLedger.test.ts) and
    // are not what this test is about.
    await prisma.groupBuyCampaign.update({
      where: { id: draft.id },
      data: { status: "closed", closedAt: new Date(), finalTierNumber: 1, finalQualifyingUnits: 0 },
    });

    expect(await getGroupBuyCampaignTierPublishStatus(draft.id)).toBeNull();
  });
});

describe("resync recovery — the admin action's underlying call", () => {
  it("is a no-op and makes no second Shopify call when the campaign's tier is already fully published (a healthy campaign)", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);
    const openPort = new RecordingPriceSyncPort();

    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => openPort });
    expect(openPort.calls).toHaveLength(1);

    const resyncPort = new RecordingPriceSyncPort();
    const result = await ensureGroupBuyCampaignSyncedToCurrentTier(draft.id, { resolveSyncPort: async () => resyncPort });

    expect(result).toMatchObject({ tierNumber: 1, skipped: true, syncedVariantCount: 0 });
    expect(resyncPort.calls).toHaveLength(0);
    expect(await getGroupBuyCampaignTierPublishStatus(draft.id)).toMatchObject({ tierNumber: 1, published: true });
  });

  it("publishes when invoked against a campaign whose tier price never reached Shopify — recovering the gap", async () => {
    const { variantId } = await createLinkedPriceableVariant();
    const draft = await draftCampaign(variantId);

    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF, resolveSyncPort: async () => FAILING_PORT })
    ).rejects.toBeInstanceOf(CampaignOpenTierPublishError);
    expect(await getGroupBuyCampaignTierPublishStatus(draft.id)).toMatchObject({ tierNumber: 1, published: false });

    const recoveryPort = new RecordingPriceSyncPort();
    const result = await ensureGroupBuyCampaignSyncedToCurrentTier(draft.id, { resolveSyncPort: async () => recoveryPort });

    expect(result).toMatchObject({ tierNumber: 1, skipped: false, syncedVariantCount: 1, unresolvedVariantCount: 0 });
    expect(recoveryPort.calls).toHaveLength(1);
    expect(await getGroupBuyCampaignTierPublishStatus(draft.id)).toMatchObject({ tierNumber: 1, published: true });
  });
});
