import "dotenv/config";

import { execSync } from "node:child_process";

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
  const runName = `carat_it_${process.pid}_${Date.now().toString(36)}`;
  const testUrl = new URL(process.env.INTEGRATION_DATABASE_URL ?? base);
  testUrl.pathname = `/${runName}`;

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

  // Point every worker at the disposable database. setupEnv.ts loads .env into
  // each worker, so this must win over whatever .env says.
  process.env.DATABASE_URL = testUrl.toString();

  console.log("Applying migrations and seed to the disposable database...");
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
  });
  execSync("npx tsx prisma/seed.ts", {
    stdio: "pipe",
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
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
      await runOnMaintenanceDb(admin, `DROP DATABASE IF EXISTS "${runName}" WITH (FORCE)`);
      console.log(`Dropped disposable integration database ${runName}.`);
    } catch (error) {
      // Never fail a green run on cleanup; report so it can be swept manually.
      console.warn(
        `Could not drop ${runName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
}
