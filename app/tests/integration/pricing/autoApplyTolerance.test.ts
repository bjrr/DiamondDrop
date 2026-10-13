import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { resolveActivePricingProfile } from "~/db/repositories/pricingProfileRepository.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * D14, owner-resolved 2026-09-17: the auto-apply tolerance is 200 bps (2%).
 * A recalculated price within 2% of the last PUBLISHED price may apply
 * automatically; anything larger waits for a human.
 *
 * WHY THIS FILE EXISTS. Every other integration fixture builds its own profile
 * with its own tolerance, so none of them pins the number production actually
 * uses. A v4 profile created later with a different tolerance would change how
 * freely prices publish themselves, and without this test nothing would fail.
 *
 * UPDATED AT SLICE 2 T1 (F-26/F-27/C-S2 closed): a real Shopify sync port and
 * an auto-publish path now exist (`app/jobs/pricing/syncApprovedIntent.server.ts`,
 * wired into `runPriceRecalculation` behind `PRICE_AUTO_PUBLISH_ENABLED`,
 * default OFF). This file's own calls never pass a port or enable
 * auto-publish, so for THEM the tolerance comparison still cannot reach
 * `synced` end to end — that reachable-with-a-real-anchor case is covered by
 * `syncApprovedIntent.test.ts` and `autoPublishWiring.test.ts` instead. Every
 * assertion below is scoped to this file's own runIds rather than to
 * database-wide counts, because the database is no longer a place where
 * `synced` never legitimately appears — it shares one disposable instance
 * with every other integration test file in the run (see
 * `tests/integration/globalSetup.ts`), and those other files correctly
 * create synced intents as part of testing that this file does not own.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");

/**
 * ============================================================================
 * THESE RUNS ARE SCOPED TO THIS FILE'S OWN VARIANT, AND THAT IS A FIX
 * ============================================================================
 * Every job call below used to run UNSCOPED, which sweeps every active variant
 * in the shared integration database. Two real consequences:
 *
 *   CORRECTNESS. The assertions iterate every intent the run produced, so they
 *   asserted a property of the WHOLE database rather than of this file's
 *   fixture. One already-priced variant left active by another file turns
 *   "first price for this variant" into "change of N bps" and the anchor
 *   non-null. Scoping the QUERY by runId did not help, because those other
 *   variants genuinely were part of the run.
 *
 *   DURATION. Measured on a clean local run, 2026-10-10: two of these tests
 *   took 42.4s and 42.1s against a 45s budget — 94% of it — with cost growing
 *   as the suite grows rather than with anything they assert. Under concurrent
 *   load they crossed the line and timed out. Raising the budget would have
 *   hidden a test whose cost is proportional to the rest of the suite.
 *
 * So each call passes `variantIds`. The production invariant is unchanged — a
 * first-ever price still routes to a human, nothing is ever marked synced, the
 * anchor never advances — it is simply measured against a fixture this file
 * owns.
 *
 * `priceableVariant` mirrors `autoPublishWiring.test.ts`'s helper: the same
 * gold/GOLD_14K/india combination resolvable from globally seeded cost data,
 * with no bands and no stones so the engine takes the single-price path.
 */
const createdVariantIds: string[] = [];

afterEach(async () => {
  if (createdVariantIds.length === 0) return;
  // ARCHIVED, not deleted. `price_calculation` is append-only so rows
  // referencing this variant cannot be removed — and archiving is what takes
  // it out of `where: { status: "active" }` for files that run later, which is
  // the courtesy this file was not previously extending to others.
  await prisma.masterVariant.updateMany({
    where: { id: { in: createdVariantIds } },
    data: { status: "archived" },
  });
  createdVariantIds.length = 0;
});

async function priceableVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `auto-apply-tolerance fixture ${suffix}`,
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

describe("D14 — the auto-apply tolerance the job actually resolves", () => {
  it("the ACTIVE profile carries the owner's 200 bps", async () => {
    // Resolved the way the job resolves it, NOT read by version. A later
    // profile with a different tolerance would outrank this one, and that is
    // exactly the change this test exists to catch.
    const profile = await resolveActivePricingProfile("buy_now", ASOF);

    expect(profile.autoApplyToleranceBps).toBe(200);
    expect(profile.isPlaceholder).toBe(false);
    expect(profile.marginModel).toBe("MARKUP_ON_COST_V1");
  });

  it("the ACTIVE profile carries the TIERED card rule, not the superseded one", async () => {
    // The switch from the fixed 5% uplift to the tiered schedule is an
    // effective-dated profile version, not an edit. This asserts that the
    // resolution actually picks up v4 — the first run of that change left v4
    // dated later than these fixtures, so everything still resolved v3 and the
    // suite passed while testing the superseded rule.
    const profile = await resolveActivePricingProfile("buy_now", ASOF);

    expect(profile.regularCardPriceRuleId).toBe("BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1");

    // Carried forward and NOT read by the tiered rule. Asserted so that its
    // continued presence is a recorded decision rather than an oversight.
    expect(profile.fixedCardUpliftRate).toBe("0.05");
  });

  it("still routes a first-ever price to a human, tolerance or not", async () => {
    // A tolerance governs how far a price may MOVE. With no prior published
    // price there is nothing to measure against, so a first price is always a
    // human decision — that is independent of the number being 200 or 20000.
    const variant = await priceableVariant();
    const run = await runPriceRecalculation({ asOf: ASOF, variantIds: [variant.id] });
    expect(run.computed).toBe(1);

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: run.runId } },
    });

    // Exactly one, because the run was scoped to one variant. `toHaveLength(1)`
    // rather than `toBeGreaterThan(0)`: the weaker assertion is what let an
    // unscoped run look correct while actually measuring the whole database.
    expect(intents).toHaveLength(1);
    for (const intent of intents) {
      expect(intent.status).toBe("pending_approval");
      expect(intent.reason).toMatch(/first price for this variant/);
    }
  });

  it("never marks anything SYNCED, because nothing was told to publish", async () => {
    // The honest-claim guarantee, and the most important assertion in this file.
    // Supplying a tolerance cleared prices for publication; it did not publish
    // them by itself. Slice 2 T1 gave `runPriceRecalculation` a REAL sync port
    // and an auto-publish path (spec §4.1 criteria 8-9), so a `synced` row
    // elsewhere in this database is no longer evidence of anything wrong — it
    // is what a variant with auto-publish genuinely enabled correctly looks
    // like, exercised by its own suite (`syncApprovedIntent.test.ts`,
    // `autoPublishWiring.test.ts`). What THIS test still must prove is
    // narrower and still true: calling `runPriceRecalculation` with NEITHER a
    // port NOR autoPublishEnabled — this file's calls, and D15's daily
    // scheduled default — never syncs or claims to have synced ANY of the
    // variants THESE TWO CALLS priced. Scoped to their own runIds, not a
    // database-wide count, which would otherwise depend on what unrelated
    // fixtures elsewhere in the shared integration database happen to contain.
    const variant = await priceableVariant();
    const first = await runPriceRecalculation({ asOf: ASOF, variantIds: [variant.id] });
    const second = await runPriceRecalculation({
      asOf: new Date("2026-09-19T12:00:00Z"),
      variantIds: [variant.id],
    });

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: { in: [first.runId, second.runId] } } },
    });
    expect(intents).toHaveLength(2);
    for (const intent of intents) {
      expect(intent.status).not.toBe("synced");
      expect(intent.syncedAt).toBeNull();
    }
  });

  it("never advances the sync anchor while nothing syncs", async () => {
    // The consequence of the above: the anchor resolves through a calculation
    // that was actually synced, so it stays null and every run refuses with
    // "first price". If this ever starts failing, the anchor has begun moving
    // without a sync — which is the defect that made every price look
    // "unchanged, synced" earlier in this slice.
    const variant = await priceableVariant();
    await runPriceRecalculation({ asOf: ASOF, variantIds: [variant.id] });
    const second = await runPriceRecalculation({
      asOf: new Date("2026-09-19T12:00:00Z"),
      variantIds: [variant.id],
    });

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: second.runId } },
    });

    expect(intents).toHaveLength(1);
    for (const intent of intents) {
      expect(intent.previousBankPaymentPriceMinorUnits).toBeNull();
      expect(intent.deltaBps).toBeNull();
      expect(intent.deltaMinorUnits).toBeNull();
    }
    expect(second.autoApply).toBe(0);
  });
});
