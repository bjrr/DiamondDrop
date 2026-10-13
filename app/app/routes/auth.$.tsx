import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "~/shopify.server";

/**
 * D13 — the Shopify OAuth surface: `/auth/*`.
 *
 * A splat route, so every path under the configured `authPathPrefix` lands
 * here: `/auth/callback`, `/auth/login`, `/auth/session-token` and
 * `/auth/exit-iframe`. Those paths are the library's, derived from
 * `authPathPrefix: "/auth"` in shopify.server.ts — not chosen here. This route
 * only has to exist and hand the request over; `authenticate.admin` performs
 * the exchange and issues the redirect.
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as the webhook and cron
 * routes (architecture §2.1, finding F-23): React Router 7's
 * `throwIfPotentialCSRFAttack` rejects mutation-method requests to routes WITH
 * a default export unless the Origin is allowlisted, and the default allowlist
 * is empty. Shopify's callback arrives from Shopify's origin, so a default
 * export here would produce a 400 before any of our code ran, and the failure
 * would look like a Shopify problem rather than a framework one.
 *
 * DO NOT ADD A DEFAULT EXPORT without re-reading F-23.
 *
 * This route deliberately handles NO webhooks. Inbound webhooks keep their own
 * boundary in app/routes/webhooks.*.tsx, which verifies the HMAC over the raw
 * body before parsing, deduplicates by event id, and processes idempotently.
 * `authenticate.webhook` is not used anywhere in this codebase.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  // Unreachable in practice: `authenticate.admin` either throws a redirect or
  // throws an error. Returning null keeps the loader's type honest rather than
  // asserting a Response we never construct.
  return null;
}
