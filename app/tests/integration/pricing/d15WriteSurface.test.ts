import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { MissingTriggerActorError, runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * D15 (owner-directed 2026-09-17), the load-bearing sentence:
 *
 *   "Historical Group Buy frozen prices must NEVER be modified by a Buy Now
 *    recalculation job."
 *
 * HOW THIS IS TESTED, AND WHY THIS WAY. Group Buy tables do not exist yet
 * (Slice 2), so a test asserting "the group_buy_price table was untouched"
 * would pass trivially today and would still pass on the day someone adds a
 * Group Buy write to this job — the exact day it needs to fail.
 *
 * So instead of naming the tables the job must not write, this records the
 * tables it DOES write and pins that set. Any new write target — Group Buy
 * frozen prices included — fails this test and has to be justified by editing
 * the allowlist below. That turns a guarantee about a table which does not yet
 * exist into a guarantee that holds the moment it does.
 */

const ALLOWED_WRITE_MODELS = new Set([
  // The Buy Now pricing history and its evidence.
  "PriceCalculation",
  "PriceSyncIntent",
  "PriceRecalculationRun",
  "Snapshot",
  // The audit trail the run itself writes. Append-only and Buy Now scoped.
  "AuditEvent",
]);

const WRITE_ACTIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "queryRaw",
]);

/**
 * The recorder must sit on the SHARED client — the one the job actually uses.
 * An extension on a fresh PrismaClient would observe nothing, and the test
 * would pass by seeing no writes at all rather than by seeing only allowed
 * ones: green for the wrong reason, on every future violation too.
 */
const observed = new Set<string>();
prisma.$use(async (params, next) => {
  if (params.action && WRITE_ACTIONS.has(params.action)) {
    observed.add(`${params.model ?? "raw"}.${params.action}`);
  }
  return next(params);
});

describe("D15 — the Buy Now recalculation job's write surface", () => {
  it("writes only to Buy Now pricing tables, never to anything else", async () => {
    observed.clear();

    await runPriceRecalculation({
      asOf: new Date("2026-09-17T00:00:00Z"),
      trigger: "staff",
      triggeredBy: "integration-test",
      reason: "D15 write-surface check",
    });

    const writtenModels = [...observed].map((entry) => entry.split(".")[0] ?? "");

    // Guards the guard: if the recorder ever stops seeing writes, this test
    // must fail loudly rather than quietly reporting an empty, compliant set.
    // The job writes price calculations on every run, so zero observed writes
    // means the instrumentation broke, not that the job became read-only.
    expect(writtenModels.length).toBeGreaterThan(0);
    expect(writtenModels).toContain("PriceCalculation");

    for (const model of new Set(writtenModels)) {
      expect(
        ALLOWED_WRITE_MODELS.has(model),
        `The recalculation job wrote to ${model}, which is not in the D15 allowlist. ` +
          `If this is a Group Buy table, that is the violation D15 forbids outright. ` +
          `If it is a new Buy Now table, add it to ALLOWED_WRITE_MODELS deliberately.`
      ).toBe(true);
    }
  });

  it("records the trigger, the actor and the reason on the run", async () => {
    const summary = await runPriceRecalculation({
      asOf: new Date("2026-09-17T00:00:00Z"),
      trigger: "metal_price_entry",
      triggeredBy: "staff:brian",
      reason: "new gold reference price entered",
    });

    const run = await prisma.priceRecalculationRun.findUniqueOrThrow({
      where: { id: summary.runId },
    });

    expect(run.trigger).toBe("metal_price_entry");
    expect(run.triggeredBy).toBe("staff:brian");
    expect(run.reason).toBe("new gold reference price entered");
    expect(run.finishedAt).not.toBeNull();
    expect(run.computed).toBe(summary.computed);
  });

  it("defaults an unattributed run to scheduled rather than inventing an actor", async () => {
    const summary = await runPriceRecalculation({ asOf: new Date("2026-09-17T00:00:00Z") });
    const run = await prisma.priceRecalculationRun.findUniqueOrThrow({
      where: { id: summary.runId },
    });

    expect(run.trigger).toBe("scheduled");
    expect(run.triggeredBy).toBeNull();
  });

  it("refuses a staff-triggered run that names nobody", async () => {
    // D15's attribution requirement, enforced before any price is written.
    await expect(
      runPriceRecalculation({ asOf: new Date("2026-09-17T00:00:00Z"), trigger: "staff" })
    ).rejects.toThrow(MissingTriggerActorError);
  });

  it("writes no run record at all when attribution is rejected", async () => {
    // The attribution check happens BEFORE the run row is written, so a
    // rejected run must leave no row at all — a run record with no work behind
    // it implies a repricing that never happened.
    const before = await prisma.priceRecalculationRun.count();
    await expect(
      runPriceRecalculation({ asOf: new Date("2026-09-17T00:00:00Z"), trigger: "staff" })
    ).rejects.toThrow();
    expect(await prisma.priceRecalculationRun.count()).toBe(before);
  });
});

describe("D15 — the run audit row is not rewritable", () => {
  it("refuses to re-complete a finished run", async () => {
    const summary = await runPriceRecalculation({ asOf: new Date("2026-09-17T00:00:00Z") });

    await expect(
      prisma.priceRecalculationRun.update({
        where: { id: summary.runId },
        data: { finishedAt: new Date(), computed: 999 },
      })
    ).rejects.toThrow(/already finished/);
  });

  it("refuses to rewrite what triggered a run", async () => {
    const id = crypto.randomUUID();
    await prisma.priceRecalculationRun.create({
      data: { id, trigger: "scheduled", asOf: new Date("2026-09-17T00:00:00Z") },
    });

    await expect(
      prisma.priceRecalculationRun.update({
        where: { id },
        data: { trigger: "staff", triggeredBy: "someone-else", finishedAt: new Date() },
      })
    ).rejects.toThrow(/only finished_at and the counts/);
  });

  it("refuses to delete a run record", async () => {
    const id = crypto.randomUUID();
    await prisma.priceRecalculationRun.create({
      data: { id, trigger: "scheduled", asOf: new Date("2026-09-17T00:00:00Z") },
    });

    await expect(prisma.priceRecalculationRun.delete({ where: { id } })).rejects.toThrow(
      /append-only/
    );
  });
});
