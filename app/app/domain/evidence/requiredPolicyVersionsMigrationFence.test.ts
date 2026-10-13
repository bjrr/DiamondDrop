import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractPolicyVersionInserts } from "./policyVersionMigrationInsertParser";
import { REQUIRED_POLICY_VERSIONS } from "./requiredPolicyVersions";

/**
 * THE DRIFT FENCE. `prisma/migrations/20260924020000_luxury_steals_policy_version`
 * hardcodes its INSERT's `text` and `content_hash` as SQL literals — nothing
 * keeps them in sync with `~/domain/luxurysteals/acknowledgmentText.ts`'s
 * pinned constant, which `REQUIRED_POLICY_VERSIONS` is built from. A wording
 * change under D11 would update the constant, its own pin test
 * (`acknowledgmentText.test.ts`), and `docs/LUXURY-STEALS.md` — and silently
 * leave the migration's literal behind, with the OLD text already
 * provisioned in every environment and the NEW text never provisioned
 * anywhere at all. That is worse than the outage this migration fixed: the
 * original was a loud 500, this would be evidence recording text the
 * customer never actually saw.
 *
 * Same discipline as `notCommittedDisclosure.test.ts` (reads the theme
 * locale file from disk rather than importing a shared constant, because a
 * test comparing a module to itself proves nothing about the SEPARATE
 * artefact a real caller reads) — applied here to every
 * `prisma/migrations/**\/migration.sql` file, which is a separate artefact
 * from `requiredPolicyVersions.ts` in exactly the same sense: SQL cannot
 * import a TypeScript module, migrations are immutable once applied
 * (CLAUDE.md git discipline; this repo's own convention — see
 * `20260924020000`'s own header comment), and Prisma replays the file's raw
 * bytes, not this registry, against every environment.
 *
 * WALKS EVERY MIGRATION FILE rather than hardcoding
 * `20260924020000`'s path, for the same reason `csrfResourceRouteFence.test.ts`
 * walks `app/routes/` instead of hand-maintaining a route list: a fence that
 * only checks one named file stops meaning anything the moment a SECOND
 * required-policy migration is added and nobody remembers to update a list
 * here.
 */

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function allMigrationSqlFiles(): Array<{ name: string; path: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(MIGRATIONS_DIR, entry.name, "migration.sql");
      return { name: entry.name, path, sql: readFileSync(path, "utf8") };
    });
}

describe("guard the guard — the migration directory actually has something to check", () => {
  it("finds at least one migration file that inserts a policy_version row", () => {
    const files = allMigrationSqlFiles();
    expect(files.length).toBeGreaterThan(0);

    const allInserts = files.flatMap((f) => extractPolicyVersionInserts(f.sql));
    expect(
      allInserts.length,
      "no migration file inserts a policy_version row — either the migration was " +
        "renamed/removed, or this fence's parser regressed and stopped matching the " +
        "real file. Either way this test finding zero means the fence below is " +
        "checking nothing."
    ).toBeGreaterThan(0);
  });
});

describe("every REQUIRED_POLICY_VERSIONS entry is provisioned by a migration, byte-identically", () => {
  const migrationInserts = allMigrationSqlFiles().flatMap((f) =>
    extractPolicyVersionInserts(f.sql).map((insert) => ({ ...insert, migrationFile: f.name }))
  );

  it.each(REQUIRED_POLICY_VERSIONS)(
    "$slug v$version — migration text and content_hash match the registry exactly",
    (required) => {
      const provisioning = migrationInserts.find(
        (m) => m.slug === required.slug && m.version === required.version
      );

      expect(
        provisioning,
        `REQUIRED_POLICY_VERSIONS names ${required.slug} v${required.version}, but no ` +
          `migration under prisma/migrations/ provisions it. A required policy version ` +
          `must be provisioned by a migration in every environment — see ` +
          `requiredPolicyVersions.ts's header comment.`
      ).toBeDefined();

      expect(
        provisioning?.text,
        `${required.slug} v${required.version}: the migration's provisioned TEXT does ` +
          `not match ~/domain/luxurysteals/acknowledgmentText.ts's pinned constant. ` +
          `This means the text a real deployment would insert is NOT the text this ` +
          `codebase currently pins as approved. Since policy_version is append-only, ` +
          `there is no fixing this in place — the fix is a NEW migration provisioning ` +
          `the next version.`
      ).toBe(required.text);

      expect(
        provisioning?.contentHash,
        `${required.slug} v${required.version}: the migration's hardcoded content_hash ` +
          `does not match sha256(text) of the registry's pinned text. Either the migration's ` +
          `literal was computed from different text than what is now pinned (see the TEXT ` +
          `assertion above), or the hash itself was miscomputed at authoring time.`
      ).toBe(required.contentHash);
    }
  );

  it("finds ALL migrations that touch this slug/version and every one of them agrees (no migration provisions conflicting text for the same key)", () => {
    // A defensive symmetry check: even if a future refactor adds a second
    // migration that (incorrectly) re-provisions the SAME (slug, version),
    // ON CONFLICT DO NOTHING means only the first-applied one actually wins
    // at runtime — but if the two migration FILES disagree with each other,
    // that is itself a bug worth catching here rather than depending on
    // apply order.
    const bySlugVersion = new Map<string, Set<string>>();
    for (const insert of migrationInserts) {
      const key = `${insert.slug}@${insert.version}`;
      const set = bySlugVersion.get(key) ?? new Set<string>();
      set.add(`${insert.text}::${insert.contentHash}`);
      bySlugVersion.set(key, set);
    }
    for (const [key, variants] of bySlugVersion) {
      expect(variants.size, `multiple migrations provision "${key}" with DIFFERENT text/hash`).toBe(1);
    }
  });
});
