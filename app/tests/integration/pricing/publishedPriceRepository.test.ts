import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  MasterVariantNotFoundError,
  getPublishedVariantPrice,
} from "~/db/repositories/publishedPriceRepository.server";

/**
 * Stage 2B entry condition C1 / spec §16.2 criterion 52 — the resolver every
 * customer-facing surface must read through.
 *
 * The one test the team lead required explicitly: compute a NEW calculation
 * at a visibly different price, leave it unsynced, and assert the resolver
 * still returns the PREVIOUSLY published trio — and that the saving still
 * equals published card minus published bank, not a mix of the two
 * calculations. See "criterion 52's required test" below.
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

interface ProfileOptions {
  regularCardPriceRuleId?: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1" | "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1";
  fixedCardUpliftRate?: string;
}

async function makeProfile(opts: ProfileOptions = {}) {
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
      regularCardPriceRuleId: opts.regularCardPriceRuleId ?? "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: opts.fixedCardUpliftRate ?? "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 200,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });
}

async function makeVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `published-price fixture ${suffix}`,
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

async function makeCalculation(
  variantId: string,
  profileId: string,
  profileVersion: number,
  bankPaymentPriceMinorUnits: bigint
) {
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `published-price-${randomUUID()}` },
  });
  return prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: variantId,
      pricingProfileId: profileId,
      profileVersion,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snapshot.id,
      landedCostMinorUnits: 1000n,
      bankPaymentPriceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
}

describe("a variant with no synced calculation is never purchasable", () => {
  it("returns not_purchasable when lastSyncedPriceCalculationId is null, even with a computed calculation present", async () => {
    const { variant } = await makeVariant();
    const profile = await makeProfile();
    await makeCalculation(variant.id, profile.id, profile.version, 100_000n);

    const result = await getPublishedVariantPrice(variant.id);

    expect(result).toEqual({ kind: "not_purchasable", masterVariantId: variant.id, reason: "unsynced" });
  });

  it("throws MasterVariantNotFoundError for an unknown variant id, rather than reporting not_purchasable", async () => {
    await expect(getPublishedVariantPrice(randomUUID())).rejects.toBeInstanceOf(MasterVariantNotFoundError);
  });
});

describe("a synced variant returns the published trio, derived from the synced calculation", () => {
  it("returns bank price, card price and saving all traceable to the synced calculation", async () => {
    const { variant } = await makeVariant();
    const profile = await makeProfile();
    const calc = await makeCalculation(variant.id, profile.id, profile.version, 100_000n); // $1,000.00 -> 4.0% tier
    await prisma.masterVariant.update({
      where: { id: variant.id },
      data: { lastSyncedPriceCalculationId: calc.id },
    });

    const result = await getPublishedVariantPrice(variant.id);

    expect(result.kind).toBe("purchasable");
    if (result.kind !== "purchasable") throw new Error("unreachable");
    expect(result.price.priceCalculationId).toBe(calc.id);
    expect(result.price.bankPaymentPriceMinorUnits).toBe(100_000n);
    expect(result.price.regularCardPriceMinorUnits).toBe(104_000n); // $1,040.00 (4.0% tier, exact $5 multiple)
    expect(result.price.bankPaymentSavingsMinorUnits).toBe(4_000n);
    expect(result.price.currency).toBe("USD");
    // The internal-only fields exist for audit/admin, but must never be
    // presented as though they were part of the customer-facing trio.
    expect(result.price.appliedTierLabel).toBe("$1,000–$2,499.99");
  });
});

describe("criterion 52's required test — the resolver reads the PUBLISHED calculation, not the newest one", () => {
  it("leaves a newer, unsynced calculation at a visibly different price without effect", async () => {
    const { variant } = await makeVariant();
    const profile = await makeProfile();

    const published = await makeCalculation(variant.id, profile.id, profile.version, 100_000n); // $1,000.00
    await prisma.masterVariant.update({
      where: { id: variant.id },
      data: { lastSyncedPriceCalculationId: published.id },
    });

    const publishedBefore = await getPublishedVariantPrice(variant.id);
    expect(publishedBefore.kind).toBe("purchasable");
    if (publishedBefore.kind !== "purchasable") throw new Error("unreachable");

    // A NEW calculation, computed afterward, at a VISIBLY DIFFERENT price —
    // and deliberately left unsynced (no write to lastSyncedPriceCalculationId).
    await makeCalculation(variant.id, profile.id, profile.version, 999_000n); // $9,990.00

    const publishedAfter = await getPublishedVariantPrice(variant.id);

    expect(publishedAfter.kind).toBe("purchasable");
    if (publishedAfter.kind !== "purchasable") throw new Error("unreachable");
    // Still the ORIGINAL published calculation, not the newer unsynced one.
    expect(publishedAfter.price.priceCalculationId).toBe(published.id);
    expect(publishedAfter.price).toEqual(publishedBefore.price);

    // Guard the guard: prove this isn't a coincidental match by confirming
    // the newer calculation's price is nowhere close to what was returned.
    expect(publishedAfter.price.bankPaymentPriceMinorUnits).not.toBe(999_000n);

    // The saving equals published card minus published bank — not a mix
    // with the newer, unsynced calculation's figures.
    expect(publishedAfter.price.bankPaymentSavingsMinorUnits).toBe(
      publishedAfter.price.regularCardPriceMinorUnits - publishedAfter.price.bankPaymentPriceMinorUnits
    );
  });
});

describe("the published card price is derived from the SYNCED calculation's own profile, never today's active one", () => {
  it("keeps publishing the legacy whole-dollar figure after a newer profile with the tiered rule becomes active", async () => {
    const { variant } = await makeVariant();
    const legacyProfile = await makeProfile({
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      fixedCardUpliftRate: "0.050000",
    });
    // bank = $1,000.00, legacy rule: ceil_to_whole_dollar(bank * 1.05) = $1,050.00.
    const calc = await makeCalculation(variant.id, legacyProfile.id, legacyProfile.version, 100_000n);
    await prisma.masterVariant.update({
      where: { id: variant.id },
      data: { lastSyncedPriceCalculationId: calc.id },
    });

    // A newer, unrelated profile becomes "active" — the tiered rule would
    // apply a 4.0% rate at this bank price and ceiling to the next $5,
    // producing a DIFFERENT figure ($1,040.00) if the resolver ever
    // consulted it instead of the synced calculation's own profile.
    await makeProfile({ regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1" });

    const result = await getPublishedVariantPrice(variant.id);

    expect(result.kind).toBe("purchasable");
    if (result.kind !== "purchasable") throw new Error("unreachable");
    expect(result.price.regularCardPriceMinorUnits).toBe(105_000n);
    expect(result.price.regularCardPriceMinorUnits).not.toBe(104_000n);
  });
});
