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
 * Behind the Shopify CLI tunnel those never agree. The browser sends
 * `Origin: https://<random>.trycloudflare.com` — the origin the document was
 * served from — while the dev server builds `request.url` from the local
 * listener, `http://localhost:<port>/…`. Different scheme, different host, so
 * every POST is rejected before the action runs. GET is not guarded, which is
 * why loaders and the Admin API read worked while form submission did not.
 *
 * WHY NOT JUST UPGRADE. Not a framework bug: react-router 7.18.4 ships a
 * byte-identical implementation. `allowedActionOrigins` is the documented
 * mechanism, and its own error text calls the request "a forwarded action
 * request".
 *
 * WHY NOT A WILDCARD. `**.trycloudflare.com` would work and would also trust
 * every Cloudflare quick tunnel on the internet. Unnecessary: the Shopify CLI
 * exports the tunnel origin to the process it launches, so exactly one host
 * can be allowed — the one currently serving the app.
 *
 * WHY THIS TRIES SEVERAL SOURCES INSTEAD OF ONE. The first version took
 * `SHOPIFY_APP_URL ?? APP_URL ?? HOST` and stopped at the first value present.
 * `.env` sets SHOPIFY_APP_URL to a placeholder and `vite.config.ts` loads
 * `.env` into `process.env`, so the placeholder always won and the CLI's real
 * tunnel was never consulted. Worse than returning nothing: it returned
 * ["example.ngrok-free.app"], so the allowlist looked configured while
 * trusting a host that serves nothing. Each source is now evaluated on its
 * own merits and unusable ones are SKIPPED rather than ending the search.
 */

/**
 * Environment the CLI provides to the process it launches. Inspecting the
 * CLI's compiled source shows it sets BOTH `HOST` and `APP_URL` to the tunnel
 * origin, alongside `APP_ENV=development` and `NODE_ENV=development`.
 */
export interface OriginEnv {
  NODE_ENV?: string;
  APP_ENV?: string;
  SHOPIFY_APP_URL?: string;
  APP_URL?: string;
  HOST?: string;
}

/**
 * Checked in this order, and the order is the fix.
 *
 * APP_URL and HOST come from the Shopify CLI at RUNTIME and are the live
 * tunnel. SHOPIFY_APP_URL comes from `.env`, is edited by hand, and in
 * development is usually stale — so it is consulted last, as a fallback for
 * running outside the CLI rather than as the preferred answer.
 */
const CANDIDATE_SOURCES = ["APP_URL", "HOST", "SHOPIFY_APP_URL"] as const;

export type OriginSource = (typeof CANDIDATE_SOURCES)[number];

export interface OriginResolution {
  /** The single allowed host, or null when nothing usable was found. */
  host: string | null;
  /** Which variable supplied it — the answer to "what is the CLI setting?". */
  source: OriginSource | null;
  /** Every candidate and why it was accepted or skipped. Diagnostics only. */
  considered: { source: OriginSource; value: string | null; outcome: string }[];
}

/**
 * Documentation domains reserved by RFC 2606, plus any host whose first label
 * is literally "example".
 *
 * That last rule is what the earlier version lacked. It only compared against
 * "example.com", so the placeholder actually sitting in `.env` —
 * `example.ngrok-free.app` — sailed through and became the allowlist.
 */
function isPlaceholderHost(host: string): boolean {
  const bare = host.split(":")[0]?.toLowerCase() ?? "";
  if (bare.split(".")[0] === "example") return true;
  for (const reserved of ["example.com", "example.net", "example.org"]) {
    if (bare === reserved || bare.endsWith(`.${reserved}`)) return true;
  }
  // Values left unreplaced in a template are never a real origin.
  return /replace_with|your-app|localhost\.example/i.test(bare);
}

/** Returns the host (with port, without scheme), or null if unusable. */
function toHost(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // Refuse anything containing a glob BEFORE parsing. React Router's
  // allowlist supports micromatch patterns, and "https://*.trycloudflare.com"
  // parses cleanly into the host "*.trycloudflare.com" — so without this, an
  // environment value could silently widen the allowlist into the wildcard
  // this whole approach exists to avoid. Found by the test asserting no
  // wildcard is ever returned.
  if (trimmed.includes("*")) return null;

  try {
    const url = new URL(trimmed);
    // Reject a URL with no host, e.g. "file:///x" or "mailto:a@b".
    return url.host || null;
  } catch {
    // A bare host without a scheme is still usable; anything else is not.
    return /^[a-z0-9.-]+(:\d+)?$/i.test(trimmed) ? trimmed : null;
  }
}

/**
 * Full resolution with the reasoning attached, for the startup diagnostic.
 *
 * Fails CLOSED at every step. A missing, malformed or placeholder value yields
 * no allowlist rather than a permissive one: a broken tunnel should make form
 * posts fail loudly in development, not quietly widen what is trusted.
 */
export function describeAllowedActionOrigins(env: OriginEnv): OriginResolution {
  const considered: OriginResolution["considered"] = [];

  const isProduction = env.NODE_ENV === "production" || env.APP_ENV === "production";
  if (isProduction) {
    return { host: null, source: null, considered: [] };
  }

  for (const source of CANDIDATE_SOURCES) {
    const value = env[source] ?? null;

    if (!value) {
      considered.push({ source, value: null, outcome: "unset" });
      continue;
    }

    const host = toHost(value);
    if (!host) {
      // SKIPPED, not fatal. The whole point of the rewrite: an unusable
      // candidate must not end the search.
      considered.push({ source, value, outcome: "skipped — not a usable host" });
      continue;
    }
    if (isPlaceholderHost(host)) {
      considered.push({ source, value, outcome: `skipped — placeholder (${host})` });
      continue;
    }

    considered.push({ source, value, outcome: `USED (${host})` });
    return { host, source, considered };
  }

  return { host: null, source: null, considered };
}

/** The value React Router consumes. Exactly one host, or none. Never a pattern. */
export function resolveAllowedActionOrigins(env: OriginEnv): string[] {
  const { host } = describeAllowedActionOrigins(env);
  return host ? [host] : [];
}

/**
 * One-line startup diagnostic. Prints HOSTS ONLY — never a token, never a
 * secret, and never the full environment.
 *
 * Exists because the failure it reports is otherwise invisible: an allowlist
 * containing the wrong host behaves exactly like a correct one right up to the
 * moment a form is submitted, and then produces a framework error that names
 * neither the allowlist nor the host.
 */
export function formatOriginDiagnostic(env: OriginEnv): string {
  const { host, source, considered } = describeAllowedActionOrigins(env);

  if (considered.length === 0) {
    return "[action-origins] production build — allowedActionOrigins: [] (no cross-origin actions)";
  }

  const trail = considered.map((c) => `${c.source}: ${c.outcome}`).join(" | ");
  return host
    ? `[action-origins] allowing ${host} (from ${source}) — ${trail}`
    : `[action-origins] NO usable origin found; form POSTs from a tunnel will be rejected — ${trail}`;
}
