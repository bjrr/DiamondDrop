import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Fences on the First Access mobile-capture path, scanning the REAL source.
 *
 * Each one pins a decision that is invisible in behaviour until the day it
 * bites:
 *
 *   - SMS CONSENT. Storing a number is not permission to text it. A future
 *     edit that adds `smsMarketingConsent` "while we're in here" would
 *     subscribe people who were never asked — an opt-in nobody can later
 *     prove, and the exact thing consent evidence exists to prevent.
 *   - THE SCOPE BARGAIN. `write_customers` is granted ONLY because Shopify
 *     requires customer-write permission for a customer metafield. It is
 *     justified by the authorised code being one metafield write, so any
 *     second mutation — `customerUpdate`, `tagsAdd`, a create, a delete —
 *     silently widens a grant the owner deliberately kept narrow.
 *   - `Customer.phone`. Owner decision 2026-11-05: not written at this stage.
 *     A well-meaning "while we're here, populate the real field too" is the
 *     likely regression.
 *   - ERASURE. An omitted number must never clear a stored value.
 *   - PII IN LOGS. The log line must survive being read by anyone with log
 *     access.
 *
 * A unit test cannot catch any of these, because each is a change that still
 * passes every behavioural test in the suite.
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
 * consent and do not write `Customer.phone`, so a scan of the raw text would
 * flag the documentation of each rule as a violation of it.
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

describe("First Access mobile capture never touches SMS marketing consent", () => {
  for (const { label, path } of SERVER_FILES) {
    it(`${label} sets no SMS consent field`, () => {
      const source = code(path);
      expect(source).not.toMatch(/smsMarketingConsent/i);
      expect(source).not.toMatch(/accepts_sms|acceptsSms/i);
      expect(source).not.toMatch(/marketingOptInLevel|optInLevel/i);
      expect(source).not.toMatch(/SUBSCRIBED/);
    });
  }

  it("the theme makes no SMS promise on the signup path", () => {
    const source = code(THEME_JS);
    expect(source).not.toMatch(/smsMarketingConsent|accepts_sms|acceptsSms/i);
  });
});

describe("the write surface is one metafield, which is what the scope buys", () => {
  it("stores the number through metafieldsSet", () => {
    expect(code(ADAPTER)).toMatch(/metafieldsSet/);
  });

  it("uses no other customer mutation", () => {
    const source = code(ADAPTER);
    for (const forbidden of [
      "customerCreate",
      "customerUpdate",
      "customerDelete",
      "customerEmailMarketingConsentUpdate",
      "customerSmsMarketingConsentUpdate",
      "tagsAdd",
      "tagsRemove",
      "metafieldsDelete",
      "metafieldDelete",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("declares exactly one mutation document", () => {
    const source = code(ADAPTER);
    expect(source.match(/mutation \w+\(/g) ?? []).toHaveLength(1);
  });

  it("does not write or even read Customer.phone", () => {
    const source = code(ADAPTER);
    expect(source).not.toMatch(/defaultPhoneNumber/);
    // No `phone:` field in any mutation input or query selection here. The
    // number travels as `mobileE164` and lands in a metafield value.
    expect(source).not.toMatch(/\bphone\b\s*:/);
  });

  it("writes to the metafield the admin definition was created at", () => {
    const source = code(DOMAIN);
    expect(source).toMatch(/namespace: "custom"/);
    expect(source).toMatch(/key: "first_access_mobile"/);
    expect(source).toMatch(/type: "single_line_text_field"/);
  });
});

describe("an omitted number can never erase a stored one", () => {
  it("the route returns before the write when the number is unusable", () => {
    const source = code(ROUTE);
    // The early return has to sit BEFORE the adapter call, or a blank field
    // would reach a write.
    const guard = source.indexOf("if (!phoneResult.ok)");
    const write = source.indexOf("storeFirstAccessMobile(admin");
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });

  it("the adapter takes a plain string, so there is no absent-value path", () => {
    const source = code(ADAPTER);
    expect(source).toMatch(/mobileE164: string/);
    // Not `string | null`, not optional — erasure is unrepresentable.
    expect(source).not.toMatch(/mobileE164\?*:\s*string\s*\|\s*null/);
    expect(source).not.toMatch(/mobileE164\?:/);
  });

  it("the theme sends nothing at all when the field is blank", () => {
    const source = code(THEME_JS);
    expect(source).toMatch(/if \(phone === ''\) return null;/);
    expect(source).toMatch(/if \(!submission/);
  });
});

describe("the theme sends only what the endpoint needs", () => {
  it("posts the address and the number, and no name or interests", () => {
    const source = code(THEME_JS);
    expect(source).toMatch(/return \{ email: value\('contact\[email\]'\), phone: phone \};/);
    // Names and interests persist natively; sending them would let a public
    // endpoint change them.
    expect(source).not.toMatch(/firstName:/);
    expect(source).not.toMatch(/lastName:/);
    expect(source).not.toMatch(/interests:/);
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
    expect(source).toMatch(/perEmail\.hit\(/);
    expect(source).toMatch(/overall\.hit\(/);
    expect(source).toMatch(/429/);
  });

  it("refuses anything other than POST", () => {
    expect(code(ROUTE)).toMatch(/method_not_allowed/);
  });

  it("exposes no read path", () => {
    const source = code(ROUTE);
    // A loader exists ONLY to refuse. If it ever returns data, this fails.
    expect(source).toMatch(
      /export async function loader\(\) \{\s*return Response\.json\(\s*\{ error: "method_not_allowed" \},\s*\{ status: 405 \}\s*\);\s*\}/
    );
  });

  it("gates the write on the first-access tag and returns before writing", () => {
    const source = code(ADAPTER);
    expect(source).toMatch(/if \(!mayWriteToCustomer\(/);
    expect(source).toMatch(/return "not_first_access"/);
    // Anchored on the query CONSTANT rather than the whole call expression,
    // which drifts whenever an argument is added.
    const gate = source.indexOf("mayWriteToCustomer(");
    const write = source.indexOf("SET_MOBILE, {");
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(write);
  });
});

describe("no PII reaches the logs", () => {
  it("logs no email or phone value", () => {
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
        expect(identifiers, `${label}: ${call}`).not.toMatch(/mobileE164|e164|\bphone\b/);
      }
    }
  });

  it("the fence would actually catch a logged address", () => {
    // Mutation check. An absence assertion that cannot fail is decoration.
    const planted = 'logger.info("firstaccess.mobile_stored", { outcome, email });';
    expect(planted.replace(/"[^"]*"/g, '""')).toMatch(/\bemail\b/);
  });
});

describe("the response reveals nothing about who is on file", () => {
  it("returns one body for every authenticated outcome", () => {
    const source = code(ROUTE);
    expect(source).toMatch(/const ACCEPTED = \{ ok: true \} as const;/);
    const successReturns =
      source.match(/return Response\.json\(([^,]+), \{ status: 200 \}\)/g) ?? [];
    expect(successReturns.length).toBeGreaterThan(0);
    for (const line of successReturns) {
      expect(line).toContain("ACCEPTED");
    }
  });
});
