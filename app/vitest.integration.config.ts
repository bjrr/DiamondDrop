// LOADED HERE TOO, AND THIS IS LOAD-BEARING. `INTEGRATION_DATABASE_URL` lives
// in `.env`, not the shell. `globalSetup.ts` and `setupEnv.ts` both import
// dotenv, but both run AFTER this config object is evaluated — so without
// this line `REMOTE_MODE` below is always false and the remote timeout below
// silently never applies. A config guard that cannot fire is worse than no
// guard, because it looks like protection in the diff.
import "dotenv/config";

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/** Mirrors `tests/integration/globalSetup.ts`'s own remote-mode signal — one variable decides both. */
const REMOTE_MODE = Boolean(process.env.INTEGRATION_DATABASE_URL);

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
    // TIMEOUTS ARE ENVIRONMENT-DEPENDENT, so they are derived, not fixed.
    //
    // 45s was calibrated against a LOCAL Postgres, where a query costs
    // microseconds. This suite now runs against a Fly-hosted test database
    // reached through `fly mpg proxy`, where every round trip crosses the
    // network. Tests that issue hundreds of queries — the pricing
    // recalculation ones especially, which walk many variants in one run —
    // are dominated by that latency and exceeded 45s purely because of where
    // the database lives, with no assertion ever failing.
    //
    // Raising it unconditionally would blunt the local signal, where a test
    // taking 45s genuinely means something is wrong. So the remote budget
    // applies only in remote mode, keyed on the same variable
    // `tests/integration/globalSetup.ts` uses to decide it is talking to a
    // remote database.
    //
    // SIZED FROM MEASUREMENT, NOT GUESSED. `pricing/job.test.ts` ran 7 tests
    // in 623s against the remote database — ~75s for a single
    // `runPriceRecalculation`. The heaviest tests run the job two or three
    // times (superseding an intent requires a prior run to supersede), so they
    // legitimately need 150-225s, and several exceeded a first attempt at
    // 180s. 600s covers the slowest real test with headroom instead of
    // inviting another round of per-test patches.
    //
    // This is a LATENCY allowance, not a hang allowance. It buys nothing but
    // time for queries that are genuinely in flight: a deadlocked query still
    // fails, later. The LOCAL budget stays at 45s precisely so that signal is
    // not blunted where queries cost microseconds and 45s really does mean
    // something is wrong.
    //
    // THE REAL FIX IS NOT HERE. These tests are slow because the pricing job
    // issues a very large number of small queries, which is free locally and
    // expensive across a network. Reducing that query count is money-critical
    // work and is not being done under a timeout's pressure — but this comment
    // is the reason the number is large, so nobody reads 600s as normal.
    testTimeout: REMOTE_MODE ? 600_000 : 45_000,
    hookTimeout: REMOTE_MODE ? 600_000 : 45_000,
    fileParallelism: false,
    globalSetup: ["./tests/integration/globalSetup.ts"],
    // setupFiles (unlike globalSetup) run inside each test worker's own
    // process, which is what actually needs DATABASE_URL/SHOPIFY_API_SECRET
    // populated from .env for getEnv()/prisma to see them.
    setupFiles: ["./tests/integration/setupEnv.ts"],
  },
});
