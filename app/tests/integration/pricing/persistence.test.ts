import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";

/**
 * Unique-but-collision-free identifiers for fixtures.
 *
 * Deliberately avoids Math.floor/Math.random: the money-safety scan bans
 * ad-hoc rounding REPOSITORY-WIDE including test files, precisely so a test
 * cannot normalise a value in a way production would not. A monotonic
 * millisecond base plus a sequence gives uniqueness across runs and within a
 * run without any rounding at all.
 */
let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);
const uniqueDate = (): Date => new Date(Date.UTC(2030, 0, 1) + uniqueInt() * 86_400_000);

/**
 * CRITERIA 22, 23, 24 — pricing persistence guarantees, enforced by the
 * database rather than by application convention (spec §7.2, §9.4).
 *
 * These assert the constraints that make the recalculation job idempotent.
 * Without them, a retried run creates duplicate calculations and competing
 * approval requests for the same variant.
 */

/** Minimal graph needed to hang a price_calculation off. */
async function fixture() {
  const suffix = randomUUID().slice(0, 8);

  const product = await prisma.masterProduct.create({
    data: {
      name: `IT fixture ${suffix}`,
      category: "ring",
      sizeAxis: "ring_size_us",
      allowedSizeMin: "2",
      allowedSizeMax: "11",
      sizeIncrement: "0.5",
      baseSize: "6",
      offeredMetals: ["gold"],
      status: "active",
    },
  });

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: "active",
    },
  });

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
      cashPriceRuleId: "CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1",
      cashDiscountRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 50,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });

  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: { fixture: suffix }, contentHash: `it-${suffix}` },
  });

  return { product, variant, profile, snapshot };
}

async function calculation(
  ids: Awaited<ReturnType<typeof fixture>>,
  runId: string,
  priceMinorUnits: bigint
) {
  return prisma.priceCalculation.create({
    data: {
      runId,
      masterVariantId: ids.variant.id,
      pricingProfileId: ids.profile.id,
      profileVersion: ids.profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date("2026-06-01T00:00:00Z"),
      snapshotId: ids.snapshot.id,
      landedCostMinorUnits: 75365n,
      computedPriceMinorUnits: priceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
}

describe("criterion 22 — price_calculation is append-only at the database level", () => {
  it("rejects UPDATE", async () => {
    const ids = await fixture();
    const calc = await calculation(ids, randomUUID(), 136833n);
    await expect(
      prisma.priceCalculation.update({
        where: { id: calc.id },
        data: { computedPriceMinorUnits: 1n },
      })
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects DELETE", async () => {
    const ids = await fixture();
    const calc = await calculation(ids, randomUUID(), 136833n);
    await expect(prisma.priceCalculation.delete({ where: { id: calc.id } })).rejects.toThrow(
      /append-only/i
    );
  });
});

describe("criterion 23 — a re-run with the same runId creates no duplicate", () => {
  it("rejects a second calculation for the same (runId, masterVariantId)", async () => {
    const ids = await fixture();
    const runId = randomUUID();
    await calculation(ids, runId, 136833n);

    // This is the whole idempotency mechanism: a retried run cannot double-write.
    await expect(calculation(ids, runId, 999999n)).rejects.toThrow();
  });

  it("allows the same variant in a DIFFERENT run", async () => {
    const ids = await fixture();
    await calculation(ids, randomUUID(), 136833n);
    const second = await calculation(ids, randomUUID(), 137000n);
    expect(second.computedPriceMinorUnits).toBe(137000n);
  });
});

describe("criterion 24 — at most one non-terminal sync intent per variant", () => {
  let ids: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    ids = await fixture();
  });

  it("rejects a second open intent for the same variant", async () => {
    const calc = await calculation(ids, randomUUID(), 136833n);
    await prisma.priceSyncIntent.create({
      data: {
        masterVariantId: ids.variant.id,
        priceCalculationId: calc.id,
        decision: "needs_approval",
        status: "pending_approval",
        attemptCount: 0,
      },
    });

    const calc2 = await calculation(ids, randomUUID(), 137000n);
    await expect(
      prisma.priceSyncIntent.create({
        data: {
          masterVariantId: ids.variant.id,
          priceCalculationId: calc2.id,
          decision: "needs_approval",
          status: "pending_approval",
          attemptCount: 0,
        },
      })
    ).rejects.toThrow();
  });

  it("allows a new intent once the previous one reaches a terminal status", async () => {
    // Supersede the open intent, which is what a newer run does.
    const open = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: ids.variant.id, status: "pending_approval" },
    });
    expect(open).not.toBeNull();
    await prisma.priceSyncIntent.update({
      where: { id: open!.id },
      data: { status: "superseded" },
    });

    const calc = await calculation(ids, randomUUID(), 138000n);
    const next = await prisma.priceSyncIntent.create({
      data: {
        masterVariantId: ids.variant.id,
        priceCalculationId: calc.id,
        decision: "needs_approval",
        status: "pending_approval",
        attemptCount: 0,
      },
    });
    expect(next.status).toBe("pending_approval");
  });

  it("price_sync_intent is mutable — it is the workflow, not evidence", async () => {
    const open = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: ids.variant.id, status: "pending_approval" },
    });
    const updated = await prisma.priceSyncIntent.update({
      where: { id: open!.id },
      data: { status: "approved", decidedBy: "staff-1", decidedAt: new Date() },
    });
    expect(updated.status).toBe("approved");
  });
});

describe("L1 cost inputs are append-only", () => {
  it("rejects an UPDATE to a metal_price row", async () => {
    const row = await prisma.metalPrice.create({
      data: {
        metal: "gold",
        purity: "GOLD_18K",
        pricePerGram: "60.000000",
        currency: "USD",
        effectiveFrom: uniqueDate(),
        source: "manual",
        enteredBy: "integration-test",
      },
    });
    await expect(
      prisma.metalPrice.update({ where: { id: row.id }, data: { pricePerGram: "1.000000" } })
    ).rejects.toThrow(/append-only/i);
  });
});
