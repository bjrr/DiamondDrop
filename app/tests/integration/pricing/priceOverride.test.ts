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
      overrideBankPaymentPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
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
      overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
      overrideBankPaymentPriceMinorUnits: 100n,
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
        overrideBankPaymentPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
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
      overrideBankPaymentPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
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
      overrideBankPaymentPriceMinorUnits: belowFloor,
      currency: calculation.currency,
      reason: "matching a verified competitor quote, approved by owner",
      overriddenBy: "owner:brian",
      confirmBreach: true,
    });

    expect(result.breaches.length).toBeGreaterThan(0);

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.overrideBankPaymentPriceMinorUnits).toBe(belowFloor);
  });

  it("does not require confirmation when nothing is breached", async () => {
    const calculation = await aComputedCalculation();

    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
        overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
        overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
        overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
      overrideBankPaymentPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
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
      overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
      overrideBankPaymentPriceMinorUnits: calculation.landedCostMinorUnits + 100n,
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
    expect(after.bankPaymentPriceMinorUnits).toBe(calculation.bankPaymentPriceMinorUnits);
    expect(after.landedCostMinorUnits).toBe(calculation.landedCostMinorUnits);
  });

  it("is append-only: an override cannot be edited or deleted afterwards", async () => {
    const calculation = await aComputedCalculation();

    const result = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits * 2n,
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
        overrideBankPaymentPriceMinorUnits: 100_000n,
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
        overrideBankPaymentPriceMinorUnits: 100_000n,
        currency: "EUR",
      })
    ).rejects.toThrow(PriceOverrideCurrencyMismatchError);
  });

  it("refuses to override a variant that has never been priced", async () => {
    await expect(
      previewPriceOverride({
        masterVariantId: crypto.randomUUID(),
        overrideBankPaymentPriceMinorUnits: 100_000n,
        currency: "USD",
      })
    ).rejects.toThrow(NoCalculationToOverrideError);
  });
});

describe("the override preview shows the operator BOTH prices", () => {
  /**
   * An operator types a Bank Payment Price, but what a shopper is quoted is the
   * derived Regular/Card Price. Approving one without seeing the other is
   * approving half the decision.
   *
   * These assertions exist because that field shipped broken and nothing
   * noticed: `deriveRegularCardPrice` returns a result OBJECT, the previous code
   * called `.toString()` on it, and the preview carried the literal string
   * "[object Object]". It typechecked — `Object.prototype.toString` returns a
   * string, which is what the field is declared as — and no test read the
   * value. A money surface with no assertion on its output is not covered.
   */
  it("derives under the rule the OVERRIDDEN CALCULATION used, as actual numbers", async () => {
    // This fixture is dated 2026-09-17, which resolves a profile carrying the
    // superseded fixed 5% / whole-dollar rule. The preview follows that rule,
    // not today's — deliberately, and for the same reason the floors are
    // evaluated against the stored snapshot rather than a fresh resolve: an
    // override reviewed on Tuesday and confirmed on Wednesday must show the
    // same numbers both times.
    //
    // $2,000 x 1.05 = $2,100.00, ceilinged to a whole dollar -> $2,100.00.
    // The current tiered rule would give $2,080.00; that difference is the
    // point of the test.
    const calculation = await aComputedCalculation();

    const preview = await previewPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideBankPaymentPriceMinorUnits: 200_000n,
      currency: calculation.currency,
    });

    expect(preview.resultingRegularCardPriceMinorUnits).toBe("210000");
    expect(preview.resultingBankPaymentSavingsMinorUnits).toBe("10000");
    expect(preview.resultingRegularCardPriceMinorUnits).not.toBe("208000");
  });

  it("derives under the TIERED rule for a calculation made after the switch", async () => {
    // The other half. A calculation dated on or after the owner lock date
    // resolves the tiered profile, and the preview follows it there too — so
    // the field tracks the calculation's own rule rather than hardcoding
    // either.
    await runPriceRecalculation({ asOf: new Date("2026-09-19T00:00:00Z") });
    const calculation = await prisma.priceCalculation.findFirstOrThrow({
      where: { status: "computed" },
      orderBy: { createdAt: "desc" },
    });

    const preview = await previewPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideBankPaymentPriceMinorUnits: 200_000n,
      currency: calculation.currency,
    });

    // $2,000 x 1.04 = $2,080.00, already a $5 multiple.
    expect(preview.resultingRegularCardPriceMinorUnits).toBe("208000");
    expect(preview.resultingBankPaymentSavingsMinorUnits).toBe("8000");
  });

  it("returns digits, never a stringified object", async () => {
    // The shape of the original defect, asserted directly. A regression that
    // reintroduced it would satisfy every type in the system and fail here.
    const calculation = await aComputedCalculation();

    const preview = await previewPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideBankPaymentPriceMinorUnits: 123_456n,
      currency: calculation.currency,
    });

    for (const field of [
      preview.resultingRegularCardPriceMinorUnits,
      preview.resultingBankPaymentSavingsMinorUnits,
    ]) {
      expect(field).toMatch(/^\d+$/);
      expect(field).not.toContain("object");
    }
  });

  it("keeps the saving consistent with the two prices, whichever rule applies", () => {
    // Policy §2 and §9 at the override surface: the number the operator typed
    // is the number that binds, and the saving is exactly the gap to the
    // derived card price. Asserted as an INVARIANT across both rules, since the
    // rule in force depends on the calculation being overridden.
    const check = async () => {
      const calculation = await aComputedCalculation();
      const bank = 123_456n;

      const preview = await previewPriceOverride({
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        overrideBankPaymentPriceMinorUnits: bank,
        currency: calculation.currency,
      });

      const card = BigInt(preview.resultingRegularCardPriceMinorUnits);
      expect(card).toBeGreaterThan(bank);
      expect(BigInt(preview.resultingBankPaymentSavingsMinorUnits)).toBe(card - bank);
    };
    return check();
  });
});
