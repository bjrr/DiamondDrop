import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "~/db/client.server";
import { getCalculationFailureStatus } from "~/db/repositories/priceCalculationFailureRepository.server";
import { applyPriceOverride, resolveActiveOverride } from "~/jobs/pricing/priceOverride.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * Team-lead finding (2026-09-19): `recordCalculationFailure`,
 * `recordCalculationSuccess` (owner §7) and `expireOverrideIfMaterial` (owner
 * §17) were fully built and tested at the domain/repository layer with ZERO
 * callers in `app/jobs`, `app/routes` or `scripts` — implemented, green, and
 * completely inert. This file proves the wiring added to
 * `runRecalculation.server.ts` actually reaches them, with assertions that
 * would fail if either call were removed.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

const ASOF = new Date("2026-06-03T00:00:00Z");

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
  const secondsIntoWindow = uniqueInt() % (26 * 24 * 60 * 60);
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

/** Same minimal shape used across the other T1 wiring files. */
async function priceableVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `recalc-wiring fixture ${suffix}`,
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
  return { product, variant };
}

/**
 * A band that belongs to a DIFFERENT product than the variant that will
 * carry its id — the exact data-integrity shape `BandResolutionError`
 * exists for. A real FK-satisfying row (the column is a real foreign key),
 * just the wrong product's, so `resolved.bands.find(b => b.id === bandId)`
 * deterministically fails without touching any shared/global cost table.
 */
async function bandFromAnotherProduct() {
  const suffix = randomUUID().slice(0, 8);
  const otherProduct = await prisma.masterProduct.create({
    data: {
      name: `unrelated band-owning product ${suffix}`,
      category: "ring",
      sizeAxis: "ring_size_us",
      allowedSizeMin: "4",
      allowedSizeMax: "9",
      sizeIncrement: "0.5",
      baseSize: "6",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
  return prisma.ringSizeBand.create({
    data: {
      masterProductId: otherProduct.id,
      label: "unrelated band",
      sizeMin: "4",
      sizeMax: "9",
      sortOrder: 1,
    },
  });
}

describe("owner §7 — calculation-failure wiring", () => {
  it("a failing variant opens an episode, notifies exactly once across retries, and would not exist without the wiring", async () => {
    await realisticProfile();
    const { variant } = await priceableVariant();
    const wrongBand = await bandFromAnotherProduct();
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { bandId: wrongBand.id } });

    // Spied at the console boundary (same technique as logger.server.test.ts)
    // so this test observes exactly what a log consumer would.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    expect(first.failed).toBe(1);
    const second = await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    expect(second.failed).toBe(1);

    // BEFORE this wiring existed, nothing wrote this row at all — this
    // assertion is false without the `recordCalculationFailure` call.
    const status = await getCalculationFailureStatus(variant.id);
    expect(status).not.toBeNull();
    expect(status!.failureType).toBe("unresolved_band");
    expect(status!.attemptCount).toBe(2);
    expect(status!.resolvedAt).toBeNull();
    expect(status!.withdrawn).toBe(false); // well under the 48h threshold

    // "Notify the admin immediately" (owner §7) fires on the attempt that
    // OPENS the episode, never again on a retry of the same open one.
    const openedEvents = errorSpy.mock.calls.filter(
      ([line]) => typeof line === "string" && line.includes("pricing.calculation_failure_opened")
    );
    expect(openedEvents).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("correcting the underlying data resolves the episode with the run's own trigger recorded", async () => {
    await realisticProfile();
    const { variant } = await priceableVariant();
    const wrongBand = await bandFromAnotherProduct();
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { bandId: wrongBand.id } });

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    const failing = await getCalculationFailureStatus(variant.id);
    expect(failing?.resolvedAt).toBeNull();

    // The underlying problem is corrected: the bad band reference is removed.
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { bandId: null } });

    const summary = await runPriceRecalculation({
      asOf: ASOF,
      runId: randomUUID(),
      variantIds: [variant.id],
      trigger: "staff",
      triggeredBy: "brian",
    });
    expect(summary.failed).toBe(0);
    expect(summary.computed).toBe(1);

    const resolved = await getCalculationFailureStatus(variant.id);
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.withdrawn).toBe(false);

    // resolvedTrigger is not on the status-read shape — read the row directly
    // to confirm owner §7 recovery step 5's attribution survived the wiring.
    const row = await prisma.priceCalculationFailure.findFirstOrThrow({
      where: { masterVariantId: variant.id },
    });
    expect(row.resolvedTrigger).toBe("staff:brian");
  });
});

describe("owner §17 — override-expiry wiring", () => {
  it("a MATERIALLY different recalculation expires the override in force", async () => {
    await realisticProfile();
    const { variant } = await priceableVariant();

    const run1 = await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    expect(run1.computed).toBe(1);
    const calc1 = await prisma.priceCalculation.findFirstOrThrow({
      where: { masterVariantId: variant.id, status: "computed" },
      orderBy: { createdAt: "desc" },
    });

    const override = await applyPriceOverride({
      masterVariantId: variant.id,
      priceCalculationId: calc1.id,
      overrideBankPaymentPriceMinorUnits: calc1.bankPaymentPriceMinorUnits + 10_000n, // +$100, above cost — no floor breach
      currency: calc1.currency,
      reason: "test override for §17 wiring",
      overriddenBy: "staff:test",
    });
    expect(await resolveActiveOverride(variant.id)).not.toBeNull();

    // A genuinely price-affecting input change, isolated to this variant —
    // no shared/global table touched, so no other test can be polluted.
    await prisma.masterVariant.update({ where: { id: variant.id }, data: { baseWeightGrams: "9.0000" } });

    const run2 = await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    expect(run2.computed).toBe(1);
    const calc2 = await prisma.priceCalculation.findFirstOrThrow({
      where: { masterVariantId: variant.id, status: "computed" },
      orderBy: { createdAt: "desc" },
    });
    expect(calc2.bankPaymentPriceMinorUnits).not.toBe(calc1.bankPaymentPriceMinorUnits);

    // BEFORE this wiring existed, nothing ever appended an `expired` row —
    // the chain's head would still be the `set` row here.
    //
    // NOT asserted via `resolveActiveOverride` (priceOverride.server.ts,
    // owned by another agent, not modified by this task): that helper
    // returns null only for `kind === "revoke"` and does not exclude
    // `kind === "expired"`, so it would incorrectly report this retired
    // override as still active — a genuine pre-existing defect, flagged in
    // the handoff rather than fixed here. The append-only chain itself is
    // unambiguous, so this asserts the head row directly, the same way
    // `priceOverrideExpiryRepository.server.ts`'s OWN internal resolver
    // (correctly) does.
    const head = await prisma.priceOverride.findFirstOrThrow({
      where: { masterVariantId: variant.id, supersededBy: null },
      orderBy: { createdAt: "desc" },
    });
    expect(head.kind).toBe("expired");
    expect(head.supersedesId).toBe(override.id);
    expect(head.priceCalculationId).toBe(calc2.id);
  });

  it("a no-change recalculation leaves the override in force — the owner-confirmed materiality definition (D18)", async () => {
    await realisticProfile();
    const { variant } = await priceableVariant();

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });
    const calc1 = await prisma.priceCalculation.findFirstOrThrow({
      where: { masterVariantId: variant.id, status: "computed" },
      orderBy: { createdAt: "desc" },
    });

    await applyPriceOverride({
      masterVariantId: variant.id,
      priceCalculationId: calc1.id,
      overrideBankPaymentPriceMinorUnits: calc1.bankPaymentPriceMinorUnits + 10_000n,
      currency: calc1.currency,
      reason: "test override, immaterial-recalc case",
      overriddenBy: "staff:test",
    });

    // Same inputs, same asOf -> the engine is deterministic, so this recomputes
    // the IDENTICAL bank price. A daily no-change run must retire nothing.
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), variantIds: [variant.id] });

    const stillActive = await resolveActiveOverride(variant.id);
    expect(stillActive).not.toBeNull();
    const expiredRow = await prisma.priceOverride.findFirst({
      where: { masterVariantId: variant.id, kind: "expired" },
    });
    expect(expiredRow).toBeNull();
  });
});
