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
  // RESOLVED HERE, applied by slice 2. The guard described above rejected the
  // first form POST from the embedded app with "Bad Request" before the action
  // ran, because behind the CLI tunnel the Origin header and request.url origin
  // disagree by both scheme and host.
  //
  // Scoped to exactly the origin currently serving the app, taken from the env
  // the Shopify CLI provides, and empty in production. Not a wildcard, not a
  // global disable — the guard stays fully active for every other origin. See
  // app/lib/devActionOrigins.ts for why a version bump does not fix this.
  allowedActionOrigins: resolveAllowedActionOrigins(process.env),
} satisfies Config;
