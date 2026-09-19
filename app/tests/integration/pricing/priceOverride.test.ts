import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CalculationVariantMismatchError,
  NoCalculationToOverrideError,
  PriceOverrideActorRequiredError,
  PriceOverrideConfirmationRequiredError,
  PriceOverrideCurrencyMismatchError,
  PriceOverrideReasonRequiredError,
  applyPriceOverride,
  previewPriceOverride,
} from "~/jobs/pricing/priceOverride.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * D14 (owner-directed 2026-09-17): manual owner overrides are permitted even
 * when they violate the floors, "subject to warning, confirmation, reason and
 * audit".
 *
 * Each of the four is tested as a SEPARATE requirement, because each can be
 * satisfied without the others and a single happy-path test would hide that.
 */

const ASOF = new Date("2026-09-17T00:00:00Z");

async function aComputedCalculation() {
  await runPriceRecalculation({ asOf: ASOF });
  const calculation = await prisma.priceCalculation.findFirstOrThrow({
    where: { status: "computed" },
    orderBy: { createdAt: "desc" },
  });
  return calculation;
}

describe("D14 manual price override — WARNING", () => {
  it("names the specific floor breached rather than warning generically", async () => {
    const calculation = await aComputedCalculation();

    // A price barely above the landed cost breaches both the margin floor and
    // the $100 minimum profit.
    const preview = await previewPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
      currency: calculation.currency,
    });

    expect(preview.breaches.length).toBeGreaterThan(0);
    expect(preview.breaches.map((b) => b.floor)).toContain("min_gross_margin");
    expect(preview.warning).toMatch(/gross margin .* is below the .* floor/);
  });

  it("reports no warning when the override clears every floor", async () => {
    const calculation = await aComputedCalculation();

    // Well above the computed price, so nothing is breached.
    const preview = await previewPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
    });

    expect(preview.breaches).toHaveLength(0);
    expect(preview.warning).toBeNull();
  });

  it("writes nothing — a preview must be safe to call before deciding", async () => {
    const calculation = await aComputedCalculation();
    const before = await prisma.priceOverride.count();

    await previewPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: 100n,
      currency: calculation.currency,
    });

    expect(await prisma.priceOverride.count()).toBe(before);
  });
});

describe("D14 manual price override — CONFIRMATION", () => {
  it("refuses a breaching override that was not explicitly confirmed", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      applyPriceOverride({
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        overrideCashPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
        currency: calculation.currency,
        reason: "matching a competitor quote",
        overriddenBy: "owner:brian",
      })
    ).rejects.toThrow(PriceOverrideConfirmationRequiredError);
  });

  it("carries the breaches on the error so the operator can be shown them", async () => {
    const calculation = await aComputedCalculation();

    // A refusal that does not say what is wrong forces the operator to guess,
    // and guessing at a pricing floor is how a bad price gets confirmed.
    const error = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
      currency: calculation.currency,
      reason: "matching a competitor quote",
      overriddenBy: "owner:brian",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PriceOverrideConfirmationRequiredError);
    expect((error as PriceOverrideConfirmationRequiredError).breaches.length).toBeGreaterThan(0);
    expect((error as PriceOverrideConfirmationRequiredError).warning).toMatch(/WARNING/);
  });

  it("ALLOWS a confirmed breaching override — the owner's explicit decision", async () => {
    const calculation = await aComputedCalculation();
    const belowFloor = calculation.landedCostMinorUnits + 100n;

    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: belowFloor,
      currency: calculation.currency,
      reason: "matching a verified competitor quote, approved by owner",
      overriddenBy: "owner:brian",
      confirmBreach: true,
    });

    expect(result.breaches.length).toBeGreaterThan(0);

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.overrideCashPriceMinorUnits).toBe(belowFloor);
  });

  it("does not require confirmation when nothing is breached", async () => {
    const calculation = await aComputedCalculation();

    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
      reason: "rounding up for a premium collection",
      overriddenBy: "owner:brian",
    });

    expect(result.breaches).toHaveLength(0);
  });
});

describe("D14 manual price override — REASON and attribution", () => {
  it("refuses an override with no reason", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      applyPriceOverride({
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
        currency: calculation.currency,
        reason: "",
        overriddenBy: "owner:brian",
      })
    ).rejects.toThrow(PriceOverrideReasonRequiredError);
  });

  it("refuses a whitespace-only reason", async () => {
    const calculation = await aComputedCalculation();

    // "   " satisfies a NOT NULL column and a truthiness check but is not a
    // reason. The database CHECK backs this up independently.
    await expect(
      applyPriceOverride({
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
        currency: calculation.currency,
        reason: "   ",
        overriddenBy: "owner:brian",
      })
    ).rejects.toThrow(PriceOverrideReasonRequiredError);
  });

  it("refuses an unattributed override", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      applyPriceOverride({
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
        currency: calculation.currency,
        reason: "a perfectly good reason",
        overriddenBy: "",
      })
    ).rejects.toThrow(PriceOverrideActorRequiredError);
  });
});

describe("D14 manual price override — AUDIT", () => {
  it("records the breaches, the warning text shown, the reason and the actor", async () => {
    const calculation = await aComputedCalculation();

    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
      currency: calculation.currency,
      reason: "competitor match, owner approved",
      overriddenBy: "owner:brian",
      confirmBreach: true,
    });

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: result.id } });

    expect(row.reason).toBe("competitor match, owner approved");
    expect(row.overriddenBy).toBe("owner:brian");
    expect(row.breachedFloors).toContain("min_gross_margin");
    // The warning VERBATIM, not regenerated: what the operator was actually
    // told is the fact that matters if this price is ever questioned.
    expect(row.warningShown).toMatch(/WARNING/);
    expect(row.priceCalculationId).toBe(calculation.id);
  });

  it("records an empty breach list rather than null when nothing was breached", async () => {
    const calculation = await aComputedCalculation();

    // "checked and found none" and "never checked" must not look the same.
    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
      reason: "premium positioning",
      overriddenBy: "owner:brian",
    });

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.breachedFloors).toEqual([]);
    expect(row.warningShown).toBeNull();
  });

  it("leaves the original calculation completely untouched", async () => {
    const calculation = await aComputedCalculation();

    await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
      currency: calculation.currency,
      reason: "competitor match",
      overriddenBy: "owner:brian",
      confirmBreach: true,
    });

    const after = await prisma.priceCalculation.findUniqueOrThrow({
      where: { id: calculation.id },
    });

    // "What did the engine compute?" must still be answerable after someone
    // intervened — which is exactly when that question gets asked.
    expect(after.cashPriceMinorUnits).toBe(calculation.cashPriceMinorUnits);
    expect(after.landedCostMinorUnits).toBe(calculation.landedCostMinorUnits);
  });

  it("is append-only: an override cannot be edited or deleted afterwards", async () => {
    const calculation = await aComputedCalculation();

    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
      reason: "original reason",
      overriddenBy: "owner:brian",
    });

    await expect(
      prisma.priceOverride.update({
        where: { id: result.id },
        data: { reason: "a more flattering reason" },
      })
    ).rejects.toThrow(/append-only/);

    await expect(prisma.priceOverride.delete({ where: { id: result.id } })).rejects.toThrow(
      /append-only/
    );
  });
});

describe("D14 manual price override — input validation", () => {
  it("refuses a calculation belonging to a different variant", async () => {
    await runPriceRecalculation({ asOf: ASOF });
    const [first, second] = await prisma.priceCalculation.findMany({
      where: { status: "computed" },
      orderBy: { createdAt: "desc" },
      take: 2,
    });

    // Without this check the floors would be evaluated against another
    // variant's cost basis, and a breaching price could be recorded as clean.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.masterVariantId).not.toBe(second!.masterVariantId);

    await expect(
      previewPriceOverride({
        masterVariantId: first!.masterVariantId,
        priceCalculationId: second!.id,
        overrideCashPriceMinorUnits: 100_000n,
        currency: first!.currency,
      })
    ).rejects.toThrow(CalculationVariantMismatchError);
  });

  it("refuses a currency that does not match the calculation", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      previewPriceOverride({
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        overrideCashPriceMinorUnits: 100_000n,
        currency: "EUR",
      })
    ).rejects.toThrow(PriceOverrideCurrencyMismatchError);
  });

  it("refuses to override a variant that has never been priced", async () => {
    await expect(
      previewPriceOverride({
        masterVariantId: crypto.randomUUID(),
        overrideCashPriceMinorUnits: 100_000n,
        currency: "USD",
      })
    ).rejects.toThrow(NoCalculationToOverrideError);
  });
});
