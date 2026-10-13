import type { Config } from "@react-router/dev/config";

import {
  formatOriginDiagnostic,
  resolveAllowedActionOrigins,
} from "./app/lib/devActionOrigins";

// Defaults (appDirectory: "app", ssr: true) match the existing layout, so
// there is nothing to override yet. The file is optional in React Router 7
// (@react-router/dev treats a missing config as `{}`); it is committed so
// slice 2 has an obvious place to add configuration rather than inventing
// the file under time pressure.
//
// Slice 2 will need `allowedActionOrigins` here. React Router 7 added a CSRF
// origin guard that Remix v2 had no equivalent of: a mutation-method request
// to a route WITH a default export is rejected with 400 unless its Origin is
// allowlisted, and the default allowlist is empty. Resource routes (no
// default export) are exempt, which is why slice 0's four routes are
// unaffected. App Proxy form POSTs in slices 3/4/5/9/10 must therefore
// either stay resource routes or be allowlisted here. See
// docs/ARCHITECTURE-MVP1.md §2.1 "R-1".
//
// STOP before adding `future: { v8_middleware: true }` here. Middleware must
// never read the request body: `receiveShopifyWebhook` HMACs the exact bytes
// Shopify sent by calling request.text() itself, and a Request body is a
// one-shot stream. Any middleware calling request.text()/.json()/.formData()
// makes that throw on an already-read body, so every webhook 500s and burns
// Shopify's retry budget — with the fault in framework plumbing rather than in
// our code. Full contract in docs/ARCHITECTURE-MVP1.md §2.1. The other four
// v8_* flags are inert for us and are assessed in the same place.
// Startup diagnostic. Hosts only — never a token, never a secret. Printed
// because the failure it reports is otherwise invisible: an allowlist holding
// the WRONG host behaves exactly like a correct one until a form is submitted,
// and then produces a framework error naming neither the allowlist nor the
// host. That is precisely how the first attempt at this fix appeared to work.
// Development only. A production build has nothing to diagnose — the answer is
// always [] — and the config is evaluated several times per build, so leaving
// it unguarded printed the same line four times during `npm run build`.
if (process.env.NODE_ENV !== "production" && process.env.APP_ENV !== "production") {
  // A build-time developer diagnostic printed to the terminal, not application
  // logging: the app's structured logger is server-runtime only and cannot be
  // loaded from a config file.
  // eslint-disable-next-line no-console
  console.log(formatOriginDiagnostic(process.env));
}

export default {
  // FINDING F-23 — DECISION RECORD. The architecture (§2.1 "R-1") names two
  // acceptable mitigations for the guard described above. This app uses BOTH,
  // for two different call sites, deliberately rather than by accident:
  //
  // 1. App Proxy / webhook / cron POST endpoints (slices 3, 4, 5, 9, 10, and
  //    already app/routes/apps.carat.group-buy.$code.tsx,
  //    app/routes/internal.jobs.price-recalculation.tsx, and every
  //    app/routes/webhooks.*.tsx) — kept as RESOURCE ROUTES, i.e. no default
  //    export. The guard only ever runs against a route WITH a default
  //    export, so these are unconditionally exempt regardless of what this
  //    allowlist contains. This is the mitigation that matters in
  //    PRODUCTION: it does not depend on this field, on NODE_ENV, or on any
  //    env var being set correctly at deploy time. Verified against the
  //    built server 2026-09-19 (see the T10 handoff for the actual request/
  //    response evidence) — cross-origin POSTs to these routes reach our own
  //    auth/validation code (401/200) and never see the framework's 400.
  //
  // 2. The embedded admin UI route (app/routes/_index.tsx, the only route in
  //    this app with a default export) — uses the ALLOWLIST below, populated
  //    from the Shopify CLI's live tunnel env vars. This is a DEVELOPMENT-ONLY
  //    concern: the CLI tunnel's Origin and this server's request.url
  //    disagree by scheme and host behind `shopify app dev`, which rejected
  //    the first form POST from the embedded app with "Bad Request" before
  //    the action ran.
  //
  // WHY THE ALLOWLIST IS IRRELEVANT TO PRODUCTION SAFETY, NOT JUST EMPTY
  // THERE. `react-router build` resolves this file with Vite's default
  // NODE_ENV forced to "production" regardless of APP_ENV or any tunnel var
  // present at build time (confirmed 2026-09-19 against the installed
  // @react-router/dev@7.18.3 CLI source, which passes "production" as
  // defaultNodeEnv to every `vite.resolveConfig` build call). So every
  // production deploy — which is always produced by `build`, never `dev` —
  // gets `[]` here unconditionally; `describeAllowedActionOrigins`'s own
  // `isProduction` check is redundant during a build but still matters for
  // `react-router dev` sessions that set APP_ENV=production without changing
  // NODE_ENV. Production's real protection is (1) above, not this array.
  //
  // Scoped to exactly the origin currently serving the app, taken from the env
  // the Shopify CLI provides. Not a wildcard, not a global disable — the guard
  // stays fully active for every other origin. See app/lib/devActionOrigins.ts
  // for why a version bump does not fix this, and for why this resolver tries
  // several env vars instead of trusting the first one present.
  //
  // Wildcard patterns (e.g. the architecture's suggested "*.myshopify.com")
  // ARE supported by the installed react-router@7.18.3 — verified directly
  // against node_modules/react-router/dist/development/chunk-HT4INDD5.mjs's
  // `matchWildcardDomain`, and confirmed end-to-end against the built server
  // 2026-09-19 (a patched `allowedActionOrigins: ["*.myshopify.com"]` admitted
  // `Origin: https://shop.myshopify.com` and still rejected a bare
  // `https://myshopify.com` with no subdomain). Not used here because this
  // resolver only ever needs to name the one concrete tunnel host the CLI is
  // currently using, never a family of hosts — but the option is confirmed
  // available if a future slice needs it for something other than resource
  // routes.
  allowedActionOrigins: resolveAllowedActionOrigins(process.env),
} satisfies Config;
