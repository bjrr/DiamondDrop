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
 * THE SHOP EVERY APP PROXY TEST SIGNS AS (register D4).
 *
 * Since D4, `verifyAppProxySignature` refuses any request whose signed `shop`
 * does not equal `getEnv().SHOPIFY_SHOP_DOMAIN`, and refuses EVERYTHING when
 * that is unset (`expected_shop_unconfigured`). CI never set it, so every
 * proxy-route integration test that expects success got 401. The tests had
 * only passed where a developer's `.env` happened to name the dev store.
 *
 * Every proxy test file signs as `caratforus-dev.myshopify.com` (their own
 * `const SHOP`), so the harness pins exactly that, overwriting `.env` for the
 * same reason as the values below: test behaviour must not depend on local
 * secrets. This configures the fence; it does not loosen it — a request
 * signed as any other shop is still refused (proxy/verify.test.ts).
 */
process.env.SHOPIFY_SHOP_DOMAIN = "caratforus-dev.myshopify.com";

/**
 * OBVIOUSLY-FAKE BANK PAYMENT COORDINATES, SET UNCONDITIONALLY.
 *
 * Group Buy Bank Payment checkout now fails closed with 503 when payment
 * coordinates are missing — it refuses to create an order it cannot tell the
 * customer how to pay for. That is correct, and it means the suite must
 * supply coordinates or every checkout test would assert against a 503 and
 * quietly stop testing checkout at all.
 *
 * SET HERE, NOT READ FROM `.env`, and deliberately overwriting whatever is
 * there. The same reasoning as `PRICE_AUTO_PUBLISH_ENABLED` above: a test run
 * whose behaviour depends on a developer's local secrets is the problem being
 * removed. It also guarantees that if REAL coordinates ever land in a
 * developer's `.env`, no test can email them anywhere or assert on them.
 *
 * The values are visibly unusable on purpose — `.invalid` is reserved by
 * RFC 2606 and all-zero routing/account numbers are not valid anywhere.
 */
process.env.PAYMENT_ZELLE_RECIPIENT = "test-pay@example.invalid";
process.env.PAYMENT_WIRE_BANK_NAME = "TEST BANK — NOT REAL";
process.env.PAYMENT_WIRE_ACCOUNT_NAME = "TEST ACCOUNT — NOT REAL";
process.env.PAYMENT_WIRE_ROUTING_NUMBER = "000000000";
process.env.PAYMENT_WIRE_ACCOUNT_NUMBER = "000000000000";

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
