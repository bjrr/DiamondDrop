import { describe, expect, it } from "vitest";

import { deriveHealthSummary } from "./health";

/**
 * PURE unit tests for the tri-state health decision — no database, no
 * network. See `deriveHealthSummary`'s own doc comment in `health.tsx` for
 * the full reasoning behind the "degraded stays at HTTP 200" choice;
 * `tests/integration/evidence/requiredPolicyVersionsHealth.test.ts` covers
 * the database-touching half (`checkRequiredPolicyVersionsProvisioned`) and
 * the loader's end-to-end wiring against a real, seeded database.
 */

const OK_DATABASE = { status: "ok" as const, latencyMs: 5 };
const ERROR_DATABASE = { status: "error" as const, error: "database unreachable" };
const CLEAN_MIGRATIONS = { applied: ["20260101000000_init"], pending: [] };
const ERRORED_MIGRATIONS = { applied: [], pending: [], error: "could not read _prisma_migrations" };
const POLICIES_OK = { status: "ok" as const, missing: [] };
const POLICIES_MISSING = {
  status: "missing" as const,
  missing: [{ slug: "luxury-steals-final-sale-acknowledgment", version: 1 }],
};
const POLICIES_UNKNOWN = { status: "unknown" as const, missing: [], error: "query timed out" };

describe("deriveHealthSummary", () => {
  it("is ok/200 when the database, migrations, and required policy versions are all healthy", () => {
    expect(
      deriveHealthSummary({ database: OK_DATABASE, migrations: CLEAN_MIGRATIONS, requiredPolicyVersions: POLICIES_OK })
    ).toEqual({ status: "ok", httpStatus: 200 });
  });

  it("is error/503 when the database is unreachable, regardless of required policy versions", () => {
    expect(
      deriveHealthSummary({
        database: ERROR_DATABASE,
        migrations: CLEAN_MIGRATIONS,
        requiredPolicyVersions: POLICIES_OK,
      })
    ).toEqual({ status: "error", httpStatus: 503 });
  });

  it("is error/503 when migrations report an error, regardless of required policy versions", () => {
    expect(
      deriveHealthSummary({
        database: OK_DATABASE,
        migrations: ERRORED_MIGRATIONS,
        requiredPolicyVersions: POLICIES_OK,
      })
    ).toEqual({ status: "error", httpStatus: 503 });
  });

  it(
    "is degraded/200 — NOT error/503 — when a required policy version is missing but the database and " +
      "migrations are otherwise healthy. This is the load-bearing case: the whole point of the tri-state " +
      "design is that this does not get the single Fly machine pulled from rotation over a one-feature defect",
    () => {
      expect(
        deriveHealthSummary({
          database: OK_DATABASE,
          migrations: CLEAN_MIGRATIONS,
          requiredPolicyVersions: POLICIES_MISSING,
        })
      ).toEqual({ status: "degraded", httpStatus: 200 });
    }
  );

  it("is degraded/200 when the required-policy-version check itself could not be confirmed ('unknown')", () => {
    expect(
      deriveHealthSummary({
        database: OK_DATABASE,
        migrations: CLEAN_MIGRATIONS,
        requiredPolicyVersions: POLICIES_UNKNOWN,
      })
    ).toEqual({ status: "degraded", httpStatus: 200 });
  });

  it("prioritises error/503 over degraded when BOTH a database failure and a missing policy are present", () => {
    expect(
      deriveHealthSummary({
        database: ERROR_DATABASE,
        migrations: CLEAN_MIGRATIONS,
        requiredPolicyVersions: POLICIES_MISSING,
      })
    ).toEqual({ status: "error", httpStatus: 503 });
  });
});
