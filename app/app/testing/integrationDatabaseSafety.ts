/**
 * THE GUARD THAT STANDS BETWEEN THE INTEGRATION SUITE AND PRODUCTION DATA.
 *
 * Integration tests migrate, reset and drop. Production and test now live on
 * the SAME Fly Managed Postgres cluster (`caratforus-db`) — production in
 * database `fly-db`, tests in `carat_test` — so host, port, username and
 * password are IDENTICAL between them. The database NAME is the only thing
 * separating a test run from destroying the business.
 *
 * That is too thin a margin to leave to whoever edits an env var next, so
 * this refuses to let the suite start unless the target is provably a test
 * database. It runs BEFORE any schema reset, migration or drop.
 *
 * DESIGN NOTES, because the temptation to loosen this will come:
 *
 * 1. ALLOWLIST, NOT DENYLIST. A denylist of "not fly-db" fails open for every
 *    database nobody thought of. Only names that are unmistakably ours-and-
 *    disposable are permitted.
 * 2. THE PRODUCTION NAME IS *ALSO* REFUSED EXPLICITLY, even though the
 *    allowlist already excludes it. Redundant on purpose: if someone ever
 *    widens the allowlist, this still catches the one name that matters.
 * 3. NO ESCAPE HATCH. There is deliberately no environment variable that
 *    disables this. An override flag is the thing that gets set once "just to
 *    check something" and then lives in a shell profile forever.
 * 4. It reports what it saw, never the password.
 */

/** Production's database name on the shared cluster. Never a test target. */
export const PRODUCTION_DATABASE_NAMES: readonly string[] = ["fly-db", "carat_prod", "caratforus"];

/**
 * A target is acceptable only if its name matches one of these:
 *   - `carat_test`        the dedicated Fly test database
 *   - `carat_it_<run>`    a disposable per-run database (local Postgres)
 */
const ALLOWED_DATABASE_NAME = /^(carat_test|carat_it_[a-z0-9_]+)$/i;

export interface DatabaseTarget {
  readonly databaseName: string;
  readonly host: string;
}

export function describeTarget(databaseUrl: string): DatabaseTarget {
  const url = new URL(databaseUrl);
  return {
    databaseName: url.pathname.replace(/^\//, "").split("?")[0] ?? "",
    host: url.hostname,
  };
}

export class UnsafeIntegrationDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeIntegrationDatabaseError";
  }
}

/**
 * Throws unless `databaseUrl` names a database the integration suite is
 * allowed to destroy. Call before ANY destructive statement.
 */
export function assertSafeIntegrationDatabase(databaseUrl: string): DatabaseTarget {
  const target = describeTarget(databaseUrl);

  if (target.databaseName === "") {
    throw new UnsafeIntegrationDatabaseError(
      "Refusing to run: the integration database URL names no database at all. " +
        "A URL with no database path can resolve to the server's default database, which may be production."
    );
  }

  const lowered = target.databaseName.toLowerCase();

  if (PRODUCTION_DATABASE_NAMES.some((n) => n.toLowerCase() === lowered)) {
    throw new UnsafeIntegrationDatabaseError(
      `REFUSING TO RUN AGAINST PRODUCTION. The integration suite was pointed at database ` +
        `"${target.databaseName}" on host "${target.host}", which is a production database name. ` +
        `Integration tests migrate, reset and drop — this would have destroyed live data. ` +
        `Point INTEGRATION_DATABASE_URL at the carat_test database instead.`
    );
  }

  if (!ALLOWED_DATABASE_NAME.test(target.databaseName)) {
    throw new UnsafeIntegrationDatabaseError(
      `Refusing to run: database "${target.databaseName}" on host "${target.host}" is not a recognised ` +
        `test database. The integration suite may only touch "carat_test" or a disposable "carat_it_*" ` +
        `database, because it migrates, resets and drops. If this really is a test database, rename it ` +
        `rather than widening this check — the allowlist exists so that an unfamiliar name fails closed.`
    );
  }

  return target;
}
