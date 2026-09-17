import { describe, expect, it } from "vitest";

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
 * WHAT THIS SUITE CANNOT PROVE, stated plainly. The tolerance comparison needs
 * a prior SYNCED price, and nothing ever reaches `synced` because no Shopify
 * sync port exists yet (D1 is open). So the comparison branch is unreachable
 * end to end and is covered only by decideSync.test.ts at the unit level. That
 * is a real limit, not an oversight, and these tests assert the reachable
 * consequences rather than pretending otherwise.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");

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

  it("the ACTIVE profile carries the owner's 5% card uplift", async () => {
    const profile = await resolveActivePricingProfile("buy_now", ASOF);

    expect(profile.cardUpliftRate).toBe("0.05");
    expect(profile.cardPriceRuleId).toBe("CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1");
  });

  it("still routes a first-ever price to a human, tolerance or not", async () => {
    // A tolerance governs how far a price may MOVE. With no prior published
    // price there is nothing to measure against, so a first price is always a
    // human decision — that is independent of the number being 200 or 20000.
    const run = await runPriceRecalculation({ asOf: ASOF });
    expect(run.computed).toBeGreaterThan(0);

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: run.runId } },
    });

    expect(intents.length).toBeGreaterThan(0);
    for (const intent of intents) {
      expect(intent.status).toBe("pending_approval");
      expect(intent.reason).toMatch(/first price for this variant/);
    }
  });

  it("never marks anything SYNCED, because nothing has been published", async () => {
    // The honest-claim guarantee, and the most important assertion in this file.
    // Supplying a tolerance cleared prices for publication; it did not publish
    // them, and no Shopify port exists to do so. A `synced` row would be a
    // claim that a price reached Shopify — the exact fabrication that had to be
    // fixed earlier in this slice.
    await runPriceRecalculation({ asOf: ASOF });
    await runPriceRecalculation({ asOf: new Date("2026-09-19T12:00:00Z") });

    expect(await prisma.priceSyncIntent.count({ where: { status: "synced" } })).toBe(0);
    expect(await prisma.priceSyncIntent.count({ where: { syncedAt: { not: null } } })).toBe(0);
  });

  it("never advances the sync anchor while nothing syncs", async () => {
    // The consequence of the above: the anchor resolves through a calculation
    // that was actually synced, so it stays null and every run refuses with
    // "first price". If this ever starts failing, the anchor has begun moving
    // without a sync — which is the defect that made every price look
    // "unchanged, synced" earlier in this slice.
    await runPriceRecalculation({ asOf: ASOF });
    const second = await runPriceRecalculation({ asOf: new Date("2026-09-19T12:00:00Z") });

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: second.runId } },
    });

    expect(intents.length).toBeGreaterThan(0);
    for (const intent of intents) {
      expect(intent.previousPriceMinorUnits).toBeNull();
      expect(intent.deltaBps).toBeNull();
      expect(intent.deltaMinorUnits).toBeNull();
    }
    expect(second.autoApply).toBe(0);
  });
});
