import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * Slice 2 stage 2A, migrations M1-M7
 * (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §6). Schema-only tests
 * for T5's migrations — no job/route code from T1-T4/T9 exists yet, so
 * everything here goes straight through Prisma, the same style as
 * `appendOnlyTriggers.test.ts` and the trigger sections of
 * `groupbuy/freezeAtOpen.test.ts`.
 *
 * Finding F-15 (docs/specs/SLICE-0-FINDINGS.md): the existing append-only
 * trigger tests assert a bare `.toThrow()`, which would also pass for an
 * unrelated failure (a bad foreign key, a missing NOT NULL column). Every
 * rejection below is asserted against the SPECIFIC "is append-only" message
 * the `prevent_evidence_mutation`/`prevent_evidence_truncate` functions
 * raise, so a test here can only pass because the trigger fired.
 */

const ASOF = new Date("2026-09-19T00:00:00Z");

async function aComputedCalculation() {
  await runPriceRecalculation({ asOf: ASOF });
  return prisma.priceCalculation.findFirstOrThrow({
    where: { status: "computed" },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * A fresh master_variant id, not shared with any other caller in this file.
 *
 * price_sync_failure needs no PriceCalculation at all (its only FK is
 * master_variant_id) and this file's OWN partial unique index — at most one
 * OPEN episode per variant — means two tests sharing a variant would collide
 * with EACH OTHER, not with the schema under test. Cycling through the
 * seeded active variants keeps every test's fixture data isolated.
 */
let nextVariantIndex = 0;
async function aFreshMasterVariantId(): Promise<string> {
  const variants = await prisma.masterVariant.findMany({
    where: { status: "active" },
    orderBy: { id: "asc" },
  });
  if (nextVariantIndex >= variants.length) {
    throw new Error(
      `Seed data has only ${variants.length} active master_variant rows; this file needs one more than that.`
    );
  }
  return variants[nextVariantIndex++]!.id;
}

async function aBankPaymentOrderLine() {
  const calculation = await aComputedCalculation();

  const order = await prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`,
      quotedAt: ASOF,
      guaranteeExpiresAt: new Date(ASOF.getTime() + 24 * 60 * 60 * 1000),
    },
  });

  const line = await prisma.bankPaymentOrderLine.create({
    data: {
      bankPaymentOrderId: order.id,
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      quantity: 1,
      quotedBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits,
      quotedRegularCardPriceMinorUnits: calculation.bankPaymentPriceMinorUnits + 500n,
      currency: calculation.currency,
      eligibleAtQuoteTime: true,
    },
  });

  return { order, line };
}

describe("M7: pricing_input_change is append-only at the DATABASE", () => {
  it("allows INSERT", async () => {
    await expect(
      prisma.pricingInputChange.create({
        data: { kind: "manual", changedBy: "staff:test", changedAt: ASOF },
      })
    ).resolves.toBeDefined();
  });

  it("REJECTS UPDATE with the specific append-only error, not any error", async () => {
    const row = await prisma.pricingInputChange.create({
      data: { kind: "metal_reference_price", entityId: randomUUID(), changedAt: ASOF },
    });

    await expect(
      prisma.pricingInputChange.update({ where: { id: row.id }, data: { note: "edited" } })
    ).rejects.toThrow(/pricing_input_change is append-only: UPDATE is not permitted/);
  });

  it("REJECTS DELETE with the specific append-only error, not any error", async () => {
    const row = await prisma.pricingInputChange.create({
      data: { kind: "cost_component", entityId: randomUUID(), changedAt: ASOF },
    });

    await expect(prisma.pricingInputChange.delete({ where: { id: row.id } })).rejects.toThrow(
      /pricing_input_change is append-only: DELETE is not permitted/
    );
  });

  it("REJECTS TRUNCATE with the specific append-only error", async () => {
    // CASCADE, not a bare TRUNCATE: price_recalculation_run's M4 foreign key
    // now references this table, so an unqualified TRUNCATE fails on that
    // dependency before the trigger even runs (the same limitation F-15
    // already recorded against the pre-existing evidence-table tests). The
    // BEFORE TRUNCATE ... FOR EACH STATEMENT trigger on pricing_input_change
    // still fires and still aborts the whole statement even under CASCADE,
    // which is exactly what this asserts.
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE TABLE "pricing_input_change" CASCADE`)
    ).rejects.toThrow(/pricing_input_change is append-only: TRUNCATE is not permitted/);
  });
});

describe("M7: bank_payment_order_line is append-only at the DATABASE", () => {
  it("allows INSERT with a real calculation and variant", async () => {
    const { line } = await aBankPaymentOrderLine();
    expect(line.quotedBankPaymentPriceMinorUnits).toBeGreaterThan(0n);
  });

  it("REJECTS an UPDATE to a quote column with the specific append-only error", async () => {
    const { line } = await aBankPaymentOrderLine();

    await expect(
      prisma.bankPaymentOrderLine.update({
        where: { id: line.id },
        data: { quotedBankPaymentPriceMinorUnits: 1n },
      })
    ).rejects.toThrow(/bank_payment_order_line is append-only: UPDATE is not permitted/);
  });

  it("REJECTS an UPDATE to a non-quote column too — the whole row is protected", async () => {
    const { line } = await aBankPaymentOrderLine();

    await expect(
      prisma.bankPaymentOrderLine.update({ where: { id: line.id }, data: { quantity: 2 } })
    ).rejects.toThrow(/bank_payment_order_line is append-only: UPDATE is not permitted/);
  });

  it("REJECTS DELETE with the specific append-only error", async () => {
    const { line } = await aBankPaymentOrderLine();

    await expect(prisma.bankPaymentOrderLine.delete({ where: { id: line.id } })).rejects.toThrow(
      /bank_payment_order_line is append-only: DELETE is not permitted/
    );
  });

  it("REJECTS TRUNCATE with the specific append-only error", async () => {
    await aBankPaymentOrderLine();

    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE TABLE "bank_payment_order_line"`)
    ).rejects.toThrow(/bank_payment_order_line is append-only: TRUNCATE is not permitted/);
  });
});

describe("guards the guard: the MUTABLE tables next to the new append-only ones", () => {
  // A blanket trigger applied to the wrong table would pass every test above
  // by accident (an over-broad trigger still "rejects" everything) while
  // silently breaking the workflow tables it must NOT touch. These prove the
  // boundary was drawn in the right place.

  it("bank_payment_order (the header) STILL ALLOWS UPDATE — it is the mutable lifecycle row", async () => {
    const order = await prisma.bankPaymentOrder.create({
      data: {
        shopifyDraftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`,
        quotedAt: ASOF,
        guaranteeExpiresAt: new Date(ASOF.getTime() + 24 * 60 * 60 * 1000),
      },
    });

    await expect(
      prisma.bankPaymentOrder.update({
        where: { id: order.id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancellationReason: "price changed after 24h, unpaid",
        },
      })
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("price_sync_failure STILL ALLOWS UPDATE — it is the mutable failure-episode row", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const failure = await prisma.priceSyncFailure.create({
      data: {
        masterVariantId,
        firstFailedAt: ASOF,
        lastAttemptAt: ASOF,
        lastError: "Admin API 500",
      },
    });

    await expect(
      prisma.priceSyncFailure.update({
        where: { id: failure.id },
        data: { attemptCount: 2, lastAttemptAt: new Date() },
      })
    ).resolves.toMatchObject({ attemptCount: 2 });
  });
});

describe("M2: price_override kind='expired' (owner §2.4, criteria 15/16)", () => {
  it("writes an expired row carrying no price, chained onto the override it retires", async () => {
    const calculation = await aComputedCalculation();

    const set = await prisma.priceOverride.create({
      data: {
        masterVariantId: calculation.masterVariantId,
        priceCalculationId: calculation.id,
        kind: "set",
        overrideBankPaymentPriceMinorUnits: calculation.bankPaymentPriceMinorUnits + 10_000n,
        currency: calculation.currency,
        breachedFloors: [],
        reason: "test fixture",
        overriddenBy: "staff:test",
      },
    });

    const expired = await prisma.priceOverride.create({
      data: {
        masterVariantId: calculation.masterVariantId,
        kind: "expired",
        supersedesId: set.id,
        currency: calculation.currency,
        breachedFloors: [],
        reason: "material recalculation retired this override",
        overriddenBy: "system",
      },
    });

    expect(expired.overrideBankPaymentPriceMinorUnits).toBeNull();
  });

  it("REFUSES an expired row that carries a price — the coherence CHECK", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      prisma.priceOverride.create({
        data: {
          masterVariantId: calculation.masterVariantId,
          kind: "expired",
          overrideBankPaymentPriceMinorUnits: 100n,
          currency: calculation.currency,
          breachedFloors: [],
          reason: "invalid fixture",
          overriddenBy: "system",
        },
      })
    ).rejects.toThrow(/price_override_kind_bank_payment_price_coherent/);
  });
});

describe("M4: price_recalculation_run.pricing_input_change_id pairing", () => {
  it("REFUSES trigger='input_change' with no pricing_input_change_id", async () => {
    await expect(
      prisma.priceRecalculationRun.create({
        data: { id: randomUUID(), trigger: "input_change", asOf: ASOF },
      })
    ).rejects.toThrow(/price_recalculation_run_input_change_pairing/);
  });

  it("REFUSES a non-input_change trigger that carries a pricing_input_change_id", async () => {
    const change = await prisma.pricingInputChange.create({
      data: { kind: "manual", changedAt: ASOF },
    });

    await expect(
      prisma.priceRecalculationRun.create({
        data: {
          id: randomUUID(),
          trigger: "staff",
          asOf: ASOF,
          pricingInputChangeId: change.id,
        },
      })
    ).rejects.toThrow(/price_recalculation_run_input_change_pairing/);
  });

  it("ALLOWS trigger='input_change' paired with a real pricing_input_change_id", async () => {
    const change = await prisma.pricingInputChange.create({
      data: { kind: "manual", changedAt: ASOF },
    });

    const run = await prisma.priceRecalculationRun.create({
      data: {
        id: randomUUID(),
        trigger: "input_change",
        asOf: ASOF,
        pricingInputChangeId: change.id,
      },
    });

    expect(run.pricingInputChangeId).toBe(change.id);
  });

  it("REFUSES repointing pricing_input_change_id — joins the existing immutable-columns list", async () => {
    // Exercises price_recalculation_run_completion_only's SECOND guard (the
    // "only finished_at and the counts may be updated" branch), which fires
    // regardless of completion state whenever a protected column changes —
    // distinct from its FIRST guard (an already-finished run refusing ANY
    // further update), covered by the next test.
    const change = await prisma.pricingInputChange.create({
      data: { kind: "manual", changedAt: ASOF },
    });
    const otherChange = await prisma.pricingInputChange.create({
      data: { kind: "manual", changedAt: ASOF },
    });

    const run = await prisma.priceRecalculationRun.create({
      data: {
        id: randomUUID(),
        trigger: "input_change",
        asOf: ASOF,
        pricingInputChangeId: change.id,
      },
    });

    await expect(
      prisma.priceRecalculationRun.update({
        where: { id: run.id },
        data: { finishedAt: new Date(), pricingInputChangeId: otherChange.id },
      })
    ).rejects.toThrow(/only finished_at and the counts may be updated/);
  });

  it("REFUSES ANY further update once the run is already finished", async () => {
    const change = await prisma.pricingInputChange.create({
      data: { kind: "manual", changedAt: ASOF },
    });

    const run = await prisma.priceRecalculationRun.create({
      data: {
        id: randomUUID(),
        trigger: "input_change",
        asOf: ASOF,
        pricingInputChangeId: change.id,
      },
    });
    await prisma.priceRecalculationRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date() },
    });

    await expect(
      prisma.priceRecalculationRun.update({
        where: { id: run.id },
        data: { finishedAt: new Date() },
      })
    ).rejects.toThrow(/is already finished and cannot be modified/);
  });
});

describe("M5: price_sync_failure has at most one OPEN episode per variant", () => {
  it("REFUSES a second open episode for the same variant", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    await prisma.priceSyncFailure.create({
      data: {
        masterVariantId,
        firstFailedAt: ASOF,
        lastAttemptAt: ASOF,
        lastError: "Admin API 500",
      },
    });

    // Prisma summarises a unique-index violation (P2002) rather than passing
    // the raw Postgres constraint name through — unlike the CHECK-constraint
    // rejections elsewhere in this file, which do surface their name. Still
    // asserted on the specific field the partial index guards, not a bare
    // `.toThrow()`.
    await expect(
      prisma.priceSyncFailure.create({
        data: {
          masterVariantId,
          firstFailedAt: new Date(),
          lastAttemptAt: new Date(),
          lastError: "Admin API 502",
        },
      })
    ).rejects.toThrow(/Unique constraint failed.*master_variant_id/s);
  });

  it("ALLOWS a new episode once the prior one is resolved", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const first = await prisma.priceSyncFailure.create({
      data: {
        masterVariantId,
        firstFailedAt: ASOF,
        lastAttemptAt: ASOF,
        lastError: "Admin API 500",
      },
    });
    await prisma.priceSyncFailure.update({
      where: { id: first.id },
      data: { resolvedAt: new Date(), alertState: "cleared" },
    });

    await expect(
      prisma.priceSyncFailure.create({
        data: {
          masterVariantId,
          firstFailedAt: new Date(),
          lastAttemptAt: new Date(),
          lastError: "Admin API 502",
        },
      })
    ).resolves.toBeDefined();
  });
});
