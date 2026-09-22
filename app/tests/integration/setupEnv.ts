// Runs inside each integration test worker process — populates
// process.env from .env before any test module (or the app code it
// imports) reads configuration. See vitest.integration.config.ts.
import "dotenv/config";

// Lets the D15 write-surface test observe every statement the shared Prisma
// client issues. Must be set BEFORE app/db/client.server.ts constructs the
// client, which is why it lives here rather than inside the test file.
process.env.PRISMA_EMIT_QUERY_EVENTS = "1";

/**
 * DEPLOYMENT SETTINGS MUST NOT REACH THE TEST SUITE.
 *
 * `PRICE_AUTO_PUBLISH_ENABLED` is a real operational switch, turned on in
 * `app/.env` for dev verification. Several suites assert the behaviour of the
 * DEFAULT (auto-publish off) and were passing only because the variable
 * happened to be unset — so flipping a deployment flag turned three
 * money-critical pricing tests red, pointing at the pricing engine rather than
 * at the config that actually changed.
 *
 * Deleting it here, once, is the fix rather than per-file teardown: the
 * default belongs to the harness, and a suite that wants auto-publish on says
 * so explicitly by passing `autoPublishEnabled: true` to the job, which is
 * what every such test already does.
 *
 * Do not "restore" the ambient value. A test run that behaves differently
 * depending on the developer's .env is the problem being removed.
 */
process.env.PRICE_AUTO_PUBLISH_ENABLED = "";

/**
 * Same reasoning as the line above, and the second time this exact thing has
 * happened: configuring the real Resend channel in `app/.env` turned four
 * integration tests red — tests that assert the HONEST `skipped_unconfigured`
 * behaviour and were passing only because the developer's environment
 * happened to have no email credentials.
 *
 * A suite that behaves differently depending on whether someone has set up
 * email locally is not testing the code. Every test that needs a working
 * channel injects a fake `EmailPort` already, so removing the ambient one
 * costs nothing and removes the accident.
 */
// ASSIGNED EMPTY, NOT DELETED. A delete is undone the next time anything
// pulls in dotenv — and something does, which is why the first version of
// this fix left the suite still sending real email. dotenv never overwrites
// a key that already exists, so an empty string survives, and
// resolveEmailPort treats empty exactly as missing.
process.env.EMAIL_API_KEY = "";
process.env.EMAIL_FROM = "";
process.env.STAFF_EMAIL_ALLOWLIST = "";

/**
 * The deletes above are worthless without this. `loadEnv()` memoises after its
 * first read, so anything that touched `getEnv()` while this file was being
 * imported would have cached the ambient values and the deletions would change
 * nothing — which is exactly what happened on the first attempt at this fix.
 */
const { __resetEnvCacheForTests } = await import("~/lib/env.server");
__resetEnvCacheForTests();
