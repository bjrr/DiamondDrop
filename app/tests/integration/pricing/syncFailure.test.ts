import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  dismissSyncFailureAlert,
  isVariantCurrentlyWithdrawn,
  recordSyncFailure,
  recordSyncSuccess,
} from "~/db/repositories/priceSyncFailureRepository.server";
import { SUSPENSION_THRESHOLD_MS } from "~/domain/pricing/syncFailure";

/**
 * Owner §4, spec criteria 20-27, ruling R2 (§16.5).
 *
 * A fresh master_variant per test/scenario — price_sync_failure permits at
 * most one OPEN episode per variant (partial unique index), and this file
 * wants that isolation guaranteed rather than shared with any other test.
 */
async function aFreshMasterVariantId(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);

  const product = await prisma.masterProduct.create({
    data: {
      name: `sync-failure fixture ${suffix}`,
      category: "ring",
      sizeAxis: "ring_size_us",
      allowedSizeMin: "2",
      allowedSizeMax: "11",
      sizeIncrement: "0.5",
      baseSize: "6",
      offeredMetals: ["gold"],
      status: "active",
    },
  });

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: "active",
      laborSource: "india",
    },
  });

  return variant.id;
}

const T0 = new Date("2026-09-19T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR_MS);

describe("recordSyncFailure — opening and accumulating an episode", () => {
  it("opens a new episode on the first failure", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const result = await recordSyncFailure({ masterVariantId, error: "Admin API 500", now: T0 });

    expect(result.attemptCount).toBe(1);
    expect(result.newlySuspended).toBe(false);
    expect(result.suspended).toBe(false);

    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: result.failureId } });
    expect(row.firstFailedAt).toEqual(T0);
    expect(row.lastAttemptAt).toEqual(T0);
    expect(row.attemptCount).toBe(1);
    expect(row.lastError).toBe("Admin API 500");
    expect(row.alertState).toBe("active");
    expect(row.suspendedAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it("accumulates a second failure onto the SAME episode, not a new one", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const first = await recordSyncFailure({ masterVariantId, error: "Admin API 500", now: T0 });

    const second = await recordSyncFailure({
      masterVariantId,
      error: "Admin API 503",
      now: at(1),
    });

    expect(second.failureId).toBe(first.failureId);
    expect(second.attemptCount).toBe(2);
    expect(await prisma.priceSyncFailure.count({ where: { masterVariantId } })).toBe(1);

    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: first.failureId } });
    expect(row.firstFailedAt).toEqual(T0); // unchanged
    expect(row.lastAttemptAt).toEqual(at(1));
    expect(row.lastError).toBe("Admin API 503");
  });
});

describe("recordSyncFailure — THE 48-HOUR TRAP, exercised against the real database", () => {
  it("does not suspend at 47 hours despite many retries", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });

    for (const hour of [1, 6, 12, 24, 36, 47]) {
      const result = await recordSyncFailure({ masterVariantId, error: `e@${hour}`, now: at(hour) });
      expect(result.suspended).toBe(false);
    }

    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });

  it("SUSPENDS at exactly 48 hours, even though the LAST retry before it was recent — anchored on firstFailedAt, not lastAttemptAt", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });

    // A long run of FREQUENT retries — the last one only 6 minutes before
    // the 48h mark. If suspension were anchored on lastAttemptAt (the trap),
    // this would never suspend.
    for (const hour of [1, 6, 12, 24, 36, 44, 46, 47, 47.9]) {
      const result = await recordSyncFailure({ masterVariantId, error: "still failing", now: at(hour) });
      expect(result.suspended).toBe(false);
    }
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);

    const boundary = await recordSyncFailure({
      masterVariantId,
      error: "still failing at the boundary",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });

    expect(boundary.newlySuspended).toBe(true);
    expect(boundary.suspended).toBe(true);
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: boundary.failureId } });
    expect(row.suspendedAt).toEqual(new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS));
  });

  it("does not suspend a single minor-unit-of-time before the boundary", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });

    const justUnder = await recordSyncFailure({
      masterVariantId,
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS - 1),
    });

    expect(justUnder.suspended).toBe(false);
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });

  it("suspendedAt is NEVER reset forward on later retries (R4)", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });
    const boundary = await recordSyncFailure({
      masterVariantId,
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });
    const suspendedAtRow = await prisma.priceSyncFailure.findUniqueOrThrow({
      where: { id: boundary.failureId },
    });

    const later = await recordSyncFailure({ masterVariantId, error: "still failing", now: at(60) });
    expect(later.newlySuspended).toBe(false);

    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: later.failureId } });
    expect(row.suspendedAt).toEqual(suspendedAtRow.suspendedAt);
  });
});

describe("recordSyncSuccess — criterion 25, restoration with no human action", () => {
  it("is a no-op when there is no open episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const result = await recordSyncSuccess({ masterVariantId });
    expect(result.restored).toBe(false);
  });

  it("resolves an open (unsuspended) episode and clears the alert", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordSyncFailure({ masterVariantId, error: "e", now: T0 });

    const result = await recordSyncSuccess({ masterVariantId, now: at(1) });
    expect(result.restored).toBe(true);
    expect(result.failureId).toBe(failure.failureId);

    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(row.resolvedAt).toEqual(at(1));
    expect(row.alertState).toBe("cleared");
  });

  it("restores a SUSPENDED variant with NO human action, and never nulls suspendedAt (R4)", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });
    const boundary = await recordSyncFailure({
      masterVariantId,
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    await recordSyncSuccess({ masterVariantId, now: at(49) });

    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: boundary.failureId } });
    expect(row.suspendedAt).not.toBeNull(); // R4: history preserved, never nulled
    expect(row.resolvedAt).toEqual(at(49));
    expect(row.alertState).toBe("cleared");
  });

  it("a NEW failure after resolution opens a FRESH episode, not the closed one", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const closed = await recordSyncFailure({ masterVariantId, error: "e", now: T0 });
    await recordSyncSuccess({ masterVariantId, now: at(1) });

    const reopened = await recordSyncFailure({ masterVariantId, error: "failing again", now: at(10) });

    expect(reopened.failureId).not.toBe(closed.failureId);
    expect(reopened.attemptCount).toBe(1);
    expect(await prisma.priceSyncFailure.count({ where: { masterVariantId } })).toBe(2);
  });
});

describe("dismissSyncFailureAlert — owner §4.3, R2's central guarantee", () => {
  it("requires an actor and a reason before touching the database", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    await expect(
      dismissSyncFailureAlert({ masterVariantId, actor: "", reason: "known issue" })
    ).rejects.toThrow(/actor/i);
    await expect(
      dismissSyncFailureAlert({ masterVariantId, actor: "staff:alex", reason: "" })
    ).rejects.toThrow(/reason/i);
  });

  it("is a no-op when there is no open episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const result = await dismissSyncFailureAlert({
      masterVariantId,
      actor: "staff:alex",
      reason: "nothing to dismiss",
    });
    expect(result.dismissed).toBe(false);
  });

  it("records the actor and reason, and sets alertState to dismissed", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordSyncFailure({ masterVariantId, error: "e", now: T0 });

    const result = await dismissSyncFailureAlert({
      masterVariantId,
      actor: "staff:alex",
      reason: "tracked in the incident channel",
      now: at(1),
    });

    expect(result.dismissed).toBe(true);
    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(row.alertState).toBe("dismissed");
    expect(row.dismissedBy).toBe("staff:alex");
    expect(row.dismissedReason).toBe("tracked in the incident channel");
    expect(row.dismissedAt).toEqual(at(1));
  });

  it("R2 — THE CENTRAL GUARANTEE: dismissing a SUSPENDED variant's alert does NOT lift the suspension", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });
    await recordSyncFailure({
      masterVariantId,
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    await dismissSyncFailureAlert({
      masterVariantId,
      actor: "staff:alex",
      reason: "silencing the pager, investigating separately",
      now: at(49),
    });

    // A human clicking "dismiss" must not be able to put an unpublishable
    // price back on sale.
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    const row = await prisma.priceSyncFailure.findFirstOrThrow({
      where: { masterVariantId, resolvedAt: null },
    });
    expect(row.alertState).toBe("dismissed");
    expect(row.resolvedAt).toBeNull();
    expect(row.suspendedAt).not.toBeNull();
  });

  it("a genuine success still restores availability after a dismissal", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });
    await recordSyncFailure({
      masterVariantId,
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });
    await dismissSyncFailureAlert({
      masterVariantId,
      actor: "staff:alex",
      reason: "silencing while investigating",
      now: at(49),
    });
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    await recordSyncSuccess({ masterVariantId, now: at(50) });

    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });
});

describe("isVariantCurrentlyWithdrawn — R2, the ONLY availability predicate", () => {
  it("is false for a variant with no failure history at all", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });

  it("is false for an unsuspended, active failure episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });
});

describe("the partial unique index and concurrency safety", () => {
  it("refuses two open episodes for the same variant at the DATABASE, proven against a raw insert", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordSyncFailure({ masterVariantId, error: "e", now: T0 });

    await expect(
      prisma.priceSyncFailure.create({
        data: {
          masterVariantId,
          firstFailedAt: at(1),
          lastAttemptAt: at(1),
          attemptCount: 1,
          lastError: "a second, forked episode",
        },
      })
    // Prisma summarises a unique-index violation (P2002) rather than passing
    // the raw Postgres constraint name through — same as the equivalent
    // assertion in slice2SchemaGuards.test.ts. Asserted on the specific
    // field the partial index guards, not a bare `.toThrow()`.
    ).rejects.toThrow(/Unique constraint failed.*master_variant_id/s);
  });

  it("recordSyncFailure is race-safe: two concurrent FIRST failures for the same variant open exactly one episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const [a, b] = await Promise.all([
      recordSyncFailure({ masterVariantId, error: "race A", now: T0 }),
      recordSyncFailure({ masterVariantId, error: "race B", now: T0 }),
    ]);

    // Neither call threw — the loser's P2002 was caught and reinterpreted as
    // a retry against the winner's episode.
    expect(a.failureId).toBe(b.failureId);
    expect(await prisma.priceSyncFailure.count({ where: { masterVariantId } })).toBe(1);

    const row = await prisma.priceSyncFailure.findUniqueOrThrow({ where: { id: a.failureId } });
    // One of the two attempts became attempt 1, the other attempt 2 — order
    // between concurrent callers is not guaranteed, but exactly one episode
    // with exactly two recorded attempts is.
    expect(row.attemptCount).toBe(2);
  });
});
