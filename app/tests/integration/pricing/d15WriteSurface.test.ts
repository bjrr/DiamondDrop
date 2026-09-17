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

const ALLOWED_WRITE_TABLES = new Set([
  // The Buy Now pricing history and its evidence.
  "price_calculation",
  "price_sync_intent",
  "price_recalculation_run",
  "snapshot",
  // The audit trail the run itself writes. Append-only and Buy Now scoped.
  "audit_event",
]);

/** INSERT INTO "t" / UPDATE "t" / DELETE FROM "t", quoted or bare. */
const WRITE_SQL =
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

function tablesWrittenBy(sql: string): string[] {
  const found: string[] = [];
  for (const m of sql.matchAll(WRITE_SQL)) if (m[1]) found.push(m[1].toLowerCase());
  return found;
}

/**
 * Observes the SHARED client — the one the job actually uses. A `$extends`
 * wrapper would return a NEW client and see nothing, so the test would pass by
 * observing no writes at all rather than only allowed ones: green for the wrong
 * reason, and green on every future violation too.
 *
 * Prisma 6 removed `$use` middleware, so this listens to query events instead
 * (enabled by PRISMA_EMIT_QUERY_EVENTS in tests/integration/setupEnv.ts).
 * Reading the real SQL is strictly better evidence than the Prisma model names
 * the previous version matched on: it also catches a raw `$executeRaw` write,
 * which a model-name check reports only as "raw" and cannot attribute.
 */
const observed = new Set<string>();
type QueryEventEmitter = {
  $on: (event: "query", listener: (payload: { query: string }) => void) => void;
};

(prisma as unknown as QueryEventEmitter).$on("query", (event) => {
  for (const table of tablesWrittenBy(event.query)) observed.add(table);
});

/**
 * Query events arrive ASYNCHRONOUSLY — they are not delivered by the time the
 * awaited Prisma call resolves. Asserting immediately after the run saw an
 * empty set and failed, which is the "guard the guard" assertion earning its
 * keep: without it this would have reported a clean, compliant, entirely
 * imaginary write surface.
 *
 * Waits for the set to stop growing rather than sleeping a fixed interval, so
 * it is neither flaky on a slow machine nor needlessly slow on a fast one.
 */
async function settle(): Promise<void> {
  // Two conditions, and the first is the one that bit: keep waiting while the
  // set is still EMPTY, because "nothing yet" and "nothing at all" look
  // identical after 20ms. Only once something has arrived does it make sense to
  // wait for the count to stop growing.
  let stableFor = 0;
  let previous = -1;
  for (let i = 0; i < 100; i++) {
    if (observed.size > 0 && observed.size === previous) {
      if (++stableFor >= 3) return;
    } else {
      stableFor = 0;
    }
    previous = observed.size;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("D15 — the Buy Now recalculation job's write surface", () => {
  it("writes only to Buy Now pricing tables, never to anything else", async () => {
    observed.clear();

    await runPriceRecalculation({
      asOf: new Date("2026-09-17T00:00:00Z"),
      trigger: "staff",
      triggeredBy: "integration-test",
      reason: "D15 write-surface check",
    });
    await settle();

    const written = [...observed];

    // Guards the guard: if the recorder ever stops seeing writes, this test
    // must fail loudly rather than quietly reporting an empty, compliant set.
    // The job writes price calculations on every run, so zero observed writes
    // means the instrumentation broke, not that the job became read-only.
    expect(written.length).toBeGreaterThan(0);
    expect(written).toContain("price_calculation");

    for (const table of written) {
      expect(
        ALLOWED_WRITE_TABLES.has(table),
        `The recalculation job wrote to "${table}", which is not in the D15 allowlist. ` +
          `If this is a Group Buy table, that is the violation D15 forbids outright. ` +
          `If it is a new Buy Now table, add it to ALLOWED_WRITE_TABLES deliberately.`
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
