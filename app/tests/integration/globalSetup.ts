import "dotenv/config";

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

export default async function setup() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "Integration tests require DATABASE_URL to point at a migrated Postgres database. " +
        "Run `docker-compose up -d` (from repo root) and `npm run db:migrate` first (see app/README.md)."
    );
  }

  // Ensure the production server bundle exists. If not, build it.
  // This is necessary for the HTTP server integration test, and also ensures
  // CI can run integration tests even if the build step was not explicitly run first.
  const buildPath = resolve(process.cwd(), "build/server/index.js");
  if (!existsSync(buildPath)) {
    console.log("build/server/index.js not found; running npm run build...");
    try {
      execSync("npm run build", { stdio: "inherit", cwd: process.cwd() });
    } catch (error) {
      throw new Error(
        `Failed to build the server bundle. Run \`npm run build\` manually to see the error. ` +
          `(Original error: ${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
}
