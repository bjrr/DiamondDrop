import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { resolveInputsForVariant } from "~/jobs/pricing/resolveInputs.server";

/**
 * Tests for the COMPOSITION MODULE (spec §4.0).
 *
 * This file exists because of a pattern, not a single bug. Every defect found
 * in slice 1 review — four of them, two critical — was in orchestration: pure
 * components that were correct and well tested, wired together wrongly, with
 * the wiring itself untested. `resolveInputs.server.ts` is where layers meet,
 * and it had no test file at all.
 *
 * So these assert the WIRING, not the arithmetic: that the right value, in the
 * right unit, reaches the right field for the right variant.
 */

const ASOF = new Date("2026-06-01T00:00:00Z");
const SEEDED_MID_VARIANT = "00000000-0000-4000-8000-000000000022";

describe("units survive the L2 -> engine boundary", () => {
  it("converts the metal price from major units per gram to MINOR units", async () => {
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);

    const row = await prisma.metalPrice.findFirst({
      where: { metal: "gold", purity: "GOLD_14K", effectiveFrom: { lte: ASOF } },
      orderBy: { effectiveFrom: "desc" },
    });

    const expected = new MoneyDecimal(row!.pricePerGram.toString()).times(100);
    expect(new MoneyDecimal(resolved.inputs.metalPricePerGramMinorUnits).equals(expected)).toBe(true);
  });

  it("converts a PER-CARAT stone cost to minor units too", async () => {
    // The repository documents costPerCaratMajorUnits as MAJOR units and the
    // engine consumes perCaratCost as MINOR. Missing this conversion priced a
    // $150/ct gem at $1.50 — a 100x under-price — while the metal price three
    // lines away was converted correctly.
    const product = await prisma.masterProduct.create({
      data: {
        name: `per-carat wiring ${Date.now()}`,
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
    await prisma.masterVariantStone.create({
      data: {
        masterVariantId: variant.id,
        position: 1,
        stoneType: "colored_gemstone",
        shape: "oval",
        carat: "1.000",
        quantity: 1,
      },
    });

    const resolved = await resolveInputsForVariant(variant.id, ASOF);
    const stone = resolved.inputs.stones[0]!;
    expect(stone.perCaratCost).toBeDefined();

    const row = await prisma.stoneCost.findFirst({
      where: { stoneType: "colored_gemstone", shape: "oval", costKind: "per_carat" },
    });
    const expected = new MoneyDecimal(row!.costPerCarat!.toString()).times(100);
    expect(new MoneyDecimal(stone.perCaratCost!).equals(expected)).toBe(true);

    // The seeded gem is $150/ct, so 15000 minor units — not 150.
    expect(new MoneyDecimal(stone.perCaratCost!).greaterThan(1000)).toBe(true);
  });
});

describe("every configured cost component reaches the engine", () => {
  it("loads all component types present in the library, not a hard-coded subset", async () => {
    // An earlier version loaded a list that omitted cad, assembly,
    // supplier_fee and other. The engine handles all four; they never
    // arrived, so $30.00 of seeded CAD and assembly labour was absent from
    // every price, invisibly.
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);
    const loaded = new Set(resolved.inputs.components.map((c) => c.componentType));

    const configured = await prisma.costComponent.findMany({
      where: { effectiveFrom: { lte: ASOF } },
      select: { componentType: true },
      distinct: ["componentType"],
    });

    for (const { componentType } of configured) {
      expect(loaded.has(componentType), `component ${componentType} was configured but never loaded`).toBe(
        true
      );
    }
  });

  it("includes cad and assembly specifically", async () => {
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);
    const types = resolved.inputs.components.map((c) => c.componentType);
    expect(types).toContain("cad");
    expect(types).toContain("assembly");
  });
});

describe("inputs are correlated to the right variant", () => {
  it("resolves the metal price for the variant's own metal and purity", async () => {
    const variant = await prisma.masterVariant.findUnique({ where: { id: SEEDED_MID_VARIANT } });
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);

    const row = await prisma.metalPrice.findFirst({
      where: { metal: variant!.metal, purity: variant!.purity, effectiveFrom: { lte: ASOF } },
      orderBy: { effectiveFrom: "desc" },
    });
    const expected = new MoneyDecimal(row!.pricePerGram.toString()).times(100);
    expect(new MoneyDecimal(resolved.inputs.metalPricePerGramMinorUnits).equals(expected)).toBe(true);
  });

  it("carries the variant's own stones, in position order", async () => {
    const stones = await prisma.masterVariantStone.findMany({
      where: { masterVariantId: SEEDED_MID_VARIANT },
      orderBy: { position: "asc" },
    });
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);

    expect(resolved.inputs.stones).toHaveLength(stones.length);
    expect(resolved.inputs.stones.map((s) => s.position)).toEqual(stones.map((s) => s.position));
    expect(resolved.inputs.stones.map((s) => s.quantity)).toEqual(stones.map((s) => s.quantity));
  });

  it("carries band ids so the job can select the variant's own band", async () => {
    const variant = await prisma.masterVariant.findUnique({ where: { id: SEEDED_MID_VARIANT } });
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);
    // Without an id there is no way to correlate a band back to the variant,
    // which is how every variant came to be priced off the first band.
    expect(resolved.bands.every((b) => typeof b.id === "string" && b.id.length > 0)).toBe(true);
    expect(resolved.bands.some((b) => b.id === variant!.bandId)).toBe(true);
  });
});

describe("provenance is carried for reproduction (§5.6)", () => {
  it("attaches provenance to every stone position", async () => {
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);
    for (const stone of resolved.inputs.stones) {
      expect(stone.provenance?.sourceTable).toBe("stone_cost");
      expect(stone.provenance?.sourceId).toBeTruthy();
    }
  });

  it("attaches provenance to every component", async () => {
    const resolved = await resolveInputsForVariant(SEEDED_MID_VARIANT, ASOF);
    for (const component of resolved.inputs.components) {
      expect(component.provenance?.sourceTable).toBe("cost_component");
    }
  });
});
