import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeMissingRequiredPolicyVersions,
  REQUIRED_POLICY_VERSIONS,
} from "./requiredPolicyVersions";
import { LUXURY_STEALS_ACKNOWLEDGMENT_TEXT } from "~/domain/luxurysteals/acknowledgmentText";

/**
 * The registry itself (no disk reads, no database) — see
 * `requiredPolicyVersionsMigrationFence.test.ts` for the disk-reading fence
 * against `prisma/migrations/**\/migration.sql`, and
 * `tests/integration/evidence/requiredPolicyVersionsHealth.test.ts` for the
 * database-touching half.
 */
describe("REQUIRED_POLICY_VERSIONS", () => {
  it("is non-empty and includes the Luxury Steals acknowledgment policy", () => {
    expect(REQUIRED_POLICY_VERSIONS.length).toBeGreaterThan(0);
    const entry = REQUIRED_POLICY_VERSIONS.find(
      (r) => r.slug === "luxury-steals-final-sale-acknowledgment"
    );
    expect(entry).toBeDefined();
    expect(entry?.version).toBe(1);
    expect(entry?.text).toBe(LUXURY_STEALS_ACKNOWLEDGMENT_TEXT);
  });

  it("does NOT include sample-policy — a Slice 0 fixture, not a requirement", () => {
    expect(REQUIRED_POLICY_VERSIONS.some((r) => r.slug === "sample-policy")).toBe(false);
  });

  it("every entry's contentHash is the plain SHA-256 hex digest of its text, not a JSON-wrapped hash", () => {
    // This is the property the module's header comment argues for at length:
    // the migration and prisma/seed.ts both persist `content_hash` as
    // `sha256(text)`, NOT `buildPolicyVersionRecord`'s own
    // `hashCanonicalJson(text)` (which, for a bare string, hashes
    // `JSON.stringify(text)` instead — a different digest). Pinning the
    // PLAIN-hash property here means a future edit that swaps in
    // `buildPolicyVersionRecord`'s `.contentHash` directly fails loudly,
    // rather than only failing the migration fence in a way that is easy to
    // misread as "the migration is wrong".
    for (const entry of REQUIRED_POLICY_VERSIONS) {
      const expected = createHash("sha256").update(entry.text, "utf8").digest("hex");
      expect(entry.contentHash).toBe(expected);
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("has no duplicate (slug, version) pair", () => {
    const keys = REQUIRED_POLICY_VERSIONS.map((r) => `${r.slug}@${r.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("computeMissingRequiredPolicyVersions", () => {
  const required = [
    { slug: "a", version: 1, text: "x", contentHash: "hash-a-1" },
    { slug: "a", version: 2, text: "y", contentHash: "hash-a-2" },
    { slug: "b", version: 1, text: "z", contentHash: "hash-b-1" },
  ];

  it("returns nothing missing when every required (slug, version) is present", () => {
    const present = [
      { slug: "a", version: 1 },
      { slug: "a", version: 2 },
      { slug: "b", version: 1 },
    ];
    expect(computeMissingRequiredPolicyVersions(required, present)).toEqual([]);
  });

  it("reports exactly the required entries absent from the present set", () => {
    const present = [{ slug: "a", version: 1 }];
    expect(computeMissingRequiredPolicyVersions(required, present)).toEqual([
      { slug: "a", version: 2 },
      { slug: "b", version: 1 },
    ]);
  });

  it("reports everything missing when the present set is empty — the fresh-database case", () => {
    expect(computeMissingRequiredPolicyVersions(required, [])).toEqual([
      { slug: "a", version: 1 },
      { slug: "a", version: 2 },
      { slug: "b", version: 1 },
    ]);
  });

  it("does not confuse two different versions of the same slug — the wrong version being present must not mask the right one being missing", () => {
    // e.g. `sample-policy v1` existing must never be read as satisfying a
    // requirement for `luxury-steals-final-sale-acknowledgment v1` just
    // because SOME policy_version row exists — this is exactly the
    // production defect being guarded against, restated as a unit case.
    const present = [{ slug: "a", version: 99 }];
    expect(computeMissingRequiredPolicyVersions(required, present)).toEqual([
      { slug: "a", version: 1 },
      { slug: "a", version: 2 },
      { slug: "b", version: 1 },
    ]);
  });

  it("ignores a present row that is not required (extra rows are not an error)", () => {
    const present = [
      { slug: "a", version: 1 },
      { slug: "a", version: 2 },
      { slug: "b", version: 1 },
      { slug: "sample-policy", version: 1 },
    ];
    expect(computeMissingRequiredPolicyVersions(required, present)).toEqual([]);
  });

  it("is a no-op against an empty required list", () => {
    expect(computeMissingRequiredPolicyVersions([], [{ slug: "a", version: 1 }])).toEqual([]);
  });
});
