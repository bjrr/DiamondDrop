import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { resolveActivePricingProfile } from "~/db/repositories/pricingProfileRepository.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * D14, the owner's standing instruction (2026-09-17):
 *
 *   "Until the tolerance is supplied, the pricing engine may calculate and
 *    display real prices, but automatic Shopify price publication requiring
 *    the tolerance must remain disabled or require manual approval."
 *
 * WHY THIS FILE EXISTS SEPARATELY. Every other integration fixture builds a
 * profile with `autoApplyToleranceBps: 50` so it can exercise the auto-apply
 * path. That left the DISABLED path — the single control between a calculated
 * price and automatic publication — asserted only against the pure function in
 * decideSync.test.ts. A future profile with a number in that column would have
 * switched automatic publication on with no test failing anywhere.
 *
 * These tests assert the control at the two levels the unit test cannot reach:
 * the profile that production actually resolves, and the job end to end.
 */

const ASOF = new Date("2026-09-17T12:00:00Z");

describe("D14 — automatic publication is disabled while the tolerance is unresolved", () => {
  it("the ACTIVE seeded profile carries a null tolerance", async () => {
    // Deliberately resolves the profile the way the job does, rather than
    // reading the row by version. A v3 profile added later with a number in
    // this column would outrank v2 and silently enable automatic publication;
    // this test is what fails on that day.
    const profile = await resolveActivePricingProfile("buy_now", ASOF);

    expect(profile.autoApplyToleranceBps).toBeNull();
    expect(profile.isPlaceholder).toBe(false);
    expect(profile.marginModel).toBe("MARKUP_ON_COST_V1");
  });

  it("queues every price change for manual approval instead of auto-applying", async () => {
    // A real, non-placeholder profile with a null tolerance — the production
    // configuration. Nothing here may reach `auto_apply`.
    const first = await runPriceRecalculation({ asOf: ASOF });
    expect(first.computed).toBeGreaterThan(0);

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: first.runId } },
    });

    expect(intents.length).toBeGreaterThan(0);
    for (const intent of intents) {
      expect(intent.status).toBe("pending_approval");
      expect(intent.decision).toBe("needs_approval");
    }
  });

  it("still refuses to auto-apply on a SECOND run", async () => {
    await runPriceRecalculation({ asOf: ASOF });
    const second = await runPriceRecalculation({
      asOf: new Date("2026-09-18T12:00:00Z"),
    });

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: second.runId } },
    });

    expect(intents.length).toBeGreaterThan(0);
    for (const intent of intents) {
      expect(intent.status).not.toBe("synced");
      expect(intent.decision).not.toBe("auto_apply");
    }
    expect(second.autoApply).toBe(0);
  });

  it("never advances the sync anchor, so no run ever compares against a prior price", async () => {
    // THE NON-OBVIOUS CONSEQUENCE, asserted rather than left implicit.
    //
    // The "last synced price" anchor resolves through a calculation that was
    // actually SYNCED. While publication is disabled nothing ever reaches
    // `synced`, so the anchor stays null and every run — the tenth as much as
    // the first — refuses with "first price for this variant", never with the
    // tolerance reason.
    //
    // This matters for two reasons. It means the tolerance branch is currently
    // unreachable end to end and is covered only by decideSync.test.ts at the
    // unit level, which is a real limit on what this suite proves. And it means
    // the system is fail-closed twice over: even if the NULL tolerance check
    // were removed tomorrow, there would still be no prior price to auto-apply
    // against. If this test ever starts failing, the anchor has begun moving
    // without a sync, which is exactly the defect that made every price look
    // "unchanged, synced" earlier in this slice.
    await runPriceRecalculation({ asOf: ASOF });
    const second = await runPriceRecalculation({ asOf: new Date("2026-09-18T12:00:00Z") });

    const intents = await prisma.priceSyncIntent.findMany({
      where: { priceCalculation: { runId: second.runId } },
    });

    expect(intents.length).toBeGreaterThan(0);
    for (const intent of intents) {
      expect(intent.reason).toMatch(/first price for this variant/);
      expect(intent.previousPriceMinorUnits).toBeNull();
      expect(intent.deltaBps).toBeNull();
    }

    const synced = await prisma.priceSyncIntent.count({ where: { status: "synced" } });
    expect(synced).toBe(0);
  });
});
