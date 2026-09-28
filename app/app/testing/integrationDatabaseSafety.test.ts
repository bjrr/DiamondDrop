import { describe, expect, it } from "vitest";

import {
  assertSafeIntegrationDatabase,
  describeTarget,
  PRODUCTION_DATABASE_NAMES,
  UnsafeIntegrationDatabaseError,
} from "./integrationDatabaseSafety";

/**
 * Tests for the guard that stands between this suite and production data.
 *
 * This file exists because an unproven safety check is worse than none: it
 * looks like protection and occupies the place real protection would go.
 * Today's session produced a fence that could never fire and a mock that
 * silently matched nothing, both of which read as correct in review.
 *
 * So every refusal below is asserted to ACTUALLY THROW, and the permitted
 * cases are asserted to actually pass — because a check that refuses
 * everything is equally useless, and would be discovered only by someone
 * disabling it under deadline.
 */

const PROD = "postgresql://u:p@pgbouncer.n83v7rgjevlr5gxk.flympg.net/fly-db";
const TEST_REMOTE = "postgresql://u:p@pgbouncer.n83v7rgjevlr5gxk.flympg.net/carat_test";
const TEST_LOCAL = "postgresql://carat:pw@localhost:5432/carat_it_1234_abc";

describe("assertSafeIntegrationDatabase — refusals", () => {
  it("REFUSES production, even though host and credentials are identical to the test database", () => {
    // The whole point: on the shared Fly cluster only the database name
    // differs between these two URLs.
    expect(() => assertSafeIntegrationDatabase(PROD)).toThrow(UnsafeIntegrationDatabaseError);
  });

  it("names production explicitly in the error, so the cause is unmistakable at 2am", () => {
    expect(() => assertSafeIntegrationDatabase(PROD)).toThrow(/REFUSING TO RUN AGAINST PRODUCTION/);
  });

  it("refuses every known production database name", () => {
    for (const name of PRODUCTION_DATABASE_NAMES) {
      expect(() =>
        assertSafeIntegrationDatabase(`postgresql://u:p@host/${name}`)
      ).toThrow(UnsafeIntegrationDatabaseError);
    }
  });

  it("refuses an unfamiliar name rather than assuming it is safe — fails CLOSED", () => {
    expect(() => assertSafeIntegrationDatabase("postgresql://u:p@host/something_else")).toThrow(
      UnsafeIntegrationDatabaseError
    );
  });

  it("refuses a URL naming no database at all, which could resolve to the server default", () => {
    expect(() => assertSafeIntegrationDatabase("postgresql://u:p@host")).toThrow(/names no database/);
  });

  it("refuses production regardless of letter case", () => {
    expect(() => assertSafeIntegrationDatabase("postgresql://u:p@host/FLY-DB")).toThrow(
      /REFUSING TO RUN AGAINST PRODUCTION/
    );
  });

  it("is not fooled by a production name appearing as a query parameter", () => {
    // The database is `carat_test`; `fly-db` here is only a parameter value.
    // This must PASS — a guard that rejects on substring matching would be
    // both wrong and, worse, would teach people the check is unreliable.
    expect(() =>
      assertSafeIntegrationDatabase(`${TEST_REMOTE}?application_name=fly-db`)
    ).not.toThrow();
  });
});

describe("assertSafeIntegrationDatabase — permitted targets", () => {
  it("allows the dedicated remote test database", () => {
    expect(() => assertSafeIntegrationDatabase(TEST_REMOTE)).not.toThrow();
  });

  it("allows a disposable local per-run database", () => {
    expect(() => assertSafeIntegrationDatabase(TEST_LOCAL)).not.toThrow();
  });

  it("allows the remote test database with connection parameters attached", () => {
    expect(() =>
      assertSafeIntegrationDatabase(`${TEST_REMOTE}?sslmode=require&connection_limit=25`)
    ).not.toThrow();
  });

  it("returns the target it approved, so callers can log what was actually used", () => {
    const target = assertSafeIntegrationDatabase(TEST_REMOTE);
    expect(target.databaseName).toBe("carat_test");
    expect(target.host).toBe("pgbouncer.n83v7rgjevlr5gxk.flympg.net");
  });
});

describe("GUARDS THE GUARD", () => {
  it("describeTarget extracts the database name rather than the whole path", () => {
    // If this ever returned "" or the full path, every refusal above would
    // pass for the wrong reason and the guard would be decorative.
    expect(describeTarget(PROD).databaseName).toBe("fly-db");
    expect(describeTarget(TEST_REMOTE).databaseName).toBe("carat_test");
  });

  it("the production name this guard protects is the one the cluster actually uses", () => {
    // Fly Managed Postgres named production `fly-db`; verified against
    // `fly mpg databases list` on 2026-09-27. If the cluster is ever renamed,
    // this test is the reminder to update PRODUCTION_DATABASE_NAMES.
    expect(PRODUCTION_DATABASE_NAMES).toContain("fly-db");
  });
});
