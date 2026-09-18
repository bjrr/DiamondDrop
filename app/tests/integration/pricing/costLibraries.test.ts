import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  AmbiguousCostInputError,
  MissingCostInputError,
  selectMostSpecific,
} from "~/db/repositories/effectiveDated.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { alloyedPricePerGram } from "~/domain/pricing/purity";
import { resolveMetalPrice } from "~/db/repositories/metalPriceRepository.server";
import { resolveStoneCost } from "~/db/repositories/stoneCostRepository.server";

/**
 * CRITERIA 14, 36, 37 — the L2 cost libraries.
 *
 * This layer had NO test file. It is where CRITICAL-4 (per-carat units) lived,
 * and where §11's whole "Cost resolution" row was never written. Shape
 * enforcement, the Seam A source rule and the shared specificity helper are
 * all only observable here: the engine never sees a shape or a source, so no
 * pure test can reach them.
 */

const ASOF = new Date("2026-06-01T00:00:00Z");
let sequence = 0;
const uniqueDate = (): Date =>
  new Date(Date.UTC(2031, 0, 1) + ((Date.now() % 500_000) + (sequence += 1)) * 3_600_000);

describe("criterion 14 — shape is part of the stone key (R4)", () => {
  it("resolves different costs for the same carat in different shapes", async () => {
    const round = await resolveStoneCost(
      { stoneType: "lab_diamond", shape: "round", carat: "1.000" },
      ASOF
    );
    const princess = await resolveStoneCost(
      { stoneType: "lab_diamond", shape: "princess", carat: "1.000" },
      ASOF
    );

    expect(round.kind).toBe("per_stone");
    expect(princess.kind).toBe("per_stone");
    if (round.kind !== "per_stone" || princess.kind !== "per_stone") return;

    // Same stone type, same carat band, different shape, different cost.
    expect(round.cost.toJSON().amountMinorUnits).not.toBe(
      princess.cost.toJSON().amountMinorUnits
    );
  });

  it("a shape with no cost row is a MISS, never a fallback to a similar shape", async () => {
    // Pricing an emerald-cut stone off a round row would silently under- or
    // over-price it; refusing is the only safe answer.
    await expect(
      resolveStoneCost({ stoneType: "lab_diamond", shape: "emerald-cut-unpriced", carat: "1.000" }, ASOF)
    ).rejects.toBeInstanceOf(MissingCostInputError);
  });

  it("carat banding is min-inclusive and max-EXCLUSIVE", async () => {
    // The seeded lab_diamond round band is [0.900, 1.100).
    await expect(
      resolveStoneCost({ stoneType: "lab_diamond", shape: "round", carat: "0.900" }, ASOF)
    ).resolves.toBeDefined();
    await expect(
      resolveStoneCost({ stoneType: "lab_diamond", shape: "round", carat: "1.100" }, ASOF)
    ).rejects.toBeInstanceOf(MissingCostInputError);
  });
});

describe("criterion 36 — Seam A: metal reference source is provenance, never selected on", () => {
  it("resolves the later row regardless of which source wrote it", async () => {
    // Two rows differing only in source. The later effectiveFrom must win in
    // BOTH directions, or something is branching on source.
    const early = uniqueDate();
    const late = new Date(early.getTime() + 86_400_000);

    await prisma.metalReferencePrice.create({
      data: {
        metal: "platinum",

        pricePerGram: "10.000000",
        currency: "USD",
        effectiveFrom: early,
        source: "feed",
        enteredBy: null,
      },
    });
    await prisma.metalReferencePrice.create({
      data: {
        metal: "platinum",
        pricePerGram: "20.000000",
        currency: "USD",
        effectiveFrom: late,
        source: "manual",
        enteredBy: "integration-test",
      },
    });

    const resolved = await resolveMetalPrice("platinum", "PLATINUM_950", new Date(late.getTime() + 1000));
    // manual wins here only because it is LATER — not because it is manual.
    // The RAW reference is what the row carries; pricePerGramMajorUnits is now
    // the DERIVED alloyed price (pure x fineness), so both are checked. The
    // later row wins regardless of which source wrote it — that is Seam A.
    expect(resolved.pureReferencePerGramMajorUnits).toBe("20");
    expect(resolved.pricePerGramMajorUnits).toBe(
      alloyedPricePerGram(new MoneyDecimal("20"), "PLATINUM_950").toString()
    );
    expect(resolved.source).toBe("manual");

    // As of a moment before the later row, the feed row wins on the same rule.
    const earlier = await resolveMetalPrice(
      "platinum",
      "PLATINUM_950",
      new Date(late.getTime() - 1000)
    );
    expect(earlier.pureReferencePerGramMajorUnits).toBe("10");
    expect(earlier.source).toBe("feed");
  });

  it("returns source as provenance on the resolved value", async () => {
    const resolved = await resolveMetalPrice("gold", "GOLD_14K", ASOF);
    expect(["manual", "feed"]).toContain(resolved.source);
    expect(resolved.provenance.sourceTable).toBe("metal_reference_price");
    expect(resolved.provenance.sourceId).toBeTruthy();
  });
});

describe("criterion 37 — the shared specificity helper", () => {
  const row = (id: string, effectiveFrom: Date, quals: Record<string, string | null>) => ({
    id,
    effectiveFrom,
    color: null,
    clarity: null,
    supplierRef: null,
    ...quals,
  });
  const KEYS = ["color", "clarity", "supplierRef"] as const;
  const opts = { asOf: ASOF, component: "stone_cost" };
  const query = { color: "G", clarity: "VS1", supplierRef: null };
  const d = (iso: string) => new Date(iso);

  it("a null qualifier on a row is a WILDCARD that matches anything", () => {
    const chosen = selectMostSpecific([row("w", d("2026-01-01"), {})], query, [...KEYS], opts);
    expect(chosen.id).toBe("w");
  });

  it("specificity beats recency", () => {
    // The rule most easily inverted: a RECENT wildcard must not outrank an
    // OLDER row that actually matches the query.
    const chosen = selectMostSpecific(
      [row("recentWildcard", d("2026-05-01"), {}), row("oldSpecific", d("2026-01-01"), { color: "G" })],
      query,
      [...KEYS],
      opts
    );
    expect(chosen.id).toBe("oldSpecific");
  });

  it("breaks an equal-specificity tie on the later effectiveFrom", () => {
    const chosen = selectMostSpecific(
      [row("old", d("2026-01-01"), { color: "G" }), row("new", d("2026-03-01"), { color: "G" })],
      query,
      [...KEYS],
      opts
    );
    expect(chosen.id).toBe("new");
  });

  it("throws on an unresolvable tie rather than picking arbitrarily", () => {
    // A silent choice here would make a price depend on row insertion order.
    expect(() =>
      selectMostSpecific(
        [row("a", d("2026-01-01"), { color: "G" }), row("b", d("2026-01-01"), { clarity: "VS1" })],
        query,
        [...KEYS],
        opts
      )
    ).toThrow(AmbiguousCostInputError);
  });

  it("Seam B: a supplier-specific row is INERT when the query is supplier-agnostic", () => {
    // Slice 1 has no supplier dimension on a product, so every lookup passes
    // supplierRef: null and supplier rows must not apply. This falls out of
    // the wildcard rule rather than needing a special case.
    const chosen = selectMostSpecific(
      [
        row("agnostic", d("2026-01-01"), {}),
        row("supplierX", d("2026-05-01"), { supplierRef: "SUP-X" }),
      ],
      query,
      [...KEYS],
      opts
    );
    expect(chosen.id).toBe("agnostic");
  });

  it("ignores rows effective after asOf", () => {
    const chosen = selectMostSpecific(
      [row("now", d("2026-01-01"), {}), row("future", d("2027-01-01"), { color: "G" })],
      query,
      [...KEYS],
      opts
    );
    expect(chosen.id).toBe("now");
  });

  it("throws MissingCostInputError when nothing applies", () => {
    expect(() => selectMostSpecific([], query, [...KEYS], opts)).toThrow(MissingCostInputError);
  });
});

describe("stone cost carries provenance and currency", () => {
  it("returns the source row id so a calculation can name what it used", async () => {
    const resolved = await resolveStoneCost(
      { stoneType: "lab_diamond", shape: "round", carat: "1.000" },
      ASOF
    );
    expect(resolved.provenance.sourceTable).toBe("stone_cost");
    expect(resolved.provenance.sourceId).toBeTruthy();
    expect(resolved.provenance.effectiveFrom).toBeInstanceOf(Date);
  });

  it("returns per-carat costs in MAJOR units, as its type name states", async () => {
    // The unit contract at this boundary is what CRITICAL-4 violated: the
    // composition module must convert. Pinning the repository side here.
    const resolved = await resolveStoneCost(
      { stoneType: "colored_gemstone", shape: "oval", carat: "1.000" },
      ASOF
    );
    expect(resolved.kind).toBe("per_carat");
    if (resolved.kind !== "per_carat") return;

    const row = await prisma.stoneCost.findFirst({
      where: { stoneType: "colored_gemstone", shape: "oval", costKind: "per_carat" },
    });
    expect(resolved.costPerCaratMajorUnits).toBe(row!.costPerCarat!.toString());
  });
});

// Keep a stable reference so the unused-import rule does not fire when a test
// above is temporarily commented out during debugging.
export const __fixtureId = randomUUID();
