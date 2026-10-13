import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  getCalculationFailureStatus,
  isVariantCurrentlyWithdrawn,
  listOpenCalculationFailures,
  recordCalculationFailure,
  recordCalculationSuccess,
} from "~/db/repositories/priceCalculationFailureRepository.server";
import { SUSPENSION_THRESHOLD_MS } from "~/domain/pricing/calculationFailure";

/**
 * Owner §7 (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md).
 *
 * A fresh master_variant per test/scenario — price_calculation_failure
 * permits at most one OPEN episode per variant (partial unique index), and
 * this file wants that isolation guaranteed rather than shared with any
 * other test. Mirrors tests/integration/pricing/syncFailure.test.ts.
 */
async function aFreshMasterVariantId(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);

  const product = await prisma.masterProduct.create({
    data: {
      name: `calculation-failure fixture ${suffix}`,
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

describe("recordCalculationFailure — opening and accumulating an episode", () => {
  it("opens a new episode on the first failure, classified from the error name", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const result = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "No applicable cost_component.setting row effective",
      now: T0,
    });

    expect(result.attemptCount).toBe(1);
    expect(result.newEpisode).toBe(true);
    expect(result.failureType).toBe("missing_cost_input");
    expect(result.newlySuspended).toBe(false);
    expect(result.suspended).toBe(false);

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({
      where: { id: result.failureId },
    });
    expect(row.firstFailedAt).toEqual(T0);
    expect(row.lastAttemptAt).toEqual(T0);
    expect(row.attemptCount).toBe(1);
    expect(row.failureType).toBe("missing_cost_input");
    expect(row.lastError).toBe("No applicable cost_component.setting row effective");
    expect(row.suspendedAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  it("accumulates a second failure onto the SAME episode, not a new one", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const first = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "missing setting cost",
      now: T0,
    });

    const second = await recordCalculationFailure({
      masterVariantId,
      errorName: "InvalidWeightError",
      error: "weight not positive",
      now: at(1),
    });

    expect(second.failureId).toBe(first.failureId);
    expect(second.attemptCount).toBe(2);
    expect(second.newEpisode).toBe(false);
    expect(await prisma.priceCalculationFailure.count({ where: { masterVariantId } })).toBe(1);

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({ where: { id: first.failureId } });
    expect(row.firstFailedAt).toEqual(T0); // unchanged
    expect(row.lastAttemptAt).toEqual(at(1));
    expect(row.lastError).toBe("weight not positive");
    // Reclassified to the LATEST attempt's cause.
    expect(row.failureType).toBe("invalid_weight");
  });
});

describe("recordCalculationFailure — THE 48-HOUR TRAP, exercised against the real database", () => {
  it("does not suspend at 47 hours despite many retries", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });

    for (const hour of [1, 6, 12, 24, 36, 47]) {
      const result = await recordCalculationFailure({
        masterVariantId,
        errorName: "MissingCostInputError",
        error: `e@${hour}`,
        now: at(hour),
      });
      expect(result.suspended).toBe(false);
    }

    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });

  it("SUSPENDS at exactly 48 hours, even though the LAST retry before it was recent — anchored on firstFailedAt, not lastAttemptAt", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });

    for (const hour of [1, 6, 12, 24, 36, 44, 46, 47, 47.9]) {
      const result = await recordCalculationFailure({
        masterVariantId,
        errorName: "MissingCostInputError",
        error: "still failing",
        now: at(hour),
      });
      expect(result.suspended).toBe(false);
    }
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);

    const boundary = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "still failing at the boundary",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });

    expect(boundary.newlySuspended).toBe(true);
    expect(boundary.suspended).toBe(true);
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({
      where: { id: boundary.failureId },
    });
    expect(row.suspendedAt).toEqual(new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS));
  });

  it("does not suspend a single minor-unit-of-time before the boundary", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });

    const justUnder = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS - 1),
    });

    expect(justUnder.suspended).toBe(false);
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
  });

  it("suspendedAt is NEVER reset forward on later retries", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });
    const boundary = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });
    const suspendedAtRow = await prisma.priceCalculationFailure.findUniqueOrThrow({
      where: { id: boundary.failureId },
    });

    const later = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "still failing",
      now: at(60),
    });
    expect(later.newlySuspended).toBe(false);

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({ where: { id: later.failureId } });
    expect(row.suspendedAt).toEqual(suspendedAtRow.suspendedAt);
  });
});

describe("recordCalculationSuccess — owner §7 recovery, no human action beyond the fix", () => {
  it("requires a trigger/actor before touching the database", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    await expect(
      recordCalculationSuccess({ masterVariantId, trigger: "" })
    ).rejects.toThrow(/trigger/i);
    await expect(
      recordCalculationSuccess({ masterVariantId, trigger: "   " })
    ).rejects.toThrow(/trigger/i);
  });

  it("is a no-op when there is no open episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const result = await recordCalculationSuccess({ masterVariantId, trigger: "scheduled" });
    expect(result.restored).toBe(false);
  });

  it("resolves an open (unsuspended) episode and records the trigger", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });

    const result = await recordCalculationSuccess({
      masterVariantId,
      trigger: "scheduled",
      now: at(1),
    });
    expect(result.restored).toBe(true);
    expect(result.failureId).toBe(failure.failureId);

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(row.resolvedAt).toEqual(at(1));
    expect(row.resolvedTrigger).toBe("scheduled");
  });

  it("restores a SUSPENDED variant with NO manual re-enable step, and never nulls suspendedAt", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });
    const boundary = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });
    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(true);

    await recordCalculationSuccess({ masterVariantId, trigger: "staff:alex", now: at(49) });

    expect(await isVariantCurrentlyWithdrawn(masterVariantId)).toBe(false);
    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({
      where: { id: boundary.failureId },
    });
    expect(row.suspendedAt).not.toBeNull(); // history preserved, never nulled
    expect(row.resolvedAt).toEqual(at(49));
    expect(row.resolvedTrigger).toBe("staff:alex");
  });

  it("a NEW failure after resolution opens a FRESH episode, not the closed one", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const closed = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });
    await recordCalculationSuccess({ masterVariantId, trigger: "scheduled", now: at(1) });

    const reopened = await recordCalculationFailure({
      masterVariantId,
      errorName: "InvalidBandError",
      error: "failing again",
      now: at(10),
    });

    expect(reopened.failureId).not.toBe(closed.failureId);
    expect(reopened.attemptCount).toBe(1);
    expect(reopened.newEpisode).toBe(true);
    expect(await prisma.priceCalculationFailure.count({ where: { masterVariantId } })).toBe(2);
  });
});

describe("getCalculationFailureStatus / listOpenCalculationFailures — admin visibility", () => {
  it("returns null for a variant with no failure history at all", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    expect(await getCalculationFailureStatus(masterVariantId)).toBeNull();
  });

  it("reports first-failure timestamp, cause, and time remaining before suspension", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "UnreachableMarginError",
      error: "denominator not positive",
      now: T0,
    });

    const status = await getCalculationFailureStatus(masterVariantId, at(10));
    expect(status).not.toBeNull();
    expect(status!.failureType).toBe("margin_unreachable");
    expect(status!.firstFailedAt).toEqual(T0);
    expect(status!.withdrawn).toBe(false);
    expect(status!.resolvedAt).toBeNull();
    expect(status!.timeRemainingBeforeSuspensionMs).toBe(SUSPENSION_THRESHOLD_MS - 10 * HOUR_MS);
  });

  it("reports withdrawn=true and zero time remaining once suspended", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: new Date(T0.getTime() + SUSPENSION_THRESHOLD_MS),
    });

    const status = await getCalculationFailureStatus(masterVariantId, at(60));
    expect(status!.withdrawn).toBe(true);
    expect(status!.timeRemainingBeforeSuspensionMs).toBe(0);
  });

  it("listOpenCalculationFailures lists only unresolved episodes, oldest first", async () => {
    const earlier = await aFreshMasterVariantId();
    const later = await aFreshMasterVariantId();
    const resolved = await aFreshMasterVariantId();

    await recordCalculationFailure({
      masterVariantId: earlier,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });
    await recordCalculationFailure({
      masterVariantId: later,
      errorName: "InvalidSizeError",
      error: "e",
      now: at(5),
    });
    await recordCalculationFailure({
      masterVariantId: resolved,
      errorName: "InvalidWeightError",
      error: "e",
      now: at(1),
    });
    await recordCalculationSuccess({ masterVariantId: resolved, trigger: "scheduled", now: at(2) });

    const open = await listOpenCalculationFailures(at(6));
    const openVariantIds = open.map((o) => o.masterVariantId);

    expect(openVariantIds).toContain(earlier);
    expect(openVariantIds).toContain(later);
    expect(openVariantIds).not.toContain(resolved);

    const earlierIndex = openVariantIds.indexOf(earlier);
    const laterIndex = openVariantIds.indexOf(later);
    expect(earlierIndex).toBeLessThan(laterIndex);
  });
});

describe("the partial unique index and concurrency safety", () => {
  it("refuses two open episodes for the same variant at the DATABASE, proven against a raw insert", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });

    await expect(
      prisma.priceCalculationFailure.create({
        data: {
          masterVariantId,
          firstFailedAt: at(1),
          lastAttemptAt: at(1),
          attemptCount: 1,
          failureType: "invalid_weight",
          lastError: "a second, forked episode",
        },
      })
    ).rejects.toThrow(/Unique constraint failed.*master_variant_id/s);
  });

  it("recordCalculationFailure is race-safe: two concurrent FIRST failures for the same variant open exactly one episode", async () => {
    const masterVariantId = await aFreshMasterVariantId();

    const [a, b] = await Promise.all([
      recordCalculationFailure({
        masterVariantId,
        errorName: "MissingCostInputError",
        error: "race A",
        now: T0,
      }),
      recordCalculationFailure({
        masterVariantId,
        errorName: "InvalidWeightError",
        error: "race B",
        now: T0,
      }),
    ]);

    expect(a.failureId).toBe(b.failureId);
    expect(await prisma.priceCalculationFailure.count({ where: { masterVariantId } })).toBe(1);

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({ where: { id: a.failureId } });
    // Order between concurrent callers is not guaranteed, but exactly one
    // episode with exactly two recorded attempts is.
    expect(row.attemptCount).toBe(2);
  });
});

describe("the calculation_failure table has no alert_state/dismiss columns", () => {
  it("the Prisma row shape has no dismiss-related fields — there is no alert to dismiss for this failure mode", async () => {
    const masterVariantId = await aFreshMasterVariantId();
    const failure = await recordCalculationFailure({
      masterVariantId,
      errorName: "MissingCostInputError",
      error: "e",
      now: T0,
    });

    const row = await prisma.priceCalculationFailure.findUniqueOrThrow({ where: { id: failure.failureId } });
    expect(Object.prototype.hasOwnProperty.call(row, "alertState")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "dismissedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "dismissedBy")).toBe(false);
  });
});
