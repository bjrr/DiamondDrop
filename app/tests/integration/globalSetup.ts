import "dotenv/config";

import { execSync } from "node:child_process";

import { assertSafeIntegrationDatabase } from "~/testing/integrationDatabaseSafety";

/**
 * Integration setup: a DISPOSABLE database, then the server bundle.
 *
 * WHY A DISPOSABLE DATABASE (architect ruling, 2026-09-17, finding F-29).
 *
 * The suite used to run against the same `carat_dev` used for manual
 * verification. Several pricing tables are append-only at the database level,
 * so rows written by a test can never be deleted — and the fixtures create
 * `pricing_profile` rows in the live `buy_now` namespace. Sixty-two of them
 * accumulated, several outranking the real seeded D14 placeholder, which meant
 * the placeholder guard could no longer be demonstrated in that database: a
 * stray test profile with realistic-looking values resolved instead.
 *
 * That is not untidiness, it is loss of evidentiary value in exactly the area
 * the tests exist to protect. So each run gets its own database, created here
 * and dropped at the end, leaving `carat_dev` untouched.
 *
 * Set `INTEGRATION_DATABASE_URL` to override, or `KEEP_TEST_DATABASE=1` to
 * retain it for post-mortem inspection after a failing run.
 */

function adminUrl(databaseUrl: string): { admin: string; name: string } {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "").split("?")[0]!;
  url.pathname = "/postgres";
  return { admin: url.toString(), name };
}

/**
 * Runs a statement against the `postgres` maintenance database.
 *
 * Uses Prisma rather than shelling out to `psql` so the suite needs no
 * PostgreSQL client binary on PATH — one fewer thing to install on a CI
 * runner, and no shell-quoting differences between platforms.
 *
 * CREATE DATABASE and DROP DATABASE cannot run inside a transaction, which is
 * why this uses $executeRawUnsafe on a dedicated connection rather than the
 * app's client.
 */
async function runOnMaintenanceDb(connection: string, sql: string): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: connection } } });
  try {
    await client.$executeRawUnsafe(sql);
  } finally {
    await client.$disconnect();
  }
}

/**
 * Remote mode: an explicit INTEGRATION_DATABASE_URL means a real, named test
 * database (today `carat_test` on the shared Fly cluster) rather than a
 * disposable one we create. The distinction changes how the database is
 * prepared and torn down, so it is computed once.
 */
const REMOTE_MODE = Boolean(process.env.INTEGRATION_DATABASE_URL);

export default async function setup() {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Integration tests require DATABASE_URL to point at a reachable Postgres server. " +
        "See app/README.md for the local setup."
    );
  }

  // A per-run name. Deliberately not random-free: two runs must never share a
  // database, or one run's append-only rows become the other's surprise.
  // REMOTE MODE when INTEGRATION_DATABASE_URL is set: that URL already names
  // the database to use (`carat_test` on the Fly cluster) and we use it AS
  // GIVEN rather than deriving a per-run name from it. LOCAL MODE keeps the
  // disposable-database behaviour, which is better when it is available.
  const runName = `carat_it_${process.pid}_${Date.now().toString(36)}`;
  const testUrl = new URL(process.env.INTEGRATION_DATABASE_URL ?? base);
  if (!REMOTE_MODE) {
    testUrl.pathname = `/${runName}`;
  }

  // EXPLICIT CONNECTION PARAMETERS, because the defaults made one test
  // measure the machine instead of the code.
  //
  // warrantyClaimRepository.test.ts's "collision-safe under real
  // concurrency" case fires 12 parallel submitClaim() calls and kept
  // failing with P1001 "Can't reach database server at localhost:5432",
  // thrown from fixture setup before a single claim reference was
  // generated. It was written off as a flake three times, including by me.
  // It is not a flake: it reproduces in ISOLATION with nothing else running,
  // which refutes the "parallel with the rest of the suite" explanation
  // recorded in that test's own comment.
  //
  // It is also NOT connection exhaustion, the other recorded explanation:
  // the server reports max_connections 100 with 6 in use. What actually
  // happens is that establishing a burst of new connections on a loaded
  // machine exceeds Prisma's 5-SECOND default connect_timeout — the failing
  // run took 5631ms, just past that ceiling — and Prisma reports a connect
  // timeout as "can't reach the server", which reads like the database is
  // down and sent three separate diagnoses chasing the wrong thing.
  //
  // THE NUMBERS MATTER, and my first attempt got them wrong in an
  // instructive way. connection_limit=10 replaced the P1001 with P2024
  // ("Timed out fetching a new connection from the connection pool"):
  // createWarrantyClaim wraps its work in an INTERACTIVE TRANSACTION, which
  // holds one connection for its whole duration, so 12 concurrent callers
  // against a 10-connection pool starve by construction. The limit must sit
  // ABOVE the highest concurrency any test uses, not below it.
  //
  // 25 clears the 12-way test with headroom. connect_timeout and
  // pool_timeout at 30s cover both ways this can fail on a loaded machine —
  // establishing a connection, and waiting for a free one.
  //
  // No assertion is weakened: the concurrency test still issues all 12
  // requests concurrently and still proves distinct references. It now takes
  // ~19s and actually REACHES that assertion, where before it died in
  // fixture setup. Callers may override all three.
  if (!testUrl.searchParams.has("connection_limit")) {
    testUrl.searchParams.set("connection_limit", "25");
  }
  if (!testUrl.searchParams.has("connect_timeout")) {
    testUrl.searchParams.set("connect_timeout", "30");
  }
  if (!testUrl.searchParams.has("pool_timeout")) {
    testUrl.searchParams.set("pool_timeout", "30");
  }

  // THE SAFETY CHECK, BEFORE ANY DESTRUCTIVE STATEMENT.
  //
  // Production and test share one Fly Managed Postgres cluster — production
  // in `fly-db`, tests in `carat_test` — so host, port, user and password are
  // identical between them and the database NAME is the only separation. This
  // suite migrates, resets and drops, so it must prove its target is a test
  // database before it does anything at all. See databaseSafety.ts.
  const safeTarget = assertSafeIntegrationDatabase(testUrl.toString());

  if (REMOTE_MODE) {
    // A SHARED REMOTE CLUSTER IS NOT A PLACE TO CHURN DATABASES.
    //
    // Locally we create a disposable database per run, which is ideal: perfect
    // isolation and nothing to clean up. On the managed cluster that would
    // mean CREATE/DROP DATABASE against the same server production runs on,
    // and would require granting the test role CREATEDB there — a privilege
    // worth not having. So the fixed `carat_test` database is reset instead:
    // same end state, no database-level privileges, no churn next to
    // production.
    //
    // DROP SCHEMA is destructive by design and is exactly why the assertion
    // above runs first and has no override flag.
    console.log(`Resetting remote test database ${safeTarget.databaseName} on ${safeTarget.host}...`);
    // DROP THE OBJECTS, NOT THE SCHEMA. `DROP SCHEMA public CASCADE` is the
    // obvious reset and it fails here with "must be owner of schema public":
    // on Fly Managed Postgres the application role owns the TABLES it creates
    // but not the schema itself. So this drops every table and enum type in
    // `public` instead, which reaches the same end state with the privileges
    // we actually have.
    //
    // Enum types need their own pass — Prisma creates a type per enum, and a
    // leftover type collides on the next `migrate deploy` with "type already
    // exists" even after every table is gone.
    //
    // One DO block per call, because Prisma sends raw SQL as a prepared
    // statement and Postgres rejects multiple commands in one.
    await runOnMaintenanceDb(
      testUrl.toString(),
      `DO $$ DECLARE r RECORD; BEGIN
         FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
           EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
         END LOOP;
       END $$`
    );
    await runOnMaintenanceDb(
      testUrl.toString(),
      `DO $$ DECLARE r RECORD; BEGIN
         FOR r IN SELECT t.typname FROM pg_type t
                  JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
           EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
         END LOOP;
       END $$`
    );
  } else {
    const { admin } = adminUrl(base);

    console.log(`Creating disposable integration database ${runName}...`);
    try {
      await runOnMaintenanceDb(admin, `CREATE DATABASE "${runName}"`);
    } catch (error) {
      throw new Error(
        `Could not create the integration database. The DATABASE_URL role must be ` +
          `allowed to CREATE DATABASE. ` +
          `(${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  // Point every worker at the disposable database. setupEnv.ts loads .env into
  // each worker, so this must win over whatever .env says.
  //
  // DIRECT_URL MUST BE OVERRIDDEN TOO, NOT ONLY DATABASE_URL. schema.prisma's
  // datasource comment is explicit that `directUrl` is what the Prisma CLI
  // (migrate/db push/introspect) actually connects through, while the app's
  // Prisma Client reads the pooled `url` (DATABASE_URL). Overriding only
  // DATABASE_URL left `migrate deploy` below applying every migration to
  // whatever `carat_dev` (or wherever .env's DIRECT_URL happens to point)
  // instead of this run's disposable database — which then had no tables at
  // all, so the seed step immediately failed with "table does not exist" on
  // the very first model it touched. Discovered while validating Slice 3
  // task 3-1's migration: it kept "succeeding" against the shared dev
  // database silently while the disposable-DB run it was supposedly
  // exercising had nothing in it.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.DIRECT_URL = testUrl.toString();

  console.log("Applying migrations and seed to the disposable database...");
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl.toString(), DIRECT_URL: testUrl.toString() },
  });
  execSync("npx tsx prisma/seed.ts", {
    stdio: "pipe",
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl.toString(), DIRECT_URL: testUrl.toString() },
  });

  // Build the server bundle UNCONDITIONALLY. httpServer.test.ts mounts the
  // built bundle to assert webhook HMAC behaviour over real HTTP, so the
  // bundle must reflect the current source tree.
  //
  // Deliberately not guarded by `existsSync` (architect ruling 2026-09-15).
  // A stale `build/` satisfies an existence check while containing none of
  // the code under test, and that is true precisely in the highest-risk case:
  // someone edits receive.server.ts, runs the suite without rebuilding, and
  // gets a green run against the previous bundle — a false green on the only
  // test guarding webhook authentication. An mtime-based staleness check is
  // not a safe middle ground either: to be correct it would have to cover the
  // whole transitive source graph, and a subtly wrong one produces the same
  // false green while inspiring more confidence.
  //
  // CI still runs `npm run build` as its own step so a build error fails with
  // its own attribution rather than as "integration setup failed".
  console.log("Building server bundle for integration tests...");
  try {
    execSync("npm run build", { stdio: "inherit", cwd: process.cwd() });
  } catch (error) {
    throw new Error(
      `Failed to build the server bundle. Run \`npm run build\` manually to see the error. ` +
        `(Original error: ${error instanceof Error ? error.message : String(error)})`
    );
  }

  return async () => {
    if (process.env.KEEP_TEST_DATABASE === "1") {
      console.log(`Keeping ${runName} for inspection (KEEP_TEST_DATABASE=1).`);
      return;
    }
    try {
      if (REMOTE_MODE) {
        // Nothing to drop: the remote test database is long-lived and is
        // reset at the START of each run instead. Dropping it would need
        // database-level privileges on a cluster that also hosts production,
        // which is precisely what remote mode avoids.
        return;
      }
      await runOnMaintenanceDb(adminUrl(base).admin, `DROP DATABASE IF EXISTS "${runName}" WITH (FORCE)`);
      console.log(`Dropped disposable integration database ${runName}.`);
    } catch (error) {
      // Never fail a green run on cleanup; report so it can be swept manually.
      console.warn(
        `Could not drop ${runName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}
