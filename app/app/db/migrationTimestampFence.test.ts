import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * FENCE — no two migrations may share a timestamp prefix.
 *
 * WHY THIS EXISTS RATHER THAN A CONVENTION. Migrations here are hand-authored
 * (`migrate dev --create-only` trips a known checksum mismatch on an early
 * one), so the timestamp is chosen by a human reading `ls`. That has now
 * collided TWICE with several agents working concurrently:
 *
 *   2026-09-27  20260926040000_drop_warranty_order_lookup_verification
 *               20260926040000_rma_return_policy_acknowledgment_version
 *   2026-09-28  20260928050000_group_buy_refund_not_owed_reopen_edge
 *               20260928050000_rma_request_condition_decision_immutable
 *
 * After the first, a warning was added to the offending migration's own
 * comment telling the next author to check existing prefixes. It did not
 * work, and could not have: someone creating a DIFFERENT migration never
 * reads that file. A convention that depends on remembering to look is a
 * convention that fails under concurrency, which is precisely when
 * migrations get written fastest.
 *
 * WHY IT MATTERS, beyond tidiness. Prisma orders migrations lexicographically
 * by full directory name, so colliding prefixes still apply deterministically
 * — but the order between them is decided by whatever follows the underscore,
 * which is alphabetical accident rather than intent. Two migrations that
 * happen not to depend on each other today are ordered by their description.
 * The day one of them needs to run after the other, nothing enforces it, and
 * the failure lands during a production release command.
 *
 * So: one timestamp, one migration. Pick the next free slot.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
const TIMESTAMPED = /^(\d{14})_(.+)$/;

function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("migration timestamps are unique", () => {
  it("finds the migrations directory and real migrations in it", () => {
    // GUARD THE GUARD. If the path were wrong this suite would pass by
    // finding nothing — the exact shape of a fence that cannot fire.
    const dirs = migrationDirectories();
    expect(dirs.length).toBeGreaterThan(20);
    expect(dirs.filter((d) => TIMESTAMPED.test(d)).length).toBeGreaterThan(20);
  });

  it("no two migrations share a timestamp prefix", () => {
    const byTimestamp = new Map<string, string[]>();
    for (const dir of migrationDirectories()) {
      const match = TIMESTAMPED.exec(dir);
      if (!match) continue;
      const stamp = match[1]!;
      byTimestamp.set(stamp, [...(byTimestamp.get(stamp) ?? []), dir]);
    }

    const collisions = [...byTimestamp.entries()]
      .filter(([, dirs]) => dirs.length > 1)
      .map(([stamp, dirs]) => `  ${stamp} is used by ${dirs.length}:\n${dirs.map((d) => `    - ${d}`).join("\n")}`);

    expect(
      collisions,
      collisions.length === 0
        ? ""
        : `Two or more migrations share a timestamp prefix:\n\n${collisions.join("\n\n")}\n\n` +
            `Prisma still orders these deterministically, but by the text AFTER the underscore — ` +
            `alphabetical accident rather than intent. Renumber one to the next free slot. ` +
            `Run \`ls prisma/migrations\` and pick a timestamp nobody has used.\n\n` +
            `If the colliding migration has already been applied to a database, renaming it needs ` +
            `care: delete its row from _prisma_migrations before re-applying, or use ` +
            `\`prisma migrate resolve --applied <new name>\`. Do that on local/test databases only.`
    ).toEqual([]);
  });

  it("every migration directory is timestamped at all", () => {
    const untimestamped = migrationDirectories().filter((d) => !TIMESTAMPED.test(d));
    expect(untimestamped, `Migration directories without a 14-digit timestamp prefix: ${untimestamped.join(", ")}`).toEqual([]);
  });
});
