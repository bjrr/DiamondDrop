import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import shopify, { AUTH_PATHS } from "./shopify.server";

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

describe("distribution", () => {
  it("is configured for a single merchant, not the App Store", () => {
    // Owner decision: CaratForUs's own store only. Pinned because the value
    // must agree with the distribution set on the Shopify app record — if the
    // two disagree, the library models an install flow Shopify is not running,
    // and the symptom is a confusing failure during install rather than a
    // config error at startup.
    //
    // Asserted via the presence of `login`, which the library attaches for
    // AppStore and SingleMerchant but NOT for ShopifyAdmin. That is the only
    // externally observable difference, so it is what there is to assert.
    expect(typeof shopify.login).toBe("function");
  });

  it("exposes the admin authenticator and session storage", () => {
    expect(typeof shopify.authenticate.admin).toBe("function");
    expect(shopify.sessionStorage).toBeDefined();
  });

  it("exposes registerWebhooks but we never call it", () => {
    // Corrected from an earlier assumption that this would be undefined. The
    // library attaches registerWebhooks unconditionally — its presence means
    // the CAPABILITY exists, not that anything is registered. What actually
    // matters is that our code never calls it, which is a source-level fact and
    // is asserted in shopify/webhooks/boundaryPreserved.test.ts.
    expect(typeof shopify.registerWebhooks).toBe("function");
  });

  it("exposes the unauthenticated admin context the background half of the app depends on", () => {
    expect(typeof shopify.unauthenticated.admin).toBe("function");
  });
});

/**
 * D23 (docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §19.1, criterion 112).
 * `useOnlineTokens: true` is not observable on the returned `shopify` object
 * — `config` (where the library stores it) is never exposed to consumers —
 * so this is a SOURCE-INSPECTION test, the same technique
 * `boundaryPreserved.test.ts` uses for "never calls the library's webhook
 * authenticator": what matters is what the code IS, at a point no runtime
 * assertion can reach.
 *
 * The claim being pinned has two halves, both load-bearing:
 *   1. the flag is actually set (so verification can record an authenticated
 *      identity at all);
 *   2. NOTHING background-facing calls `authenticate.admin` — the guarantee
 *      sweep and the recalculation cron must keep resolving their admin
 *      client through `unauthenticated.admin(shop)`, which reads the OFFLINE
 *      session by shop and does not depend on `useOnlineTokens` at all. If
 *      that boundary ever moved, this flag's blast radius would include code
 *      that runs with no embedded session and no online token to have.
 *
 * The installed library source (`token-exchange.js`) was read directly before
 * this flag was set: the offline session is exchanged and stored FIRST,
 * unconditionally, and an online session is exchanged and stored ADDITIONALLY
 * only when `useOnlineTokens` is true — so half 2 is what actually keeps half
 * 1 safe to turn on, not a coincidence.
 */
describe("D23 — useOnlineTokens is additive, and nothing background-facing depends on it", () => {
  const APP_DIR = join(process.cwd(), "app");
  const configSource = readFileSync(join(APP_DIR, "shopify.server.ts"), "utf8");

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("sets useOnlineTokens: true on the shopifyApp() config", () => {
    expect(stripComments(configSource)).toMatch(/useOnlineTokens\s*:\s*true/);
  });

  /**
   * Every file in this app that resolves an Admin API client OUTSIDE an
   * embedded request — the guarantee sweep, the price-sync port, the
   * inventory webhook handler, and Bank Payment Checkout's own draft-order
   * creation (a storefront App Proxy call, not an embedded admin session).
   * Named explicitly, like `EXEMPT_UI_ACTION_ROUTES` in
   * csrfResourceRouteFence.test.ts, so a new background caller added later
   * must be added HERE too — the "no offender anywhere" assertion below is
   * only meaningful if this list stays complete.
   */
  const BACKGROUND_ADMIN_CALLERS = [
    join(APP_DIR, "jobs", "bankpayment", "guaranteeSweep.server.ts"),
    join(APP_DIR, "shopify", "admin", "productionPriceSyncPort.server.ts"),
    join(APP_DIR, "shopify", "webhooks", "inventoryPurchasabilityHandler.server.ts"),
    join(APP_DIR, "routes", "apps.carat.bank-checkout.tsx"),
  ];

  it("every named background caller still resolves its admin client via unauthenticated.admin", () => {
    for (const path of BACKGROUND_ADMIN_CALLERS) {
      const source = stripComments(readFileSync(path, "utf8"));
      expect(source, `${path} must call unauthenticated.admin`).toMatch(/unauthenticated\s*\.\s*admin\s*\(/);
    }
  });

  it("no named background caller uses authenticate.admin instead", () => {
    for (const path of BACKGROUND_ADMIN_CALLERS) {
      const source = stripComments(readFileSync(path, "utf8"));
      expect(source, `${path} must not call authenticate.admin`).not.toMatch(/authenticate\s*\.\s*admin\s*\(/);
    }
  });

  it("finds the internal cron routes and confirms they carry no admin auth of their own", () => {
    // The two cron/scheduler routes reach the Admin API only by calling into
    // the background callers above (the sweep, the price-sync port) — they
    // must not short-circuit through authenticate.admin OR unauthenticated.admin
    // directly, since a cron request has no shop session and no App Bridge frame.
    const routesDir = join(APP_DIR, "routes");
    const cronRoutes = readdirSync(routesDir).filter((f) => f.startsWith("internal.jobs."));
    expect(cronRoutes.length).toBeGreaterThanOrEqual(2);
    for (const file of cronRoutes) {
      const source = stripComments(readFileSync(join(routesDir, file), "utf8"));
      expect(source, `${file} must not call authenticate.admin or unauthenticated.admin directly`).not.toMatch(
        /(authenticate|unauthenticated)\s*\.\s*admin\s*\(/
      );
    }
  });

  it("would actually catch a violation", () => {
    // Proves the detectors work rather than trusting an empty result.
    const violating = `import { authenticate } from "~/shopify.server";\nconst { admin } = await authenticate.admin(request);`;
    expect(stripComments(violating)).toMatch(/authenticate\s*\.\s*admin\s*\(/);
    const compliant = `import { unauthenticated } from "~/shopify.server";\nconst { admin } = await unauthenticated.admin(shop);`;
    expect(stripComments(compliant)).not.toMatch(/authenticate\s*\.\s*admin\s*\(/);
    expect(stripComments(compliant)).toMatch(/unauthenticated\s*\.\s*admin\s*\(/);
  });
});
