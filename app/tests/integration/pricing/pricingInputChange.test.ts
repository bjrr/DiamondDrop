import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  PricingInputChangeEntityRequiredError,
  recordPricingInputChange,
  recordPricingInputChangeIfPriceAffecting,
  resolveIntentsForPricingInputChange,
  resolvePendingIntentsForPricingInputChange,
} from "~/db/repositories/pricingInputChangeRepository.server";

/**
 * Owner §3.1; spec criteria 17-19, 58, 11 (bulk approval); §16.5 R5, closed
 * by T5's audit — every covered table maps 1:1 to a
 * `PricingInputChangeKind`.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

async function fixture() {
  const suffix = randomUUID().slice(0, 8);

  const product = await prisma.masterProduct.create({
    data: {
      name: `pricing-input-change fixture ${suffix}`,
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
      laborSource: "india",
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
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      fixedCardUpliftRate: "0.050000",
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
      bankPaymentPriceMinorUnits: priceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
}

async function intent(
  ids: Awaited<ReturnType<typeof fixture>>,
  priceCalculationId: string,
  status: "pending_approval" | "approved" | "synced" = "pending_approval"
) {
  return prisma.priceSyncIntent.create({
    data: {
      masterVariantId: ids.variant.id,
      priceCalculationId,
      decision: "needs_approval",
      status,
      attemptCount: 0,
    },
  });
}

const T0 = new Date("2026-09-19T00:00:00.000Z");

describe("recordPricingInputChange", () => {
  it("writes a row naming the entity for a non-manual kind", async () => {
    const row = await recordPricingInputChange({
      kind: "metal_reference_price",
      entityId: randomUUID(),
      changedBy: "staff:brian",
      changedAt: T0,
    });

    expect(row.kind).toBe("metal_reference_price");
    expect(row.changedBy).toBe("staff:brian");
    expect(row.changedAt).toEqual(T0);
  });

  it("requires an entityId for a non-manual kind", async () => {
    await expect(
      recordPricingInputChange({ kind: "cost_component", changedAt: T0 })
    ).rejects.toThrow(PricingInputChangeEntityRequiredError);
  });

  it("allows a manual kind with no entityId", async () => {
    const row = await recordPricingInputChange({
      kind: "manual",
      changedBy: "staff:brian",
      changedAt: T0,
      note: "recompute everything, no single input row behind it",
    });

    expect(row.kind).toBe("manual");
    expect(row.entityId).toBeNull();
  });

  it("is append-only at the database level", async () => {
    const row = await recordPricingInputChange({
      kind: "manual",
      changedAt: T0,
    });

    await expect(
      prisma.pricingInputChange.update({ where: { id: row.id }, data: { note: "edited" } })
    ).rejects.toThrow(/append-only/i);
  });
});

describe("recordPricingInputChangeIfPriceAffecting — composes criterion 58's classifier", () => {
  it("writes nothing for a write that touched only a non-price-affecting column", async () => {
    const before = await prisma.pricingInputChange.count();

    const result = await recordPricingInputChangeIfPriceAffecting({
      model: "MasterVariant",
      changedColumns: ["lastSyncedPriceCalculationId"],
      entityId: randomUUID(),
      changedAt: T0,
    });

    expect(result).toBeNull();
    expect(await prisma.pricingInputChange.count()).toBe(before);
  });

  it("writes a row, with the kind DERIVED from the model, for a price-affecting column", async () => {
    const entityId = randomUUID();
    const result = await recordPricingInputChangeIfPriceAffecting({
      model: "MasterVariant",
      changedColumns: ["baseWeightGrams"],
      entityId,
      changedBy: "staff:brian",
      changedAt: T0,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("master_variant");
    expect(result!.entityId).toBe(entityId);
  });

  it("writes a row for a MIXED write (one price-affecting, one not)", async () => {
    const result = await recordPricingInputChangeIfPriceAffecting({
      model: "MasterProduct",
      changedColumns: ["status", "sizeIncrement"],
      entityId: randomUUID(),
      changedAt: T0,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("master_product");
  });

  it("derives the correct kind for every covered model", async () => {
    const cases: [
      Parameters<typeof recordPricingInputChangeIfPriceAffecting>[0]["model"],
      string,
    ][] = [
      ["MetalReferencePrice", "metal_reference_price"],
      ["StoneCost", "stone_cost"],
      ["CostComponent", "cost_component"],
      ["PricingProfile", "pricing_profile"],
      ["LaborRate", "labor_rate"],
      ["RingSizeBand", "ring_size_band"],
      ["VariantWeightOverride", "variant_weight_override"],
      ["MasterVariantStone", "master_variant_stone"],
      ["MasterVariant", "master_variant"],
      ["MasterProduct", "master_product"],
    ];

    for (const [model, expectedKind] of cases) {
      const [firstPriceAffectingColumn] = priceAffectingColumnFor(model);
      const result = await recordPricingInputChangeIfPriceAffecting({
        model,
        changedColumns: [firstPriceAffectingColumn],
        entityId: randomUUID(),
        changedAt: T0,
      });
      expect(result!.kind).toBe(expectedKind);
    }
  });
});

// Local, minimal duplicate of one price-affecting column per model — kept
// tiny and separate from the classifier's own exhaustive lists so this test
// file does not need to import test-only internals.
function priceAffectingColumnFor(model: string): [string] {
  const first: Record<string, string> = {
    MetalReferencePrice: "metal",
    StoneCost: "stoneType",
    CostComponent: "componentType",
    PricingProfile: "code",
    LaborRate: "source",
    RingSizeBand: "sizeMin",
    VariantWeightOverride: "size",
    MasterVariantStone: "carat",
    MasterVariant: "baseWeightGrams",
    MasterProduct: "sizeIncrement",
  };
  const column = first[model];
  if (!column) throw new Error(`no fixture column configured for ${model}`);
  return [column];
}

describe("resolveIntentsForPricingInputChange — criterion 11's bulk-approval grouping key", () => {
  it("resolves every intent descending from the SAME pricing_input_change, across multiple runs and calculations", async () => {
    const change = await recordPricingInputChange({
      kind: "metal_reference_price",
      entityId: randomUUID(),
      changedAt: T0,
    });

    // Two variants' calculations, from TWO separate recalculation runs, both
    // caused by the SAME input change — the realistic shape of "one metal
    // price update recalculates every gold variant".
    const idsA = await fixture();
    const idsB = await fixture();

    const runA = await prisma.priceRecalculationRun.create({
      data: {
        id: randomUUID(),
        trigger: "input_change",
        asOf: T0,
        pricingInputChangeId: change.id,
      },
    });
    const runB = await prisma.priceRecalculationRun.create({
      data: {
        id: randomUUID(),
        trigger: "input_change",
        asOf: T0,
        pricingInputChangeId: change.id,
      },
    });

    const calcA = await calculation(idsA, runA.id, 40_000n);
    const calcB = await calculation(idsB, runB.id, 41_000n);

    const intentA = await intent(idsA, calcA.id);
    const intentB = await intent(idsB, calcB.id);

    const resolved = await resolveIntentsForPricingInputChange(change.id);
    const resolvedIds = resolved.map((i) => i.id).sort();

    expect(resolvedIds).toEqual([intentA.id, intentB.id].sort());
  });

  it("does NOT include an intent descending from an UNRELATED pricing_input_change", async () => {
    const changeA = await recordPricingInputChange({ kind: "manual", changedAt: T0 });
    const changeB = await recordPricingInputChange({ kind: "manual", changedAt: T0 });

    const idsA = await fixture();
    const idsB = await fixture();

    const runA = await prisma.priceRecalculationRun.create({
      data: { id: randomUUID(), trigger: "input_change", asOf: T0, pricingInputChangeId: changeA.id },
    });
    const runB = await prisma.priceRecalculationRun.create({
      data: { id: randomUUID(), trigger: "input_change", asOf: T0, pricingInputChangeId: changeB.id },
    });

    const calcA = await calculation(idsA, runA.id, 40_000n);
    const calcB = await calculation(idsB, runB.id, 41_000n);

    const intentA = await intent(idsA, calcA.id);
    await intent(idsB, calcB.id);

    const resolved = await resolveIntentsForPricingInputChange(changeA.id);

    expect(resolved.map((i) => i.id)).toEqual([intentA.id]);
  });

  it("returns an empty list when nothing has been triggered by this change yet", async () => {
    const change = await recordPricingInputChange({ kind: "manual", changedAt: T0 });
    expect(await resolveIntentsForPricingInputChange(change.id)).toEqual([]);
  });

  it("returns an empty list for an unknown id, rather than throwing", async () => {
    expect(await resolveIntentsForPricingInputChange(randomUUID())).toEqual([]);
  });
});

describe("resolvePendingIntentsForPricingInputChange — only the intents a bulk approval can act on", () => {
  it("excludes intents that are no longer pending_approval", async () => {
    const change = await recordPricingInputChange({ kind: "manual", changedAt: T0 });
    const idsPending = await fixture();
    const idsApproved = await fixture();

    const run = await prisma.priceRecalculationRun.create({
      data: { id: randomUUID(), trigger: "input_change", asOf: T0, pricingInputChangeId: change.id },
    });

    const calcPending = await calculation(idsPending, run.id, 40_000n);
    const calcApproved = await calculation(idsApproved, run.id, 41_000n);

    const pendingIntent = await intent(idsPending, calcPending.id, "pending_approval");
    await intent(idsApproved, calcApproved.id, "approved");

    const resolved = await resolvePendingIntentsForPricingInputChange(change.id);

    expect(resolved.map((i) => i.id)).toEqual([pendingIntent.id]);
    expect(resolved[0]!.priceCalculation).toBeDefined();
    expect(resolved[0]!.masterVariant).toBeDefined();
  });
});
