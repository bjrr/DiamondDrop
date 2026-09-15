import type { Config } from "@react-router/dev/config";

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
export default {} satisfies Config;
