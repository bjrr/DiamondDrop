/**
 * App Proxy calls must be ORIGIN-RELATIVE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FENCE EXISTS
 * ---------------------------------------------------------------------------
 * This store answers on more than one valid hostname. `myshopifyDomain` is
 * `nnb1th-cm.myshopify.com`, `primaryDomain` is `caratforus.myshopify.com`,
 * and a custom domain is planned. Shopify redirects to the primary domain, so
 * a visitor who entered through one hostname is browsing another by the time
 * any JavaScript runs.
 *
 * A hard-coded host breaks in two ways, and the second is the dangerous one:
 *
 *   1. The request goes somewhere the visitor is not, so the session cookie
 *      and the App Proxy signature are for the wrong origin.
 *   2. It works in testing and fails for real visitors, because whichever
 *      host was hard-coded is the one the developer happened to use.
 *
 * A relative path has neither problem: the browser resolves it against
 * wherever the customer actually is, and Shopify signs the proxied request
 * for that origin.
 *
 * During this feature's verification a request did appear to go to
 * `caratforus.myshopify.com` from a page opened on `nnb1th-cm`. That turned
 * out to be the primary-domain redirect rather than a hard-coded host — the
 * code was already correct. This fence is here so it stays that way, since
 * "just put the full URL in" is a natural-looking fix for the next person who
 * sees that and reads it as a bug.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");

/** Everything this feature ships that talks to our own endpoints. */
const FILES = [
  "theme/assets/set-your-own-stone.js",
  "theme/assets/custom-jewelry-intake-form.js",
  "theme/sections/set-your-own-stone.liquid",
  "theme/sections/custom-jewelry-intake-form.liquid",
];

/** Every spelling of "this store" that must not be written down. */
const HARD_CODED_HOSTS = [
  /nnb1th-cm\.myshopify\.com/i,
  /caratforus\.myshopify\.com/i,
  /\bcaratforus\.com\b/i,
  /https?:\/\/[^\s"')]*myshopify\.com/i,
  // Liquid objects that resolve to a fixed host at render time. These bake the
  // hostname into the page, which is the same bug with extra steps.
  /shop\.permanent_domain/,
  /shop\.domain\b/,
  /request\.host\b/,
];

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Comments are prose, including the prose explaining this very rule. */
function stripComments(source: string): string {
  return source
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("App Proxy calls are origin-relative, on every valid hostname", () => {
  it("names no storefront host anywhere in the shipped code", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const text = stripComments(read(file));
      for (const pattern of HARD_CODED_HOSTS) {
        if (pattern.test(text)) violations.push(`${file} matches ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("calls every proxy endpoint through a root-relative path", () => {
    for (const file of ["theme/assets/set-your-own-stone.js", "theme/assets/custom-jewelry-intake-form.js"]) {
      const text = stripComments(read(file));
      const endpoints = [...text.matchAll(/['"]([^'"]*\/apps\/carat\/[^'"]*)['"]/g)].map((m) => m[1]);

      // There must BE some, or this test passes by finding nothing — the
      // failure mode that makes a fence worse than no fence.
      expect(endpoints.length, `${file} declares no /apps/carat endpoint`).toBeGreaterThan(0);

      for (const endpoint of endpoints) {
        expect(endpoint, `${file}: ${endpoint}`).toMatch(/^\/apps\/carat\//);
      }
    }
  });

  it("would catch a hard-coded host if one were introduced", () => {
    // Proves the patterns work rather than trusting that zero hits means zero
    // risk — the same guard the guaranteed-fit fence carries.
    const wouldViolate = [
      'fetch("https://caratforus.myshopify.com/apps/carat/stone-session")',
      "fetch('https://nnb1th-cm.myshopify.com/apps/carat/stone-session')",
      "var base = '{{ shop.permanent_domain }}';",
      'fetch("https://caratforus.com/apps/carat/stone-session")',
    ];
    for (const sample of wouldViolate) {
      expect(
        HARD_CODED_HOSTS.some((p) => p.test(sample)),
        `not caught: ${sample}`
      ).toBe(true);
    }
  });

  it("does not flag a legitimate relative call", () => {
    const fine = "fetch('/apps/carat/stone-session', { method: 'POST' })";
    expect(HARD_CODED_HOSTS.some((p) => p.test(fine))).toBe(false);
  });
});
