import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { getCalculationFailureStatus } from "~/db/repositories/priceCalculationFailureRepository.server";
import { isVariantCurrentlyWithdrawn as isSyncWithdrawn } from "~/db/repositories/priceSyncFailureRepository.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";
import { syncApprovedPriceSyncIntent } from "~/jobs/pricing/syncApprovedIntent.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";

/**
 * Slice 2 stage 2A (owner §7/§15). Proves the call sites added to
 * `runRecalculation.server.ts` and `syncApprovedIntent.server.ts` actually
 * reach `dispatchAdminAlert` — mirrors the precedent set by
 * `recalculationWiring.test.ts` and `syncFailureAndInputChangeWiring.test.ts`
 * for the failure state machines themselves: a wiring gap here would leave
 * `admin_alert_notification` fully built, tested and completely inert, which
 * is exactly the failure mode those two files exist to catch for their own
 * call sites.
 *
 * No `EMAIL_API_KEY`/`EMAIL_FROM`/`STAFF_EMAIL_ALLOWLIST` is set in the
 * integration environment (see `.env`), so every dispatch below is expected
 * to land on `skipped_unconfigured` — proving the ROW gets written (the
 * persistent-admin-alert half of owner §15) without requiring live email
 * credentials in CI.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);
const ASOF = new Date("2026-06-03T00:00:00Z");

const createdVariantIds: string[] = [];

afterEach(async () => {
  if (createdVariantIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { id: { in: createdVariantIds } },
    data: { status: "archived" },
  });
  createdVariantIds.length = 0;
});

function nextEffectiveFrom(): Date {
  const secondsIntoWindow = uniqueInt() % (26 * 24 * 60 * 60);
  return new Date(new Date("2026-05-01T00:00:00Z").getTime() + secondsIntoWindow * 1000);
}

async function realisticProfile() {
  return prisma.pricingProfile.create({
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
      effectiveFrom: nextEffectiveFrom(),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });
}

async function priceableVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `admin-alert-wiring fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${suffix}`,
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
      shopifyVariantGid: `gid://shopify/ProductVariant/${suffix}`,
    },
  });
  createdVariantIds.push(variant.id);
  return { product, variant };
}

/** Same data-integrity shape `recalculationWiring.test.ts` uses to force a deterministic BandResolutionError. */
async function bandFromAnotherProduct() {
  const suffix = randomUUID().slice(0, 8);
  const otherProduct = await prisma.masterProduct.create({
    data: {
      name: `unrelated band-owning product ${suffix}`,
      category: "ring",
      sizeAxis: "ring_size_us",
      allowedSizeMin: "4",
      allowedSizeMax: "9",
      sizeIncrement: "0.5",
      baseSize: "6",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
  return prisma.ringSizeBand.create({
    data: {
      masterProductId: otherProduct.id,
      label: "unrelated band",
      sizeMin: "4",
      sizeMax: "9",
      sortOrder: 1,
    },
  });
}

describe("owner §7 — calculation-failure admin-alert wiring", () => {
  it("opening an episode writes exactly one 'opened' admin_alert_notification, skipped_unconfigured", async () => {
    await realisticProfile();
    const { variant } = await priceableVariant();
    const wrongBand = await bandFromAnotherProduct();
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { bandId: wrongBand.id } });

    // Two runs: the wiring must notify on the FIRST (episode-opening) attempt
    // only, never again on the retry.
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });

    const status = await getCalculationFailureStatus(variant.id);
    expect(status).not.toBeNull();

    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "calculation_failure", sourceId: status!.failureId },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.event).toBe("opened");
    expect(notifications[0]!.emailDeliveryStatus).toBe("skipped_unconfigured");
    expect(notifications[0]!.emailDeliveryReason).toMatch(/EMAIL_API_KEY|EMAIL_FROM|STAFF_EMAIL_ALLOWLIST/);
    expect(notifications[0]!.masterVariantId).toBe(variant.id);
  });

  it("resolving the episode writes exactly one 'resolved' notification, distinct from 'opened'", async () => {
    await realisticProfile();
    const { variant } = await priceableVariant();
    const wrongBand = await bandFromAnotherProduct();
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { bandId: wrongBand.id } });

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    const failing = await getCalculationFailureStatus(variant.id);

    await prisma.masterVariant.update({ where: { id: variant.id }, data: { bandId: null } });
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });

    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "calculation_failure", sourceId: failing!.failureId },
      orderBy: { createdAt: "asc" },
    });
    expect(notifications.map((n) => n.event)).toEqual(["opened", "resolved"]);
  });
});

describe("owner §4/§15 — sync-failure admin-alert wiring", () => {
  class FailingPort implements ShopifyPriceSyncPort {
    async applyVariantPrice(): Promise<{ appliedAt: Date }> {
      throw new Error("Admin API rejected the write: Price must be greater than 0.");
    }
  }

  class SucceedingPort implements ShopifyPriceSyncPort {
    async applyVariantPrice(): Promise<{ appliedAt: Date }> {
      return { appliedAt: new Date("2026-09-19T12:00:00Z") };
    }
  }

  async function approvedIntentFixture() {
    await realisticProfile();
    const { variant } = await priceableVariant();

    const summary = await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    expect(summary.computed).toBe(1);

    const intent = await prisma.priceSyncIntent.findFirstOrThrow({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    // The recalculation run may leave the intent `pending_approval` (no
    // placeholder-profile clearance) — force it to `approved` directly,
    // this file's own concern is the sync call site, not the review gate.
    await prisma.priceSyncIntent.update({ where: { id: intent.id }, data: { status: "approved" } });

    return { variant, intentId: intent.id };
  }

  it("a failed sync writes an 'opened' notification, skipped_unconfigured", async () => {
    const { variant, intentId } = await approvedIntentFixture();

    await expect(
      syncApprovedPriceSyncIntent(intentId, { port: new FailingPort() })
    ).rejects.toThrow();

    const withdrawn = await isSyncWithdrawn(variant.id);
    expect(withdrawn).toBe(false); // one failure, nowhere near 48h

    const failureRow = await prisma.priceSyncFailure.findFirstOrThrow({
      where: { masterVariantId: variant.id },
    });
    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "sync_failure", sourceId: failureRow.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.event).toBe("opened");
    expect(notifications[0]!.emailDeliveryStatus).toBe("skipped_unconfigured");
  });

  it("a later successful sync writes a 'resolved' notification", async () => {
    const { variant, intentId } = await approvedIntentFixture();

    await expect(
      syncApprovedPriceSyncIntent(intentId, { port: new FailingPort() })
    ).rejects.toThrow();

    // Re-approve (the failed attempt left the intent in `syncing`) and
    // retry with a port that now succeeds.
    await prisma.priceSyncIntent.update({ where: { id: intentId }, data: { status: "approved" } });
    await syncApprovedPriceSyncIntent(intentId, { port: new SucceedingPort() });

    const failureRow = await prisma.priceSyncFailure.findFirstOrThrow({
      where: { masterVariantId: variant.id },
    });
    expect(failureRow.resolvedAt).not.toBeNull();

    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "sync_failure", sourceId: failureRow.id },
      orderBy: { createdAt: "asc" },
    });
    expect(notifications.map((n) => n.event)).toEqual(["opened", "resolved"]);
  });
});
