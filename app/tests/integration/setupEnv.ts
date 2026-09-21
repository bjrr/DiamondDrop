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
delete process.env.PRICE_AUTO_PUBLISH_ENABLED;
