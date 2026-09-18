/**
 * Resolves the origins allowed to submit actions to UI routes (React Router's
 * `allowedActionOrigins`).
 *
 * THE PROBLEM THIS SOLVES. React Router 7 guards mutation-method requests to
 * routes with a default export. From the installed source:
 *
 *     let requestUrl = new URL(request.url);
 *     let originMatchesRequest = originUrl.origin === requestUrl.origin;
 *     if (originDomain && !originMatchesRequest) { ...reject... }
 *
 * Behind the Shopify CLI tunnel those two never agree. The browser sends
 * `Origin: https://<random>.trycloudflare.com` — the origin the document was
 * served from — while the dev server builds `request.url` from the local
 * listener, `http://localhost:<port>/…`. Different scheme, different host, so
 * every POST is rejected before the action runs. GET is unaffected, which is
 * why loaders and the Admin API read worked while the first form submission
 * did not.
 *
 * WHY NOT JUST UPGRADE. This is not a framework bug: react-router 7.18.4 ships
 * a byte-identical implementation of that check. `allowedActionOrigins` is the
 * documented mechanism, and its own error text calls the request "a forwarded
 * action request".
 *
 * WHY NOT A WILDCARD. `**.trycloudflare.com` would work and would also trust
 * every Cloudflare quick tunnel on the internet. Unnecessary: the Shopify CLI
 * exports the tunnel origin to the dev process, so exactly one host can be
 * allowed — the one currently serving the app.
 */

/**
 * Environment the CLI provides to the process it launches. It sets HOST and
 * APP_URL to the tunnel origin, alongside APP_ENV=development.
 */
export interface OriginEnv {
  NODE_ENV?: string;
  APP_ENV?: string;
  SHOPIFY_APP_URL?: string;
  APP_URL?: string;
  HOST?: string;
}

/**
 * Returns [] — React Router's default, i.e. no cross-origin action submissions
 * — for anything that is not a development session with a known tunnel.
 *
 * Deliberately fails CLOSED. An unparseable or missing URL yields an empty
 * allowlist rather than a permissive one: a broken tunnel should make form
 * posts fail loudly in development, not quietly widen what production trusts.
 */
export function resolveAllowedActionOrigins(env: OriginEnv): string[] {
  const isProduction = env.NODE_ENV === "production" || env.APP_ENV === "production";
  if (isProduction) return [];

  // SHOPIFY_APP_URL first because it is ours and explicit; APP_URL and HOST are
  // what the Shopify CLI actually sets, checked in that order.
  const candidate = env.SHOPIFY_APP_URL ?? env.APP_URL ?? env.HOST;
  if (!candidate) return [];

  let host: string;
  try {
    host = new URL(candidate).host;
  } catch {
    // A bare host with no scheme is still usable; anything else is not.
    host = /^[a-z0-9.-]+(:\d+)?$/i.test(candidate) ? candidate : "";
  }
  if (!host) return [];

  // Never allow a placeholder to become a trusted origin. `example.com` is the
  // unresolved value in the app .toml, and trusting it would mean shipping a
  // config that allows a domain we do not control.
  if (host === "example.com" || host.endsWith(".example.com")) return [];

  return [host];
}
