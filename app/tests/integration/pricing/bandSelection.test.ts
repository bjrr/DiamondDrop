import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { computeBuyNowBandPrice } from "~/domain/pricing/engine";
import { resolveInputsForVariant } from "~/jobs/pricing/resolveInputs.server";

/**
 * REGRESSION — each variant must be priced off ITS OWN band.
 *
 * Found by QA review, not by the existing suite. The job selected a band with
 * `bands.find((b) => b.label !== undefined)`, which is true for every band, so
 * every variant was priced off the first band by sortOrder. Because weight
 * grows with size, every band past the first was systematically UNDER-priced,
 * and the wrong number was written to price_calculation.
 *
 * The unit tests did not catch it: bands.test.ts and engine.test.ts correctly
 * exercise selectBandPrice and computeBuyNowBandPrice with an INJECTED band,
 * so the band layer was fine. Nothing tested which band the orchestration
 * layer chose. job.test.ts's fixtures are all sizeAxis "none", so the banded
 * path never ran there at all.
 *
 * This test uses the seeded three-band ring, which is exactly the shape that
 * exposed the defect.
 */

const ASOF = new Date("2026-06-01T00:00:00Z");

const SEEDED = [
  { name: "low band variant", id: "00000000-0000-4000-8000-000000000021" },
  { name: "mid band variant", id: "00000000-0000-4000-8000-000000000022" },
  { name: "high band variant", id: "00000000-0000-4000-8000-000000000023" },
] as const;

describe("a banded variant is priced off its own band", () => {
  it.each(SEEDED)("$name resolves to the band its bandId points at", async ({ id }) => {
    const variant = await prisma.masterVariant.findUnique({
      where: { id },
      include: { band: true },
    });
    expect(variant?.bandId).not.toBeNull();

    const resolved = await resolveInputsForVariant(id, ASOF);
    const selected = resolved.bands.find((b) => b.id === variant!.bandId);

    expect(selected).toBeDefined();
    expect(selected!.label).toBe(variant!.band!.label);
  });

  it("prices the high band ABOVE the low band", async () => {
    // The defect made these identical, because both were priced off band
    // "2-6". Weight grows with size, so a higher band must cost more.
    const low = await priceFor(SEEDED[0].id);
    const high = await priceFor(SEEDED[2].id);

    expect(BigInt(high.price) > BigInt(low.price)).toBe(true);
    expect(high.costBasisSize).not.toBe(low.costBasisSize);
  });

  it("uses a cost basis size inside the variant's own band", async () => {
    for (const { id } of SEEDED) {
      const variant = await prisma.masterVariant.findUnique({
        where: { id },
        include: { band: true },
      });
      const { costBasisSize } = await priceFor(id);
      const size = Number(costBasisSize);
      expect(size).toBeGreaterThanOrEqual(Number(variant!.band!.sizeMin.toString()));
      expect(size).toBeLessThanOrEqual(Number(variant!.band!.sizeMax.toString()));
    }
  });
});

async function priceFor(variantId: string) {
  const variant = await prisma.masterVariant.findUnique({ where: { id: variantId } });
  const resolved = await resolveInputsForVariant(variantId, ASOF);
  const band = resolved.bands.find((b) => b.id === variant!.bandId)!;
  const result = computeBuyNowBandPrice({ ...resolved.inputs, band });
  return { price: result.bandCashPrice.amountMinorUnits, costBasisSize: result.costBasisSize };
}
