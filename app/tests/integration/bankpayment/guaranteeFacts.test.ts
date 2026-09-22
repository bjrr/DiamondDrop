import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { gatherVariantPriceFacts } from "~/jobs/bankpayment/guaranteeFacts.server";

/**
 * `gatherVariantPriceFacts` in isolation — the historical `PriceOverride`
 * `kind` question the architect decided explicitly (D22 review, 2026-09-22):
 * `set` AND `revoke` both count as human-driven (human-initiated versus
 * system-initiated is the line, not "carries a price of its own"); `expired`
 * never does (the system retired it automatically — nobody decided
 * anything). The 24h-guarantee-boundary and unresolvable-price behaviour of
 * this function are already covered end to end by `guaranteeSweep.test.ts`;
 * this file isolates the override-kind question specifically.
 */

let sequence = 0;
const uniq = () => `${Date.now() % 900_000}-${(sequence += 1)}`;
const createdMasterProductIds: string[] = [];

afterEach(async () => {
  if (createdMasterProductIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { masterProductId: { in: createdMasterProductIds } },
    data: { status: "archived" },
  });
  createdMasterProductIds.length = 0;
});

async function aPublishedVariant() {
  const suffix = uniq();
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const product = await prisma.masterProduct.create({
    data: {
      name: `guarantee facts fixture ${suffix}`,
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
  createdMasterProductIds.push(product.id);
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
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `facts-${randomUUID()}` },
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

async function anOverride(input: {
  masterVariantId: string;
  priceCalculationId: string;
  kind: "set" | "revoke" | "expired";
  createdAt: Date;
}) {
  return prisma.priceOverride.create({
    data: {
      masterVariantId: input.masterVariantId,
      priceCalculationId: input.priceCalculationId,
      kind: input.kind,
      overrideBankPaymentPriceMinorUnits: input.kind === "set" ? 123_400n : null,
      currency: "USD",
      breachedFloors: [],
      warningShown: null,
      reason: "integration-test fixture",
      overriddenBy: "integration-test",
      createdAt: input.createdAt,
    },
  });
}

const HOUR_MS = 60 * 60 * 1000;

describe("humanDrivenOverrideSinceQuote — set and revoke count, expired does not", () => {
  it("a `set` override after quotedAt counts", async () => {
    const { variant, calc } = await aPublishedVariant();
    const quotedAt = new Date();
    await anOverride({
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      kind: "set",
      createdAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const facts = await gatherVariantPriceFacts(variant.id, quotedAt);
    expect(facts.humanDrivenOverrideSinceQuote).toBe(true);
  });

  it("a `revoke` override after quotedAt ALSO counts — a human deliberately reverting is still a human decision", async () => {
    const { variant, calc } = await aPublishedVariant();
    const quotedAt = new Date();
    await anOverride({
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      kind: "revoke",
      createdAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const facts = await gatherVariantPriceFacts(variant.id, quotedAt);
    expect(facts.humanDrivenOverrideSinceQuote).toBe(true);
  });

  it("an `expired` override after quotedAt does NOT count — the system retired it automatically, nobody decided anything", async () => {
    const { variant, calc } = await aPublishedVariant();
    const quotedAt = new Date();
    await anOverride({
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      kind: "expired",
      createdAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const facts = await gatherVariantPriceFacts(variant.id, quotedAt);
    expect(facts.humanDrivenOverrideSinceQuote).toBe(false);
  });

  it("a `set` override BEFORE quotedAt does not count — only what happened SINCE the quote is relevant", async () => {
    const { variant, calc } = await aPublishedVariant();
    const quotedAt = new Date();
    await anOverride({
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      kind: "set",
      createdAt: new Date(quotedAt.getTime() - HOUR_MS),
    });

    const facts = await gatherVariantPriceFacts(variant.id, quotedAt);
    expect(facts.humanDrivenOverrideSinceQuote).toBe(false);
  });

  it("no override at all does not count", async () => {
    const { variant } = await aPublishedVariant();
    const facts = await gatherVariantPriceFacts(variant.id, new Date());
    expect(facts.humanDrivenOverrideSinceQuote).toBe(false);
  });
});

describe("unresolvableEpisodeId / unresolvableEpisodeFirstFailedAt — the alert dedupe key", () => {
  it("is null while the variant's published price resolves normally", async () => {
    const { variant } = await aPublishedVariant();
    const facts = await gatherVariantPriceFacts(variant.id, new Date());
    expect(facts.publishedBankPaymentPriceMinorUnits).not.toBeNull();
    expect(facts.unresolvableEpisodeId).toBeNull();
    expect(facts.unresolvableEpisodeFirstFailedAt).toBeNull();
  });

  it("is the sync-failure episode's own id and firstFailedAt when withdrawn by a suspended sync failure", async () => {
    const { variant } = await aPublishedVariant();
    const firstFailedAt = new Date(Date.now() - 49 * HOUR_MS);
    const failure = await prisma.priceSyncFailure.create({
      data: {
        masterVariantId: variant.id,
        firstFailedAt,
        lastAttemptAt: new Date(),
        attemptCount: 12,
        lastError: "simulated Admin API failure",
        suspendedAt: new Date(),
      },
    });

    const facts = await gatherVariantPriceFacts(variant.id, new Date());
    expect(facts.publishedBankPaymentPriceMinorUnits).toBeNull();
    expect(facts.unresolvableEpisodeId).toBe(failure.id);
    expect(facts.unresolvableEpisodeFirstFailedAt).toEqual(firstFailedAt);
  });

  it("is the calculation-failure episode's own id when withdrawn by a suspended calculation failure", async () => {
    const { variant } = await aPublishedVariant();
    const firstFailedAt = new Date(Date.now() - 49 * HOUR_MS);
    const failure = await prisma.priceCalculationFailure.create({
      data: {
        masterVariantId: variant.id,
        firstFailedAt,
        lastAttemptAt: new Date(),
        attemptCount: 12,
        failureType: "unresolved_band",
        lastError: "simulated band resolution failure",
        suspendedAt: new Date(),
      },
    });

    const facts = await gatherVariantPriceFacts(variant.id, new Date());
    expect(facts.publishedBankPaymentPriceMinorUnits).toBeNull();
    expect(facts.unresolvableEpisodeId).toBe(failure.id);
    expect(facts.unresolvableEpisodeFirstFailedAt).toEqual(firstFailedAt);
  });

  it("prefers the calculation-failure episode when both are open — a price that cannot be COMPUTED is the more fundamental problem", async () => {
    const { variant } = await aPublishedVariant();
    const calcFailure = await prisma.priceCalculationFailure.create({
      data: {
        masterVariantId: variant.id,
        firstFailedAt: new Date(Date.now() - 49 * HOUR_MS),
        lastAttemptAt: new Date(),
        attemptCount: 12,
        failureType: "unresolved_band",
        lastError: "simulated band resolution failure",
        suspendedAt: new Date(),
      },
    });
    await prisma.priceSyncFailure.create({
      data: {
        masterVariantId: variant.id,
        firstFailedAt: new Date(Date.now() - 49 * HOUR_MS),
        lastAttemptAt: new Date(),
        attemptCount: 12,
        lastError: "simulated Admin API failure",
        suspendedAt: new Date(),
      },
    });

    const facts = await gatherVariantPriceFacts(variant.id, new Date());
    expect(facts.unresolvableEpisodeId).toBe(calcFailure.id);
  });

  it("a merely-retrying, NOT YET suspended episode does not make the price unresolvable (CLAUDE.md #16)", async () => {
    const { variant } = await aPublishedVariant();
    await prisma.priceSyncFailure.create({
      data: {
        masterVariantId: variant.id,
        firstFailedAt: new Date(),
        lastAttemptAt: new Date(),
        attemptCount: 1,
        lastError: "simulated Admin API failure",
        suspendedAt: null,
      },
    });

    const facts = await gatherVariantPriceFacts(variant.id, new Date());
    expect(facts.publishedBankPaymentPriceMinorUnits).not.toBeNull();
    expect(facts.unresolvableEpisodeId).toBeNull();
  });
});
