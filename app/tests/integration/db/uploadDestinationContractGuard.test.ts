import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";

/**
 * PROVES CONTRACT STEP B'S PRECONDITION GUARD CAN ACTUALLY FIRE.
 *
 * Step B drops `claim_id`, guarded by a `DO` block that refuses if any row
 * issued after step A still sets the column. In the normal integration run
 * that guard finds nothing and the migration sails through — which tells us
 * nothing. A fence that has only ever been walked past is not a proven fence,
 * and this project has already shipped two of those: the D15 write-surface
 * regex silently matching schema names, and an assertion that proved "no
 * destination leaked" by querying a column nobody writes.
 *
 * So this reads THE REAL SQL out of the migration file — not a paraphrase —
 * and runs it against states built to violate each precondition in turn. If
 * someone softens the guard, these fail.
 *
 * ============================================================================
 * HOW THE FIXTURE STATE IS BUILT: TEMPORARY TABLES THAT SHADOW BY NAME
 * ============================================================================
 * By the time the suite's migrations have run, `claim_id` is gone and step A
 * is recorded as finished, so neither failure state is reachable in the live
 * schema. The obvious fix — a scratch schema plus `SET LOCAL search_path` —
 * does not work here: Prisma pins its own schema on the connection and the
 * guard's unqualified names kept resolving to the real tables.
 *
 * `CREATE TEMPORARY TABLE` solves it properly. `pg_temp` sits ahead of
 * everything in `search_path` by default, so a temp table named
 * `warranty_claim_upload_destination` shadows the real one for this session
 * only — WITHOUT the guard SQL being altered, which is the whole point. They
 * are declared `ON COMMIT DROP`, so the transaction's end is the cleanup;
 * there is no leak path even if an assertion throws.
 *
 * The guard only ever READS, so shadowing is safe by construction.
 */

const MIGRATION = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261008010000_upload_destination_contract_step_b",
  "migration.sql"
);

const STEP_A_NAME = "20261007020000_upload_destination_contract_step_a";

/**
 * The `DO $$ ... $$;` block, lifted verbatim from the migration.
 *
 * Extracted rather than retyped: a copy would keep passing after the real
 * guard was weakened, which is the exact failure mode this test exists to
 * prevent. `$$`-quoted bodies cannot nest, so the first block is unambiguous.
 */
function guardSql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("DO $$");
  const end = sql.indexOf("$$;", start);
  if (start === -1 || end === -1) {
    throw new Error(
      `could not find the DO $$ ... $$; guard in ${MIGRATION}. If the guard was restructured, update this ` +
        `extraction — do NOT delete the test, because the guard is the only thing standing between a missed ` +
        `writer and a dropped column it still populates.`
    );
  }
  return sql.slice(start, end + 3);
}

interface GuardFixture {
  /** null = no migration row at all. */
  readonly stepAFinishedAt: Date | null;
  /** Present but unfinished — "started" is not "finished". */
  readonly stepARowUnfinished?: boolean;
  readonly rows: ReadonlyArray<{ claimId: string | null; issuedAt: Date }>;
}

async function runGuardAgainst(fixture: GuardFixture): Promise<{ raised: boolean; message: string }> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TEMPORARY TABLE "_prisma_migrations" (
          "migration_name" TEXT NOT NULL,
          "finished_at" TIMESTAMPTZ
        ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`
        CREATE TEMPORARY TABLE "warranty_claim_upload_destination" (
          "claim_id" UUID,
          "issued_at" TIMESTAMPTZ NOT NULL
        ) ON COMMIT DROP`);

      if (fixture.stepARowUnfinished) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "_prisma_migrations" ("migration_name", "finished_at") VALUES ($1, NULL)`,
          STEP_A_NAME
        );
      } else if (fixture.stepAFinishedAt !== null) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "_prisma_migrations" ("migration_name", "finished_at") VALUES ($1, $2)`,
          STEP_A_NAME,
          fixture.stepAFinishedAt
        );
      }

      for (const row of fixture.rows) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "warranty_claim_upload_destination" ("claim_id", "issued_at") VALUES ($1::uuid, $2)`,
          row.claimId,
          row.issuedAt
        );
      }

      await tx.$executeRawUnsafe(guardSql());
    });
    return { raised: false, message: "" };
  } catch (error) {
    return { raised: true, message: error instanceof Error ? error.message : String(error) };
  }
}

const AN_HOUR = 60 * 60 * 1000;

describe("contract step B's precondition guard", () => {
  it("REFUSES when a row issued AFTER step A still sets claim_id", async () => {
    // The case the guard exists for: a writer was missed. Dropping the column
    // here would move the failure from this migration to that writer's next
    // request.
    const stepA = new Date(Date.now() - AN_HOUR);
    const result = await runGuardAgainst({
      stepAFinishedAt: stepA,
      rows: [{ claimId: "11111111-1111-4111-8111-111111111111", issuedAt: new Date(stepA.getTime() + 60_000) }],
    });

    expect(result.raised, "the guard did not fire on the case it exists for").toBe(true);
    expect(result.message).toContain("refusing to drop claim_id");
    // The count is in the message on purpose — "some rows" sends you looking
    // where a number tells you how bad it is.
    expect(result.message).toContain("1 destination row(s)");
  });

  it("REFUSES when step A is not recorded at all — a missing premise is not a pass", async () => {
    // The subtler half. A NULL anchor makes `issued_at > NULL` yield NULL,
    // count() of no rows is 0, and the guard would read "fine" precisely when
    // it cannot tell. This asserts it raises instead.
    const result = await runGuardAgainst({
      stepAFinishedAt: null,
      rows: [{ claimId: "22222222-2222-4222-8222-222222222222", issuedAt: new Date() }],
    });

    expect(result.raised).toBe(true);
    expect(result.message).toContain("not recorded as finished");
  });

  it("REFUSES when step A's row exists but finished_at is NULL — started is not finished", async () => {
    // `finished_at IS NULL` means the migration began and did not complete.
    // The guard's WHERE clause has to exclude it, not merely find the row.
    const result = await runGuardAgainst({
      stepAFinishedAt: null,
      stepARowUnfinished: true,
      rows: [{ claimId: "55555555-5555-4555-8555-555555555555", issuedAt: new Date() }],
    });

    expect(result.raised).toBe(true);
    expect(result.message).toContain("not recorded as finished");
  });

  it("ALLOWS the real case: rows with claim_id, all issued BEFORE step A", async () => {
    // Pre-step-A rows legitimately carry a claim_id — they are exactly what
    // the drop discards on purpose. Without this case the guard could be
    // "always raise" and every test above would still pass.
    const stepA = new Date();
    const result = await runGuardAgainst({
      stepAFinishedAt: stepA,
      rows: [
        { claimId: "33333333-3333-4333-8333-333333333333", issuedAt: new Date(stepA.getTime() - AN_HOUR) },
        { claimId: "44444444-4444-4444-8444-444444444444", issuedAt: new Date(stepA.getTime() - 2 * AN_HOUR) },
      ],
    });

    expect(result.raised, `guard raised when it should not have: ${result.message}`).toBe(false);
  });

  it("ALLOWS rows issued after step A that correctly leave claim_id NULL", async () => {
    const stepA = new Date(Date.now() - AN_HOUR);
    const result = await runGuardAgainst({
      stepAFinishedAt: stepA,
      rows: [{ claimId: null, issuedAt: new Date(stepA.getTime() + 60_000) }],
    });

    expect(result.raised, `guard raised when it should not have: ${result.message}`).toBe(false);
  });
});

describe("guarding the guard", () => {
  it("the extracted SQL is the real guard, not an empty string or a fragment", () => {
    // If the extraction silently returned "" every "ALLOWS" case would pass
    // and every "REFUSES" case would fail loudly — but a future refactor
    // could produce a fragment that runs without checking anything. These
    // assertions pin the parts that do the work.
    const sql = guardSql();
    expect(sql.startsWith("DO $$")).toBe(true);
    expect(sql.trimEnd().endsWith("$$;")).toBe(true);
    expect(sql).toContain("_prisma_migrations");
    expect(sql).toContain("claim_id");
    expect(sql).toContain("issued_at");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain(STEP_A_NAME);
  });

  it("the migration still drops the column the guard protects", () => {
    // The guard is pointless if the DROP is ever removed, and a suite that
    // only exercised the guard would not notice.
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/DROP COLUMN "claim_id"/);
  });
});
