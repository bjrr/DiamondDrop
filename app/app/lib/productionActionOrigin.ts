/**
 * The app's own production host, allowed through React Router's CSRF origin
 * guard (`allowedActionOrigins`). Register D11.
 *
 * THE DEFECT THIS FIXES. Fly terminates TLS at its proxy and forwards plain
 * HTTP. react-router-serve never enables Express's `trust proxy`, so
 * `request.url` is rebuilt as `http://caratforus.fly.dev/…`, while the
 * embedded admin's browser sends `Origin: https://caratforus.fly.dev`.
 * React Router's `throwIfPotentialCSRFAttack` compares FULL origins (scheme
 * included), sees a mismatch, finds the host absent from the allowlist — which
 * was `[]` in production by design (see devActionOrigins.ts) — and rejects
 * every UI-route action with 400 before authentication or the action runs.
 * Every save under /app failed in production; the first live write (Pricing
 * Settings, 2026-10-24) was where it surfaced.
 *
 * WHY THIS IS SAFE. The guard checks the Origin's HOST against this list.
 * Allowing our own host admits only requests whose Origin is this app itself —
 * the same-origin case the guard was always meant to allow, misjudged only
 * because the scheme was lost at the proxy. Every other origin is still
 * rejected. It is a single concrete host, never a pattern.
 *
 * MUST EQUAL the host of `application_url` in the Shopify app TOML; a test
 * enforces that, so a host change cannot leave this behind.
 */
export const PRODUCTION_APP_HOST = "caratforus.fly.dev";
