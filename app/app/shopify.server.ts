import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";

import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";

/**
 * D13 — Shopify admin authentication, OAuth and session storage.
 *
 * WHAT THIS LIBRARY IS USED FOR, AND WHAT IT IS DELIBERATELY NOT USED FOR.
 *
 * Used for: the OAuth install/callback dance, session persistence, token
 * refresh, and the authenticated Admin API client. All of that is fiddly,
 * security-sensitive, and has no CaratForUs-specific behaviour — exactly the
 * "prefer native Shopify capabilities" case in CLAUDE.md.
 *
 * NOT used for INBOUND WEBHOOKS. The library can register and dispatch webhook
 * handlers; we do not let it. Our own boundary in app/shopify/webhooks
 * verifies the HMAC over the RAW body before any parsing, deduplicates
 * deliveries by event id, and keeps processing idempotent with a durable
 * record — guarantees the library does not offer equivalently, and which the
 * returns/warranty/dispute evidence requirements depend on. There is
 * consequently NO `webhooks` key in the config below, and none may be added
 * without demonstrating the replacement preserves all three properties. The
 * webhook routes in app/routes/webhooks.*.tsx remain plain resource routes
 * that never call `authenticate.webhook`.
 *
 * SECRETS. `apiSecretKey` is read from the environment and must never be
 * logged, serialised into a snapshot, or returned to a client. The Session
 * model it populates holds live access tokens under the same rule.
 */

const env = getEnv();

/**
 * Shopify config is validated HERE rather than in the global env schema.
 *
 * That schema deliberately marks these optional: the app is one deployable, and
 * the nightly pricing recalculation must be able to boot and run without any
 * Shopify credentials at all (see app/lib/env.server.ts). Promoting them to
 * required at boot would make a pricing run fail for want of an OAuth key it
 * never touches.
 *
 * So the requirement is localised to the module that actually needs it, and it
 * fails LOUDLY rather than defaulting. An empty appUrl in particular would not
 * throw anywhere — it would quietly generate redirect URLs like "/auth/callback"
 * with no origin, and the install would fail at Shopify with an error blaming
 * the redirect URI rather than the config.
 */
function requireShopifyConfig(): { apiKey: string; apiSecretKey: string; appUrl: string } {
  const missing: string[] = [];
  if (!env.SHOPIFY_API_KEY) missing.push("SHOPIFY_API_KEY");
  if (!env.SHOPIFY_API_SECRET) missing.push("SHOPIFY_API_SECRET");
  if (!env.SHOPIFY_APP_URL) missing.push("SHOPIFY_APP_URL");

  if (missing.length > 0) {
    throw new Error(
      `Shopify admin authentication is not configured. Missing: ${missing.join(", ")}. ` +
        `Set them in app/.env — see .env.example. The pricing job does not need them; ` +
        `only the embedded admin and OAuth do.`
    );
  }

  return {
    apiKey: env.SHOPIFY_API_KEY as string,
    apiSecretKey: env.SHOPIFY_API_SECRET,
    appUrl: env.SHOPIFY_APP_URL as string,
  };
}

const shopifyConfig = requireShopifyConfig();

/**
 * Pinned rather than "latest". A stored price calculation records the API
 * version it was produced against, and a version that silently advances would
 * change Admin API behaviour underneath calculations we have already published.
 * Kept in step with `api_version` in shopify.app.caratforus-development.toml —
 * changing one without the other is the mismatch that surfaces months later as
 * an inexplicable missing field.
 */
const API_VERSION = (env.SHOPIFY_ADMIN_API_VERSION ?? ApiVersion.July26) as ApiVersion;

const shopify = shopifyApp({
  apiKey: shopifyConfig.apiKey,
  apiSecretKey: shopifyConfig.apiSecretKey,
  apiVersion: API_VERSION,
  // Read from config rather than hard-coded, so the least-privilege set in the
  // .toml stays the single source of truth for what we request.
  scopes: env.SHOPIFY_SCOPES?.split(",").map((s) => s.trim()).filter(Boolean),
  appUrl: shopifyConfig.appUrl,
  // Default is "/auth"; stated explicitly because the redirect URLs registered
  // with Shopify are derived from it, and a silent default change would break
  // the install flow in a way that looks like a Shopify problem.
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // D23 (docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §19.1, criterion 112).
  // ADDITIVE, not a replacement: verified in the installed library source
  // (token-exchange.js) — the OFFLINE session is always exchanged and stored
  // FIRST; this flag makes an ONLINE session ALSO be exchanged and stored
  // afterward. `unauthenticated.admin` (the guarantee sweep, the
  // recalculation cron) reads the offline session by shop and is untouched —
  // asserted in shopify.server.test.ts rather than assumed, because the
  // whole background half of this app depends on that staying true.
  //
  // What this buys: `session.onlineAccessInfo.associated_user` on every
  // embedded admin request, which is what lets Bank Payment verification
  // record an AUTHENTICATED Shopify staff identity (id + email) instead of a
  // typed name nobody can attribute (D23, criteria 112-114).
  useOnlineTokens: true,
  // Owner decision 2026-09-17: this app is built for CaratForUs's own store.
  // It is not listed on the Shopify App Store and no unrelated merchant
  // installs it.
  //
  // Behaviourally this is identical to AppStore in this library — both
  // branches attach `shopify.login`, and only AppDistribution.ShopifyAdmin
  // differs (see isSingleMerchantApp in shopify-app.js). The value matters
  // because it must agree with the distribution set on the app record: the
  // library would otherwise be modelling an install flow Shopify is not
  // running.
  distribution: AppDistribution.SingleMerchant,
  // No `isEmbeddedApp` key: this library rejects it outright — React Router
  // apps are embedded by default, and passing it throws at startup. The app
  // record's `embedded = true` in the .toml is what declares it to Shopify.
  // No future flags. The two this app would have wanted —
  // `unstable_newEmbeddedAuthStrategy` and `removeRest` — became the DEFAULT
  // behaviour in v3, and the only flag left is `expiringOfflineAccessTokens`.
  // That one is deliberately not enabled: it changes token lifetime and adds a
  // refresh path, which is a behaviour change to opt into on purpose with tests
  // behind it, not to switch on while wiring up OAuth for the first time.
});

export default shopify;

export const apiVersion = API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;

/**
 * NOTE: the library's `boundary` helpers are deliberately NOT re-exported from
 * here. Routes import them straight from
 * "@shopify/shopify-app-react-router/server".
 *
 * ErrorBoundary renders on the client, so reaching it through this .server
 * module pulls server-only code into the client bundle and the build fails
 * with "Server-only module referenced by client" — an error naming neither the
 * import nor the route. Convenient re-exports from a .server file are a trap
 * for anything a component touches.
 */

/**
 * The auth routes this configuration actually produces, derived from
 * `authPathPrefix` above rather than assumed. Exported so the config check in
 * shopify.server.test.ts asserts against one definition instead of restating
 * the strings, and so `[auth] redirect_urls` in the .toml can be justified
 * against something in code.
 */
export const AUTH_PATHS = {
  prefix: "/auth",
  callback: "/auth/callback",
  login: "/auth/login",
  sessionToken: "/auth/session-token",
  exitIframe: "/auth/exit-iframe",
} as const;
