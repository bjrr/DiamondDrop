import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * Spec §16.8 headroom finding — `RunOptions.variantIds`.
 *
 * `runPriceRecalculation`'s unbounded `where: { status: "active" }` scan
 * grows with every fixture ANY integration file in the shared disposable
 * database creates (`tests/integration/globalSetup.ts`), and per-variant cost
 * resolves in ~18 sequential round trips (`resolveInputsForVariant`). This
 * file pins the scoped-run option that lets a caller — a future input-change
 * trigger in production, or a test fixture today — bound that cost to the
 * variants it actually cares about, WITHOUT changing what the unscoped path
 * does or what price either path computes.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

const ASOF = new Date("2026-06-02T00:00:00Z");

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
  const secondsIntoWindow = uniqueInt() % (27 * 24 * 60 * 60); // stays within May, ahead of ASOF's window
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

/** Same shape as autoPublishWiring.test.ts's priceableVariant(): global cost data only, no bands, no stones. */
async function priceableVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `scoped-run fixture ${suffix}`,
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
  return variant;
}

describe("RunOptions.variantIds — a scoped run processes only the named variants", () => {
  it("computes only the requested variant, leaving a sibling untouched by that run", async () => {
    await realisticProfile();
    const target = await priceableVariant();
    const sibling = await priceableVariant();

    const runId = randomUUID();
    const summary = await runPriceRecalculation({ asOf: ASOF, runId, variantIds: [target.id] });

    expect(summary.computed).toBe(1);

    const targetCalc = await prisma.priceCalculation.findFirst({
      where: { runId, masterVariantId: target.id },
    });
    expect(targetCalc).not.toBeNull();

    const siblingCalc = await prisma.priceCalculation.findFirst({
      where: { runId, masterVariantId: sibling.id },
    });
    expect(siblingCalc).toBeNull();
  });

  it("an unscoped call still reaches both variants — the default path is unchanged", async () => {
    await realisticProfile();
    const a = await priceableVariant();
    const b = await priceableVariant();

    const runId = randomUUID();
    await runPriceRecalculation({ asOf: ASOF, runId });

    const calcA = await prisma.priceCalculation.findFirst({ where: { runId, masterVariantId: a.id } });
    const calcB = await prisma.priceCalculation.findFirst({ where: { runId, masterVariantId: b.id } });
    expect(calcA).not.toBeNull();
    expect(calcB).not.toBeNull();
  });

  it("produces the IDENTICAL bank payment price a full scan would compute for the same variant", async () => {
    // The whole point of scoping is to change WHICH variants are visited, not
    // WHAT price a visited variant gets. Same profile, same asOf, same
    // variant, two runs — one scoped, one not — must compute the same figure.
    await realisticProfile();
    const variant = await priceableVariant();

    const scopedRun = randomUUID();
    await runPriceRecalculation({ asOf: ASOF, runId: scopedRun, variantIds: [variant.id] });
    const scopedCalc = await prisma.priceCalculation.findFirstOrThrow({
      where: { runId: scopedRun, masterVariantId: variant.id },
    });

    const fullRun = randomUUID();
    await runPriceRecalculation({ asOf: ASOF, runId: fullRun });
    const fullCalc = await prisma.priceCalculation.findFirstOrThrow({
      where: { runId: fullRun, masterVariantId: variant.id },
    });

    expect(scopedCalc.bankPaymentPriceMinorUnits).toBe(fullCalc.bankPaymentPriceMinorUnits);
    expect(scopedCalc.currency).toBe(fullCalc.currency);
  });

  it("an empty variantIds list computes nothing, rather than falling back to a full scan", async () => {
    await realisticProfile();
    const variant = await priceableVariant();

    const runId = randomUUID();
    const summary = await runPriceRecalculation({ asOf: ASOF, runId, variantIds: [] });

    expect(summary.computed).toBe(0);
    const calc = await prisma.priceCalculation.findFirst({ where: { runId, masterVariantId: variant.id } });
    expect(calc).toBeNull();
  });

  it("a scoped run still writes a normal, finished price_recalculation_run row", async () => {
    await realisticProfile();
    const variant = await priceableVariant();

    const runId = randomUUID();
    await runPriceRecalculation({ asOf: ASOF, runId, variantIds: [variant.id] });

    const run = await prisma.priceRecalculationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.finishedAt).not.toBeNull();
    expect(run.computed).toBe(1);
  });

  it("scoping does not bypass the Luxury Steal skip", async () => {
    await realisticProfile();
    const variant = await priceableVariant();
    await prisma.masterProduct.update({
      where: { id: variant.masterProductId },
      data: { isLuxurySteal: true },
    });

    const runId = randomUUID();
    const summary = await runPriceRecalculation({ asOf: ASOF, runId, variantIds: [variant.id] });

    expect(summary.skipped).toBe(1);
    expect(summary.computed).toBe(0);
    const calc = await prisma.priceCalculation.findFirst({ where: { runId, masterVariantId: variant.id } });
    expect(calc).toBeNull();
  });
});
