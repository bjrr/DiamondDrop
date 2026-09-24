import { describe, expect, it } from "vitest";

import { extractPolicyVersionInserts } from "./policyVersionMigrationInsertParser";

/**
 * The parser is proved correct here, in isolation, BEFORE
 * `requiredPolicyVersionsMigrationFence.test.ts` relies on it against the
 * real migration file — a fence built on an unproven parser is not a fence,
 * it is a guess.
 */
describe("extractPolicyVersionInserts", () => {
  it("returns nothing for SQL with no policy_version INSERT", () => {
    expect(extractPolicyVersionInserts('CREATE TABLE "foo" ("id" UUID);')).toEqual([]);
  });

  it("parses the real migration's exact shape: gen_random_uuid(), an E'' literal with \\n escapes, and ON CONFLICT", () => {
    const sql = `INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'luxury-steals-final-sale-acknowledgment',
  1,
  '2026-01-01T00:00:00.000Z',
  E'FINAL SALE ACKNOWLEDGMENT\\n\\nI understand.',
  'abc123',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;`;

    const results = extractPolicyVersionInserts(sql);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      slug: "luxury-steals-final-sale-acknowledgment",
      version: 1,
      text: "FINAL SALE ACKNOWLEDGMENT\n\nI understand.",
      contentHash: "abc123",
    });
  });

  it("does not split on a comma embedded inside the text literal", () => {
    const sql = `INSERT INTO "policy_version" ("slug", "version", "text", "content_hash")
VALUES ('s', 1, E'first, second, third', 'h')
ON CONFLICT ("slug", "version") DO NOTHING;`;

    const [result] = extractPolicyVersionInserts(sql);
    expect(result?.text).toBe("first, second, third");
  });

  it("does not mistake a parenthesis inside the text literal for the list's closing paren", () => {
    const sql = `INSERT INTO "policy_version" ("slug", "version", "text", "content_hash")
VALUES ('s', 1, E'terms (see section 2) apply', 'h')
ON CONFLICT ("slug", "version") DO NOTHING;`;

    const [result] = extractPolicyVersionInserts(sql);
    expect(result?.text).toBe("terms (see section 2) apply");
  });

  it("unescapes a doubled single quote inside a plain '' literal", () => {
    const sql = `INSERT INTO "policy_version" ("slug", "version", "text", "content_hash")
VALUES ('s', 1, 'it''s final', 'h')
ON CONFLICT ("slug", "version") DO NOTHING;`;

    const [result] = extractPolicyVersionInserts(sql);
    expect(result?.text).toBe("it's final");
  });

  it("finds multiple INSERT statements in one file, in order", () => {
    const sql = `
INSERT INTO "policy_version" ("slug", "version", "text", "content_hash")
VALUES ('a', 1, E'first', 'ha')
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("slug", "version", "text", "content_hash")
VALUES ('b', 1, E'second', 'hb')
ON CONFLICT ("slug", "version") DO NOTHING;
`;

    const results = extractPolicyVersionInserts(sql);
    expect(results.map((r) => r.slug)).toEqual(["a", "b"]);
  });

  it("maps columns by name, not position — a reordered column list still parses correctly", () => {
    const sql = `INSERT INTO "policy_version" ("version", "slug", "content_hash", "text")
VALUES (1, 's', 'h', E'reordered')
ON CONFLICT ("slug", "version") DO NOTHING;`;

    const [result] = extractPolicyVersionInserts(sql);
    expect(result).toEqual({ slug: "s", version: 1, text: "reordered", contentHash: "h" });
  });

  it("throws rather than silently mis-parsing when a required column is absent", () => {
    const sql = `INSERT INTO "policy_version" ("slug", "version")
VALUES ('s', 1)
ON CONFLICT ("slug", "version") DO NOTHING;`;

    expect(() => extractPolicyVersionInserts(sql)).toThrow(/missing one of the required columns/);
  });
});
