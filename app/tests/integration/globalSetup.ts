import "dotenv/config";

import { execSync } from "node:child_process";

export default async function setup() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "Integration tests require DATABASE_URL to point at a migrated Postgres database. " +
        "Run `docker-compose up -d` (from repo root) and `npm run db:migrate` first (see app/README.md)."
    );
  }

  // Build the server bundle UNCONDITIONALLY. httpServer.test.ts mounts the
  // built bundle to assert webhook HMAC behaviour over real HTTP, so the
  // bundle must reflect the current source tree.
  //
  // Deliberately not guarded by `existsSync` (architect ruling 2026-09-15).
  // A stale `build/` satisfies an existence check while containing none of
  // the code under test, and that is true precisely in the highest-risk
  // case: someone edits receive.server.ts, runs the integration suite
  // without rebuilding, and gets a green run against the previous bundle —
  // a false green on the only test guarding webhook authentication. An
  // mtime-based staleness check is not a safe middle ground either: to be
  // correct it would have to cover the whole transitive source graph, and a
  // subtly wrong staleness check produces the same false green while
  // inspiring more confidence. The build costs ~2s; the failure it prevents
  // is silent.
  //
  // CI still runs `npm run build` as its own explicit step. That duplication
  // is intentional — a build error should fail with its own attribution
  // rather than surfacing as "integration setup failed".
  console.log("Building server bundle for integration tests...");
  try {
    execSync("npm run build", { stdio: "inherit", cwd: process.cwd() });
  } catch (error) {
    throw new Error(
      `Failed to build the server bundle. Run \`npm run build\` manually to see the error. ` +
        `(Original error: ${error instanceof Error ? error.message : String(error)})`
    );
  }
}
