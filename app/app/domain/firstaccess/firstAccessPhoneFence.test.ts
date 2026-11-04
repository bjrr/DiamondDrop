import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Fences on the First Access phone-capture path, scanning the REAL source.
 *
 * Each one of these pins a decision that is invisible in behaviour until the
 * day it bites:
 *
 *   - SMS CONSENT. Storing a number is not permission to text it. A future
 *     edit that adds `smsMarketingConsent` "while we're in here" would
 *     subscribe people who were never asked — an opt-in nobody can later
 *     prove, and the exact thing consent evidence exists to prevent.
 *   - TAG REPLACEMENT. `CustomerInput.tags` replaces the whole set. Reaching
 *     for it instead of `tagsAdd` would let a public endpoint strip `vip` or
 *     `wholesale` off a customer.
 *   - CUSTOMER CREATION. The native form is captcha-protected; this route is
 *     not. A create mutation here would be an open customer factory.
 *   - PII IN LOGS. The log line must survive being read by anyone with log
 *     access.
 *
 * A unit test cannot catch any of these, because each of them is a change
 * that still passes every behavioural test in the suite.
 */

const APP = join(process.cwd(), "app");

const ROUTE = join(APP, "routes", "apps.carat.first-access-phone.tsx");
const ADAPTER = join(APP, "shopify", "admin", "firstAccessCustomer.server.ts");
const DOMAIN = join(APP, "domain", "firstaccess", "phoneCapture.ts");
const THEME_JS = join(process.cwd(), "..", "theme", "assets", "first-access.js");

/**
 * Comments are removed before every absence check.
 *
 * Not a nicety: the files below EXPLAIN at length why they do not set SMS
 * consent, so a scan of the raw text would flag the documentation of the rule
 * as a violation of it.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*\*.*$/gm, " ");
}

const SERVER_FILES = [
  { label: "route", path: ROUTE },
  { label: "adapter", path: ADAPTER },
  { label: "domain", path: DOMAIN },
];

describe("First Access phone capture never touches SMS marketing consent", () => {
  for (const { label, path } of SERVER_FILES) {
    it(`${label} sets no SMS consent field`, () => {
      const source = code(path);
      expect(source).not.toMatch(/smsMarketingConsent/i);
      expect(source).not.toMatch(/accepts_sms|acceptsSms/i);
      expect(source).not.toMatch(/marketingOptInLevel/i);
      expect(source).not.toMatch(/SUBSCRIBED/);
    });
  }

  it("the theme makes no SMS promise on the signup path", () => {
    const source = code(THEME_JS);
    expect(source).not.toMatch(/smsMarketingConsent|accepts_sms|acceptsSms/i);
  });
});

describe("the public endpoint cannot destroy customer data", () => {
  it("adds tags through tagsAdd and never through the replacing input field", () => {
    const source = code(ADAPTER);
    expect(source).toMatch(/tagsAdd/);
    // `CustomerInput.tags` REPLACES. Its absence here is the whole guarantee.
    expect(source).not.toMatch(/tags:\s*\[?\s*\.\.\./);
    expect(source).not.toMatch(/input:\s*\{[^}]*\btags\b/s);
  });

  it("uses no mutation that can create or delete a customer", () => {
    const source = code(ADAPTER);
    for (const forbidden of [
      "customerCreate",
      "customerDelete",
      "customerEmailMarketingConsentUpdate",
      "customerSmsMarketingConsentUpdate",
      "tagsRemove",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("reads the customer directly rather than through the lagging search index", () => {
    const source = code(ADAPTER);
    expect(source).toMatch(/customerByIdentifier/);
    expect(source).not.toMatch(/customers\s*\(\s*first:/);
  });
});

describe("the route is guarded before it does anything", () => {
  it("verifies the app-proxy signature and refuses when it fails", () => {
    const source = code(ROUTE);
    // The TRAILING PAREN matters. Without it this matched the import
    // statement, so renaming the call site passed the fence — caught by
    // mutation-testing, not by reading it.
    expect(source).toMatch(/verifyAppProxySignature\(/);
    expect(source).toMatch(/if \(!verified\)/);
    expect(source).toMatch(/status: 401/);
  });

  it("rate-limits by email and overall", () => {
    const source = code(ROUTE);
    expect(source).toMatch(/createRateLimiter/);
    expect(source).toMatch(/429/);
  });

  it("refuses anything other than POST", () => {
    expect(code(ROUTE)).toMatch(/method_not_allowed/);
  });

  it("exposes no read path", () => {
    const source = code(ROUTE);
    // A loader exists ONLY to refuse. If it ever returns data, this fails.
    expect(source).toMatch(/export async function loader\(\) \{\s*return Response\.json\(\s*\{ error: "method_not_allowed" \},\s*\{ status: 405 \}\s*\);\s*\}/);
  });

  it("gates the write on the first-access tag and returns before writing", () => {
    const source = code(ADAPTER);
    expect(source).toMatch(/if \(!mayWriteToCustomer\(/);
    expect(source).toMatch(/return "not_first_access"/);
    // The gate must sit ahead of both mutations, or it gates nothing.
    // Anchored on the query CONSTANTS rather than the whole call expression,
    // which drifts whenever an argument is added — as it just did.
    const gate = source.indexOf("mayWriteToCustomer(");
    const update = source.indexOf("UPDATE, {");
    const addTags = source.indexOf("ADD_TAGS, {");
    expect(gate).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(-1);
    expect(addTags).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(update);
    expect(gate).toBeLessThan(addTags);
  });
});

describe("no PII reaches the logs", () => {
  it("logs no email, name or phone value", () => {
    for (const { label, path } of SERVER_FILES) {
      const source = code(path);
      const logCalls = source.match(/logger\.\w+\([\s\S]*?\);/g) ?? [];
      for (const call of logCalls) {
        /**
         * Quoted strings are removed first, so a static LABEL such as
         * `{ scope: "email" }` does not read as a logged address. Template
         * literals are deliberately left intact — `${email}` is precisely
         * the mistake this is looking for.
         */
        const identifiers = call.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
        expect(identifiers, `${label}: ${call}`).not.toMatch(/\bemail\b/);
        expect(identifiers, `${label}: ${call}`).not.toMatch(/phoneE164|rawPhone|\bphone\b/);
        expect(identifiers, `${label}: ${call}`).not.toMatch(/firstName|lastName/);
      }
    }
  });

  it("the fence would actually catch a logged address", () => {
    // Mutation check. An absence assertion that cannot fail is decoration.
    const planted = 'logger.info("firstaccess.signup_applied", { outcome, email });';
    const identifiers = planted.replace(/"[^"]*"/g, '""');
    expect(identifiers).toMatch(/\bemail\b/);
  });
});

describe("the response reveals nothing about who is on file", () => {
  it("returns one body for every authenticated outcome", () => {
    const source = code(ROUTE);
    // Exactly one success shape, referenced wherever a 200 is returned.
    expect(source).toMatch(/const ACCEPTED = \{ ok: true \} as const;/);
    const successReturns = source.match(/return Response\.json\(([^,]+), \{ status: 200 \}\)/g) ?? [];
    expect(successReturns.length).toBeGreaterThan(0);
    for (const line of successReturns) {
      expect(line).toContain("ACCEPTED");
    }
  });
});
