import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FINDING F-23 REGRESSION FENCE (docs/ARCHITECTURE-MVP1.md §2.1 "R-1").
 *
 * React Router 7's `throwIfPotentialCSRFAttack` rejects a mutation-method
 * request to any route WITH A DEFAULT EXPORT unless its Origin is
 * allowlisted — and `allowedActionOrigins` resolves to an unconditionally
 * empty array in every production build (see ../../react-router.config.ts:
 * `react-router build` forces Vite's default NODE_ENV to "production"
 * regardless of APP_ENV or any tunnel env var present at build time, verified
 * 2026-09-19 against the installed @react-router/dev@7.18.3 CLI source).
 *
 * That means the ONLY thing protecting a production App Proxy, webhook or
 * internal/cron POST endpoint from a silent 400 is that its route module has
 * NO DEFAULT EXPORT (a "resource route"), which exempts it from the guard
 * entirely. Every route module that exists today follows that correctly, but
 * nothing before this fence enforced it — it was a convention, not a check.
 *
 * THE FAILURE THIS PREVENTS. Someone adds `export default function
 * Confirmation() {...}` to a webhooks.*, apps.carat.* or internal.* route to
 * render a receipt page. Every POST to that route now 400s in production for
 * any caller whose Origin differs from the app's own host — which is EVERY
 * legitimate caller of an App Proxy or webhook endpoint — before validation
 * runs, before an evidence row is written, and before any `logger` call of
 * ours executes. Nothing in the diff that added the default export mentions
 * CSRF. A customer's Group Buy join, warranty claim or RMA request fails with
 * nothing in our logs to explain it. See docs/ARCHITECTURE-MVP1.md §2.1 "R-1".
 *
 * WALKS THE SOURCE rather than hand-maintaining a list of route names — same
 * approach as criterion 29 in app/domain/pricing/layering.test.ts, for the
 * same reason: a hardcoded list stops protecting the boundary the moment
 * someone adds a file and forgets to update the list.
 */

const ROUTES_DIR = join(process.cwd(), "app", "routes");

/**
 * Cross-origin-reachable-by-URL route families, identified by the flat-routes
 * filename convention already in use throughout app/routes/ (dots are path
 * separators, per app/routes.ts's `flatRoutes`):
 *
 *   apps.carat.*  -> /apps/carat/*  (Shopify App Proxy — storefront forms)
 *   webhooks.*    -> /webhooks/*    (Shopify webhook delivery)
 *   internal.*    -> /internal/*    (platform scheduler / staff trigger)
 *
 * Every caller of a route in one of these families arrives from an origin
 * other than this app's own host (the storefront domain via App Proxy,
 * Shopify's webhook infrastructure, or the platform scheduler), which is
 * exactly the situation `allowedActionOrigins: []` cannot rescue.
 */
const CROSS_ORIGIN_PREFIXES = ["apps.carat.", "webhooks.", "internal."] as const;

/**
 * Routes with BOTH a default export and an action that are legitimately
 * exempt from the invariant below, and WHY — named explicitly so a new UI
 * route with an action cannot pass this fence by silent accident of matching
 * none of CROSS_ORIGIN_PREFIXES. Add to this only with a reasoned entry; the
 * "every route ... is either fenced or explicitly exempt" test below fails
 * loudly on anything unlisted.
 */
const EXEMPT_UI_ACTION_ROUTES: Readonly<Record<string, string>> = {
  "_index.tsx":
    "the embedded admin UI route. Not cross-origin-reachable in production: " +
    "Shopify Admin opens it inside an iframe pointed at this app's own host, " +
    "so a form submitted from within it carries this app's own Origin. Its " +
    "action is also gated by isDevProbeEnabled() and returns 403 outside " +
    "development regardless of Origin — there is no production mutation on " +
    "this route today. If that ever changes, this exemption must be re-argued.",
  "app.bank-payments.$id.tsx":
    "the manual Bank Payment verification admin surface (Slice 2C phase 2C-c). " +
    "NOT the same argument as _index.tsx, which rests on two legs — same-origin " +
    "AND no production mutation (its action 403s outside development). This " +
    "route IS a real production mutation: it records a payment and completes a " +
    "Shopify order. It stands on the first leg alone, and that leg is the " +
    "load-bearing one: throwIfPotentialCSRFAttack rejects a mutation whose " +
    "Origin DIFFERS FROM THE APP'S OWN HOST, and allowedActionOrigins only " +
    "widens that set. Shopify Admin iframes this route at the app's own URL, so " +
    "a form inside it posts with the app's own Origin and is same-origin by " +
    "construction — unlike an App Proxy, webhook or cron caller, every one of " +
    "which arrives from somewhere else. " +
    "If this route ever accepts a POST from anywhere but its own rendered form, " +
    "this exemption stops being true and must be re-argued.",
};

function routeFiles(): string[] {
  // Mirrors app/routes.ts's own `ignoredRouteFiles: ["**/*.test.*"]" — this
  // file itself must not check itself.
  return readdirSync(ROUTES_DIR).filter(
    (name) => (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.")
  );
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function hasDefaultExport(source: string): boolean {
  return /(^|\n)\s*export\s+default\b/.test(stripComments(source));
}

function hasActionExport(source: string): boolean {
  const code = stripComments(source);
  return (
    /(^|\n)\s*export\s+(async\s+)?function\s+action\s*\(/.test(code) ||
    /(^|\n)\s*export\s+const\s+action\s*[:=]/.test(code)
  );
}

function isCrossOriginReachable(filename: string): boolean {
  return CROSS_ORIGIN_PREFIXES.some((prefix) => filename.startsWith(prefix));
}

describe("F-23 regression fence — cross-origin-reachable action routes stay resource routes", () => {
  it("finds route files to check, in every fenced category", () => {
    // Guards the guard: if any of these ever drops to zero, the it.each below
    // silently checks nothing for that family and the fence stops meaning
    // anything, while still reporting green.
    const files = routeFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const prefix of CROSS_ORIGIN_PREFIXES) {
      expect(
        files.some((f) => f.startsWith(prefix)),
        `expected at least one route file starting with "${prefix}" — the fence ` +
          "has nothing to check for that family. Either the naming convention " +
          "changed (update CROSS_ORIGIN_PREFIXES) or a route got renamed/removed " +
          "without anyone re-reading this fence."
      ).toBe(true);
    }
  });

  it("app/routes/ is flat — no folder-style routes hiding from this walk", () => {
    // readdirSync above is NOT recursive, and flatRoutes ALSO supports the
    // folder form (webhooks.orders.paid/route.tsx), where the DIRECTORY name
    // carries the prefix. Such a route would be a real, reachable endpoint
    // that this fence never looks at — and the "finds route files to check"
    // test above would still pass, because the existing flat files satisfy
    // every prefix. That is silent coverage loss: the precise failure this
    // whole file exists to prevent, reintroduced one level up.
    //
    // Pinning the convention is the cheap fix. If a future slice genuinely
    // wants folder-style routes, this test fails first and forces the walk to
    // be made recursive and directory-aware BEFORE the uncovered route ships.
    const subdirectories = readdirSync(ROUTES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(
      subdirectories,
      "app/routes/ contains subdirectories, which means folder-style routes may " +
        "exist that this fence's non-recursive walk cannot see. Make routeFiles() " +
        "recursive and classify by the directory name before adding one, or this " +
        "fence will report green while covering nothing for that route."
    ).toEqual([]);
  });

  it.each(routeFiles().filter(isCrossOriginReachable))(
    "%s has no default export if it defines an action",
    (name) => {
      const source = readFileSync(join(ROUTES_DIR, name), "utf8");
      if (!hasActionExport(source)) return; // a loader-only resource route has nothing to guard

      expect(
        hasDefaultExport(source),
        `${name} defines both an action and a default export. React Router 7's ` +
          "CSRF origin guard (throwIfPotentialCSRFAttack) rejects any cross-origin " +
          "mutation-method request to a route with a default export, and " +
          "allowedActionOrigins is unconditionally [] in every production build " +
          "(react-router.config.ts). Every legitimate caller of this endpoint — " +
          "Shopify's App Proxy, webhook delivery, or the platform scheduler — will " +
          "get a silent 400 before validation, before an evidence row, before any " +
          'log line. Remove the default export, or move the rendering concern to a ' +
          'separate UI route. See docs/ARCHITECTURE-MVP1.md §2.1 "R-1".'
      ).toBe(false);
    }
  );

  describe("routes with an action and a default export are fenced above or explicitly exempt", () => {
    it("no unexplained route combines an action with a default export", () => {
      const unexplained: string[] = [];
      for (const name of routeFiles()) {
        if (isCrossOriginReachable(name)) continue; // covered by the it.each above instead

        const source = readFileSync(join(ROUTES_DIR, name), "utf8");
        if (hasActionExport(source) && hasDefaultExport(source) && !(name in EXEMPT_UI_ACTION_ROUTES)) {
          unexplained.push(name);
        }
      }

      expect(
        unexplained,
        `these route(s) combine an action with a default export, do not match ` +
          `${CROSS_ORIGIN_PREFIXES.join(", ")}, and have no entry in ` +
          "EXEMPT_UI_ACTION_ROUTES above. Decide deliberately: either add a " +
          "reasoned entry there, or confirm it is genuinely cross-origin reachable " +
          "and remove the default export instead."
      ).toEqual([]);
    });

    it("_index.tsx is the exemption this fence expects, not a stand-in for silence", () => {
      const source = readFileSync(join(ROUTES_DIR, "_index.tsx"), "utf8");
      // If either of these ever goes false, the route no longer needs the
      // exemption above (or needs a different one) — update EXEMPT_UI_ACTION_ROUTES.
      expect(hasDefaultExport(source)).toBe(true);
      expect(hasActionExport(source)).toBe(true);
      expect(EXEMPT_UI_ACTION_ROUTES["_index.tsx"]).toMatch(/not cross-origin-reachable/i);
    });
  });
});

describe("guard the guard — the classifier actually detects the violation it exists to catch", () => {
  /**
   * Proves the fence would fail on a real violation rather than passing today
   * only because no existing file happens to trip it. Modelled directly on
   * the failure mode described above: a resource route that grows a default
   * export.
   */
  const VIOLATING_SOURCE = `
    import type { ActionFunctionArgs } from "react-router";

    export async function action({ request }: ActionFunctionArgs) {
      return new Response(null, { status: 200 });
    }

    export default function Confirmation() {
      return null;
    }
  `;

  it("flags a route that combines an action with a default export", () => {
    expect(hasActionExport(VIOLATING_SOURCE)).toBe(true);
    expect(hasDefaultExport(VIOLATING_SOURCE)).toBe(true);
  });

  it("does not flag a loader-only route (nothing to guard without an action)", () => {
    const LOADER_ONLY = `
      export async function loader() {
        return new Response(null, { status: 200 });
      }
    `;
    expect(hasActionExport(LOADER_ONLY)).toBe(false);
  });

  it("does not flag a genuine resource route (action, no default export)", () => {
    const RESOURCE_ROUTE = `
      export async function action() {
        return new Response(null, { status: 200 });
      }
    `;
    expect(hasActionExport(RESOURCE_ROUTE)).toBe(true);
    expect(hasDefaultExport(RESOURCE_ROUTE)).toBe(false);
  });

  it("is not fooled by a default export mentioned only in a comment", () => {
    const COMMENTED = `
      // export default something we are NOT actually exporting here
      export async function action() {
        return new Response(null, { status: 200 });
      }
    `;
    expect(hasDefaultExport(COMMENTED)).toBe(false);
  });

  it("recognises the const form of an action export, not just function form", () => {
    const CONST_ACTION = `
      export const action = async () => new Response(null, { status: 200 });
    `;
    expect(hasActionExport(CONST_ACTION)).toBe(true);
  });
});
