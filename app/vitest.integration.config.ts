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
    // 20s was sized when the seeded catalogue was small. Several pricing tests
    // call runPriceRecalculation with no variantIds, which sweeps EVERY active
    // variant in the shared disposable database — so their cost grows with the
    // suite, not with what they assert, and slice 2C's fixtures pushed two of
    // them past the limit. They fail as timeouts, never as wrong answers, and
    // they pass when run alone.
    //
    // Raised rather than scoped because scoping those runs means giving tests
    // that deliberately assert run-wide behaviour their own priceable
    // fixtures, which is slice-1 work. Recorded as follow-up F-2C-4 so the
    // real fix is not lost behind a bigger number.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    fileParallelism: false,
    globalSetup: ["./tests/integration/globalSetup.ts"],
    // setupFiles (unlike globalSetup) run inside each test worker's own
    // process, which is what actually needs DATABASE_URL/SHOPIFY_API_SECRET
    // populated from .env for getEnv()/prisma to see them.
    setupFiles: ["./tests/integration/setupEnv.ts"],
  },
});
