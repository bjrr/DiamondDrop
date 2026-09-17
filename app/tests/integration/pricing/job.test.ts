import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";
import { verifyPriceCalculation } from "~/jobs/pricing/verify.server";

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

/**
 * CRITERIA 19, 25, 26, 29 — the recalculation run end to end (spec §9.2-§9.6).
 *
 * The SEEDED profile is a deliberate placeholder with a 99.99% target margin
 * (D14 unresolved), which makes every price unsolvable — correctly. These
 * tests therefore build their own realistic profile so the job's behaviour can
 * actually be exercised. That profile is test data and does not invent D14 for
 * production: the seeded placeholder stays exactly as it is.
 */

const ASOF = new Date("2026-06-01T00:00:00Z");

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
      cardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      cardUpliftRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 50,
      // Later than the seeded placeholder, so it is the one that resolves.
      effectiveFrom: new Date("2026-05-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });
}

describe("criterion 25/26 — the run", () => {
  it("computes prices, records skips with a reason, and never aborts on one failure", async () => {
    await realisticProfile();

    const luxury = await prisma.masterProduct.create({
      data: {
        name: `luxury steal ${randomUUID().slice(0, 6)}`,
        category: "ring",
        sizeAxis: "none",
        allowedSizeMin: "0",
        allowedSizeMax: "0",
        sizeIncrement: "1",
        baseSize: "0",
        offeredMetals: ["gold"],
        isLuxurySteal: true,
        status: "active",
      },
    });
    const luxuryVariant = await prisma.masterVariant.create({
      data: {
        masterProductId: luxury.id,
        metal: "gold",
        purity: "GOLD_14K",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
      },
    });

    const summary = await runPriceRecalculation({ asOf: ASOF });

    // Luxury Steals are fixed-price and must never be re-priced by this job.
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    const luxuryCalc = await prisma.priceCalculation.findFirst({
      where: { masterVariantId: luxuryVariant.id },
    });
    expect(luxuryCalc).toBeNull();

    // The seeded ring variants price successfully against a realistic profile.
    expect(summary.computed).toBeGreaterThan(0);

    // A first-ever price is ALWAYS needs_approval (§9.3).
    expect(summary.needsApproval).toBeGreaterThan(0);
  });

  it("criterion 23 — a second run with the same runId is a no-op", async () => {
    await realisticProfile();
    const runId = randomUUID();

    const first = await runPriceRecalculation({ runId, asOf: ASOF });
    const countAfterFirst = await prisma.priceCalculation.count({ where: { runId } });

    const second = await runPriceRecalculation({ runId, asOf: ASOF });
    const countAfterSecond = await prisma.priceCalculation.count({ where: { runId } });

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(second.computed).toBe(first.computed);
  });

  it("criterion 24 — a newer run supersedes a prior open intent with an audit event", async () => {
    await realisticProfile();

    await runPriceRecalculation({ asOf: ASOF });
    const open = await prisma.priceSyncIntent.findFirst({
      where: { status: "pending_approval" },
      orderBy: { createdAt: "desc" },
    });
    expect(open).not.toBeNull();

    await runPriceRecalculation({ asOf: ASOF });

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: open!.id } });
    expect(after?.status).toBe("superseded");

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: open!.id, action: "price_sync_intent.superseded" },
    });
    // An intent a human was asked to review must not vanish without a record.
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});

describe("criterion 19 — reproducibility", () => {
  it("reproduces a stored calculation exactly from its snapshot", async () => {
    await realisticProfile();
    await runPriceRecalculation({ asOf: ASOF });

    const calc = await prisma.priceCalculation.findFirst({
      where: { status: "computed" },
      orderBy: { createdAt: "desc" },
    });
    expect(calc).not.toBeNull();

    const outcome = await verifyPriceCalculation(calc!.id);
    // Reproduction needs no repository: the snapshot carries every input.
    expect(outcome.status).toBe("reproduced");
  });

  it("reports NOT_FOUND rather than throwing for an unknown id", async () => {
    const outcome = await verifyPriceCalculation(randomUUID());
    expect(outcome.status).toBe("not_found");
  });
});

describe("criterion 29 — the slice 2 scope fence", () => {
  it("the production sync port throws rather than silently doing nothing", async () => {
    const { UnimplementedPriceSyncPort, PriceSyncNotImplementedError } = await import(
      "~/jobs/pricing/ports"
    );
    const port = new UnimplementedPriceSyncPort();
    // A silent no-op would let intents reach `synced` and have the audit trail
    // claim a price reached Shopify when none did.
    await expect(
      port.applyVariantPrice()
    ).rejects.toBeInstanceOf(PriceSyncNotImplementedError);
  });
});
