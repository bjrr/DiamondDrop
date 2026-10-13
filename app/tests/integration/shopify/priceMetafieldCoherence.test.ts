import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { checkPriceMetafieldCoherence } from "~/shopify/metafields/priceMetafieldCoherence.server";

/**
 * Stage 2B entry condition C5 / spec §16.2 criterion 56 — the server-side
 * coherence check the theme's staleness detection depends on.
 *
 * No `EMAIL_API_KEY`/`EMAIL_FROM`/`STAFF_EMAIL_ALLOWLIST` is set in the
 * integration environment (see `.env`), so every dispatch below lands on
 * `skipped_unconfigured` — same expectation `adminAlertWiring.test.ts`
 * documents for the sync-failure alert path this reuses.
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

async function makeSyncedVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `metafield-coherence fixture ${suffix}`,
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
    data: { kind: "pricing.it", payload: {}, contentHash: `metafield-coherence-${suffix}` },
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

  return { variant, calc };
}

describe("a metafield naming the published calculation is coherent, no alert raised", () => {
  it("returns coherent: true and creates no price_sync_failure row", async () => {
    const { variant, calc } = await makeSyncedVariant();

    const result = await checkPriceMetafieldCoherence({
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
    });

    expect(result).toEqual({
      coherent: true,
      embeddedPriceCalculationId: calc.id,
      publishedPriceCalculationId: calc.id,
      masterVariantId: variant.id,
    });

    const failure = await prisma.priceSyncFailure.findFirst({ where: { masterVariantId: variant.id } });
    expect(failure).toBeNull();
  });
});

describe("a metafield naming a different calculation is incoherent, and raises the sync-failure alert", () => {
  it("records a price_sync_failure episode and an 'opened' admin_alert_notification, reusing sync_failure", async () => {
    const { variant } = await makeSyncedVariant();
    const staleCalculationId = randomUUID();

    const result = await checkPriceMetafieldCoherence({
      masterVariantId: variant.id,
      priceCalculationId: staleCalculationId,
    });

    expect(result.coherent).toBe(false);
    expect(result.embeddedPriceCalculationId).toBe(staleCalculationId);

    const failure = await prisma.priceSyncFailure.findFirstOrThrow({ where: { masterVariantId: variant.id } });
    expect(failure.lastError).toContain(staleCalculationId);
    expect(failure.resolvedAt).toBeNull();

    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "sync_failure", sourceId: failure.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.event).toBe("opened");
    expect(notifications[0]!.emailDeliveryStatus).toBe("skipped_unconfigured");
    expect(notifications[0]!.masterVariantId).toBe(variant.id);
  });

  it("is incoherent — never a crash — when the variant has no published calculation at all", async () => {
    const suffix = randomUUID().slice(0, 8);
    const product = await prisma.masterProduct.create({
      data: {
        name: `metafield-coherence unsynced fixture ${suffix}`,
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
      },
    });
    createdVariantIds.push(variant.id);

    const result = await checkPriceMetafieldCoherence({
      masterVariantId: variant.id,
      priceCalculationId: randomUUID(),
    });

    expect(result.coherent).toBe(false);
    expect(result.publishedPriceCalculationId).toBeNull();

    const failure = await prisma.priceSyncFailure.findFirstOrThrow({ where: { masterVariantId: variant.id } });
    expect(failure.lastError).toContain("none (never synced)");
  });

  it("does not create a second episode or a second 'opened' notification on a repeated mismatch check", async () => {
    const { variant } = await makeSyncedVariant();
    const staleCalculationId = randomUUID();

    await checkPriceMetafieldCoherence({ masterVariantId: variant.id, priceCalculationId: staleCalculationId });
    await checkPriceMetafieldCoherence({ masterVariantId: variant.id, priceCalculationId: staleCalculationId });

    const failures = await prisma.priceSyncFailure.findMany({ where: { masterVariantId: variant.id } });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.attemptCount).toBe(2);

    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "sync_failure", sourceId: failures[0]!.id },
    });
    expect(notifications).toHaveLength(1); // "opened" only — no spam on retry (criterion 64's own rule, reused here)
  });
});
