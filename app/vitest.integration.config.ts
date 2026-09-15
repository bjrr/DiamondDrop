import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Integration tests require a real, migrated Postgres reachable via
// DATABASE_URL (docker-compose locally, a service container in CI).
// Run sequentially (no parallel file execution) so concurrency tests that
// intentionally race two DB writes are not confused by unrelated parallel
// activity against the same tables.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
    globalSetup: ["./tests/integration/globalSetup.ts"],
    // setupFiles (unlike globalSetup) run inside each test worker's own
    // process, which is what actually needs DATABASE_URL/SHOPIFY_API_SECRET
    // populated from .env for getEnv()/prisma to see them.
    setupFiles: ["./tests/integration/setupEnv.ts"],
  },
});
