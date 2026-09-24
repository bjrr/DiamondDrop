import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  getOpenLuxuryStealSyncFailure,
  listOpenLuxuryStealSyncFailures,
  recordLuxuryStealSyncFailure,
  recordLuxuryStealSyncSuccess,
} from "~/db/repositories/luxuryStealSyncFailureRepository.server";

/**
 * Slice 3 task 3-2b, criterion 152 — the failure-episode repository against
 * a real database. Money-critical/evidence-critical per the assigning
 * message: "a failed sync is recorded durably and does NOT change
 * purchasability" is asserted directly here at the persistence layer, and
 * again at the job layer in syncAssignment.test.ts.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

async function aFreshMasterVariantId(): Promise<string> {
  const product = await prisma.masterProduct.create({
    data: {
      name: `luxury-steal sync-failure fixture ${uniq()}`,
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
  return variant.id;
}

const T0 = new Date("2026-09-24T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR_MS);

describe("recordLuxuryStealSyncFailure — opening and accumulating an episode", () => {
  it("opens a new episode on the first failure", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const result = await recordLuxuryStealSyncFailure({
      masterVariantId,
      error: "Shopify Admin API metafieldsSet failed: userErrors present",
      now: T0,
    });

    expect(result.attemptCount).toBe(1);
    expect(result.newEpisode).toBe(true);

    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: result.failureId } });
    expect(row.firstFailedAt).toEqual(T0);
    expect(row.lastAttemptAt).toEqual(T0);
    expect(row.attemptCount).toBe(1);
    expect(row.resolvedAt).toBeNull();
  });

  it("accumulates a second failure onto the SAME episode, not a new one", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const first = await recordLuxuryStealSyncFailure({ masterVariantId, error: "first", now: T0 });
    const second = await recordLuxuryStealSyncFailure({ masterVariantId, error: "second", now: at(1) });

    expect(second.failureId).toBe(first.failureId);
    expect(second.attemptCount).toBe(2);
    expect(second.newEpisode).toBe(false);
    expect(await prisma.luxuryStealSyncFailure.count({ where: { masterVariantId } })).toBe(1);

    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: first.failureId } });
    expect(row.firstFailedAt).toEqual(T0); // unchanged
    expect(row.lastAttemptAt).toEqual(at(1));
    expect(row.lastError).toBe("second");
  });

  it("keeps accumulating well past 48 hours — criterion 152: no suspension timer exists here at all", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });

    const farPast48h = await recordLuxuryStealSyncFailure({
      masterVariantId,
      error: "still failing",
      now: at(200),
    });

    expect(farPast48h.attemptCount).toBe(2);
    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: farPast48h.failureId } });
    expect(row.resolvedAt).toBeNull();
  });
});

describe("recordLuxuryStealSyncSuccess — resolving an episode", () => {
  it("requires a trigger before touching the database", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await expect(recordLuxuryStealSyncSuccess({ masterVariantId, trigger: "" })).rejects.toThrow(/trigger/i);
    await expect(recordLuxuryStealSyncSuccess({ masterVariantId, trigger: "   " })).rejects.toThrow(/trigger/i);
  });

  it("is a no-op when there is no open episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const result = await recordLuxuryStealSyncSuccess({ masterVariantId, trigger: "automatic-retry" });
    expect(result.restored).toBe(false);
  });

  it("resolves an open episode and records the trigger — 'automatic-retry' for the write-time retry", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });

    const result = await recordLuxuryStealSyncSuccess({
      masterVariantId,
      trigger: "automatic-retry",
      now: at(1),
    });
    expect(result.restored).toBe(true);
    expect(result.failureId).toBe(failure.failureId);

    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(row.resolvedAt).toEqual(at(1));
    expect(row.resolvedTrigger).toBe("automatic-retry");
  });

  it("records a staff-attributed trigger for a manual admin retry", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });

    await recordLuxuryStealSyncSuccess({ masterVariantId, trigger: "staff:123456", now: at(3) });

    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(row.resolvedTrigger).toBe("staff:123456");
  });

  it("a NEW failure after resolution opens a FRESH episode, not the closed one", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const closed = await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });
    await recordLuxuryStealSyncSuccess({ masterVariantId, trigger: "automatic-retry", now: at(1) });

    const reopened = await recordLuxuryStealSyncFailure({ masterVariantId, error: "failing again", now: at(10) });

    expect(reopened.failureId).not.toBe(closed.failureId);
    expect(reopened.attemptCount).toBe(1);
    expect(reopened.newEpisode).toBe(true);
    expect(await prisma.luxuryStealSyncFailure.count({ where: { masterVariantId } })).toBe(2);
  });
});

describe("getOpenLuxuryStealSyncFailure / listOpenLuxuryStealSyncFailures — admin visibility", () => {
  it("returns null for a variant with no failure history", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    expect(await getOpenLuxuryStealSyncFailure(masterVariantId)).toBeNull();
  });

  it("returns the open episode for a failing variant", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordLuxuryStealSyncFailure({ masterVariantId, error: "boom", now: T0 });

    const status = await getOpenLuxuryStealSyncFailure(masterVariantId);
    expect(status?.masterVariantId).toBe(masterVariantId);
    expect(status?.lastError).toBe("boom");
    expect(status?.resolvedAt).toBeNull();
  });

  it("lists only unresolved episodes, oldest first", async () => {
    const earlier = await aFreshMasterVariantId();
    const later = await aFreshMasterVariantId();
    const resolved = await aFreshMasterVariantId();

    await recordLuxuryStealSyncFailure({ masterVariantId: earlier, error: "e", now: T0 });
    await recordLuxuryStealSyncFailure({ masterVariantId: later, error: "e", now: at(5) });
    await recordLuxuryStealSyncFailure({ masterVariantId: resolved, error: "e", now: at(1) });
    await recordLuxuryStealSyncSuccess({ masterVariantId: resolved, trigger: "automatic-retry", now: at(2) });

    const open = await listOpenLuxuryStealSyncFailures();
    const openVariantIds = open.map((o) => o.masterVariantId);

    expect(openVariantIds).toContain(earlier);
    expect(openVariantIds).toContain(later);
    expect(openVariantIds).not.toContain(resolved);
    expect(openVariantIds.indexOf(earlier)).toBeLessThan(openVariantIds.indexOf(later));
  });
});

describe("the partial unique index and concurrency safety", () => {
  it("refuses two open episodes for the same variant at the DATABASE", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });

    await expect(
      prisma.luxuryStealSyncFailure.create({
        data: {
          masterVariantId,
          firstFailedAt: at(1),
          lastAttemptAt: at(1),
          attemptCount: 1,
          lastError: "a second, forked episode",
        },
      })
    ).rejects.toThrow(/Unique constraint failed.*master_variant_id/s);
  });

  it("recordLuxuryStealSyncFailure is race-safe: two concurrent FIRST failures open exactly one episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const [a, b] = await Promise.all([
      recordLuxuryStealSyncFailure({ masterVariantId, error: "race A", now: T0 }),
      recordLuxuryStealSyncFailure({ masterVariantId, error: "race B", now: T0 }),
    ]);

    expect(a.failureId).toBe(b.failureId);
    expect(await prisma.luxuryStealSyncFailure.count({ where: { masterVariantId } })).toBe(1);

    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: a.failureId } });
    expect(row.attemptCount).toBe(2);
  });
});

describe("criterion 152 — the table itself has no purchasability-affecting columns", () => {
  it("the Prisma row shape has no suspendedAt/alertState/dismiss fields at all", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });

    const row = await prisma.luxuryStealSyncFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(Object.prototype.hasOwnProperty.call(row, "suspendedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "alertState")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "dismissedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "dismissedBy")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "dismissedReason")).toBe(false);
  });

  it("a failure episode never touches master_variant — the variant row is unchanged by a failing sync", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const before = await prisma.masterVariant.findUniqueOrThrow({ where: { id: masterVariantId } });

    await recordLuxuryStealSyncFailure({ masterVariantId, error: "e", now: T0 });
    await recordLuxuryStealSyncFailure({ masterVariantId, error: "e again", now: at(500) });

    const after = await prisma.masterVariant.findUniqueOrThrow({ where: { id: masterVariantId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.status).toBe(before.status);
  });
});

describe("evidence-only — no dismiss workflow exists for this failure mode", () => {
  it("no dismiss function is exported from the repository module", async () => {
    const repository = await import("~/db/repositories/luxuryStealSyncFailureRepository.server");
    expect((repository as Record<string, unknown>).dismissSyncFailureAlert).toBeUndefined();
  });

  it("returns null for a fully random, never-seen variant id", async () => {
    expect(await getOpenLuxuryStealSyncFailure(randomUUID())).toBeNull();
  });
});
