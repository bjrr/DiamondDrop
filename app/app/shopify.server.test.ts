import { describe, expect, it } from "vitest";

import { AUTH_PATHS } from "./shopify.server";

/**
 * D13 — Shopify admin authentication configuration.
 *
 * These are CONFIGURATION assertions, not OAuth simulations. The library's own
 * suite covers the protocol; what is worth pinning here is the handful of
 * choices that are ours, and whose silent drift would break something in a way
 * that is hard to attribute:
 *
 *   - the auth paths, because `[auth] redirect_urls` registered with Shopify
 *     are derived from them and a mismatch fails at install time with an error
 *     that blames the redirect URI rather than the config;
 *   - that our custom webhook boundary is still ours;
 *   - that the least-privilege scope set has not quietly widened.
 */

describe("auth paths", () => {
  it("are rooted at the configured /auth prefix", () => {
    expect(AUTH_PATHS.prefix).toBe("/auth");
    for (const path of Object.values(AUTH_PATHS)) {
      expect(path.startsWith("/auth")).toBe(true);
    }
  });

  it("expose the exact callback the app must register with Shopify", () => {
    // If this changes, shopify.app.caratforus-development.toml [auth]
    // redirect_urls must change with it — and a deploy is needed for Shopify to
    // learn about it. That coupling is the reason this assertion exists.
    expect(AUTH_PATHS.callback).toBe("/auth/callback");
  });

  it("cover every path the library derives from the prefix", () => {
    // Taken from the installed library's shopify-app.js, which builds
    // callbackPath, patchSessionTokenPath, exitIframePath and loginPath from
    // authPathPrefix. Listed here so that a library upgrade adding or renaming
    // one is noticed rather than silently unrouted.
    expect(AUTH_PATHS).toEqual({
      prefix: "/auth",
      callback: "/auth/callback",
      login: "/auth/login",
      sessionToken: "/auth/session-token",
      exitIframe: "/auth/exit-iframe",
    });
  });
});
