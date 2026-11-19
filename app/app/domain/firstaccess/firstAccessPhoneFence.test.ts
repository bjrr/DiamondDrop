import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Fences on the First Access mobile-capture path, scanning the REAL source.
 *
 * Each one pins a decision that is invisible in behaviour until the day it
 * bites:
 *
 *   - SMS CONSENT IS WRITTEN ONLY FROM AN EXPLICIT OPT-IN. Owner decision
 *     2026-11-18 added real SMS consent, which means the old fence ("never
 *     mention `smsMarketingConsent`") no longer states the rule — the rule is
 *     now that the write is reachable ONLY behind `smsConsent === true`.
 *     Storing a number is still not permission to text it, and the regression
 *     to catch is subtler than before: a consent inferred from the presence of
 *     a phone, or from the email opt-in, or from a truthy-but-not-`true` flag.
 *   - THE SCOPE BARGAIN. `write_customers` is granted because Shopify requires
 *     customer-write permission for a customer metafield AND for SMS consent.
 *     It is justified by the authorised code being small, so the mutations are
 *     allow-listed BY NAME: anything beyond the three named below — a create,
 *     a delete, `tagsAdd`, an email-consent write — silently widens a grant
 *     the owner deliberately kept narrow.
 *   - `Customer.phone` IS WRITTEN, but only alongside an SMS consent, because
 *     Shopify refuses to hold SMS marketing consent for an account with no
 *     phone. The half of owner decision 2026-11-05 that survives is that a
 *     number given WITHOUT the opt-in still goes only to the metafield.
 *   - THE LIVE THEME FILE. This fence used to scan `first-access.js`, which is
 *     V1 and now renders only on the archived `/pages/first-access-v1`. The
 *     live signup runs `first-access-v2.js`, so the guard was watching a file
 *     no visitor loads. Both are scanned now, and V2 is the one that matters.
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
/**
 * V1, which renders only on the archived `/pages/first-access-v1`. Kept under
 * the fence because an archived page is still a page.
 */
const THEME_JS_V1 = join(process.cwd(), "..", "theme", "assets", "first-access.js");
/**
 * THE LIVE ONE. `/pages/first-access` carries the template suffix
 * `first-access-v2`, and the COMING SOON homepage renders the same section, so
 * this is the file every real visitor executes.
 */
const THEME_JS_V2 = join(process.cwd(), "..", "theme", "assets", "first-access-v2.js");

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

describe("SMS consent is reachable only from an explicit opt-in", () => {
  it("the route gates the SMS write on a STRICT boolean", () => {
    // `=== true`, so no truthy near-miss ("true", 1, "on") can become a
    // marketing permission. This is the single most important line in the
    // feature and it is one character away from being wrong.
    const source = code(ROUTE);
    expect(source).toMatch(/body\.smsConsent === true/);
    expect(source).not.toMatch(/Boolean\(body\.smsConsent\)/);
    expect(source).not.toMatch(/!!body\.smsConsent/);
  });

  it("the route never infers SMS consent from the phone or from the email opt-in", () => {
    const source = code(ROUTE);
    // The consent write must be guarded by smsConsent, never by the number.
    expect(source).toMatch(/if \(smsConsent && phoneResult\.ok\)/);
    // And the two consents are read from two different fields.
    expect(source).toMatch(/body\.emailConsent === true/);
    expect(source).not.toMatch(/smsConsent = .*emailConsent/);
    expect(source).not.toMatch(/emailConsent \|\| smsConsent/);
  });

  it("the adapter's SMS function cannot be called without a consent decision", () => {
    // It takes no boolean: the DECISION is the caller's and the function only
    // records. A function that could be called speculatively would be.
    const source = code(ADAPTER);
    expect(source).toMatch(/export async function recordFirstAccessSmsConsent/);
    expect(source).not.toMatch(/recordFirstAccessSmsConsent\([^)]*consent(ed)?:\s*boolean/);
  });

  it("subscribes at SINGLE_OPT_IN, never claiming a confirmation nobody sent", () => {
    const source = code(ADAPTER);
    expect(source).toMatch(/marketingState: "SUBSCRIBED"/);
    expect(source).toMatch(/marketingOptInLevel: "SINGLE_OPT_IN"/);
    expect(source).not.toMatch(/CONFIRMED_OPT_IN/);
  });

  it("writes no EMAIL consent — the native form owns that", () => {
    // Two writers for one fact is the defect; Shopify's own form field is the
    // authority, and duplicating it here could only disagree with it.
    expect(code(ADAPTER)).not.toMatch(/customerEmailMarketingConsentUpdate/);
  });
});

describe("the mobile number alone still grants nothing", () => {
  for (const { label, path } of SERVER_FILES) {
    it(`${label} sets no SMS consent field`, () => {
      const source = code(path);
      // `accepts_sms` was never a real Shopify field and must not be invented
      // as a shortcut around the proper consent record.
      expect(source).not.toMatch(/accepts_sms|acceptsSms/i);
    });
  }

  it("the ARCHIVED V1 theme still makes no SMS promise at all", () => {
    const source = code(THEME_JS_V1);
    expect(source).not.toMatch(/smsMarketingConsent|accepts_sms|acceptsSms/i);
  });
});

describe("the write surface is one metafield, which is what the scope buys", () => {
  it("stores the number through metafieldsSet", () => {
    expect(code(ADAPTER)).toMatch(/metafieldsSet/);
  });

  it("uses exactly the three allow-listed mutations, and no others", () => {
    // THE SCOPE BARGAIN, restated for what the code now legitimately needs.
    // `write_customers` buys three writes and no more:
    //
    //   metafieldsSet                      the number, for every signup
    //   customerUpdate                     the phone, only with SMS consent
    //   customerSmsMarketingConsentUpdate  the consent itself
    //
    // Anything else widens a grant the owner kept deliberately narrow.
    const source = code(ADAPTER);
    const allowed = ["metafieldsSet", "customerUpdate", "customerSmsMarketingConsentUpdate"];
    for (const name of allowed) {
      expect(source, `${name} is missing`).toContain(name);
    }

    const forbidden = [
      "customerCreate",
      "customerDelete",
      "customerEmailMarketingConsentUpdate",
      "tagsAdd",
      "tagsRemove",
      "customerAddTaxExemptions",
      "customerGenerateAccountActivationUrl",
      "customerSendAccountInviteEmail",
      "metafieldsDelete",
    ];
    for (const name of forbidden) {
      expect(source, `${name} must not appear`).not.toContain(name);
    }
  });

  it("declares exactly three mutation documents", () => {
    // One per allowed write. A fourth `mutation` keyword is a fourth write.
    const documents = code(ADAPTER).match(/\bmutation Carat\w+/g) ?? [];
    expect(documents).toHaveLength(3);
    expect(documents.sort()).toEqual([
      "mutation CaratSetFirstAccessMobile",
      "mutation CaratSetFirstAccessPhone",
      "mutation CaratSetFirstAccessSmsConsent",
    ]);
  });

  it("writes Customer.phone ONLY from the SMS consent function", () => {
    // Owner decision 2026-11-05 said never; 2026-11-18 carved out the one case
    // where Shopify leaves no alternative — it refuses SMS marketing consent
    // for an account with no phone. The carve-out is exactly that wide: the
    // phone write lives inside `recordFirstAccessSmsConsent` and nowhere else,
    // so the metafield path cannot reach it.
    const source = code(ADAPTER);
    const smsFn = source.slice(source.indexOf("export async function recordFirstAccessSmsConsent"));
    expect(smsFn).toContain("SET_PHONE");

    const mobileFn = source.slice(
      source.indexOf("export async function storeFirstAccessMobile"),
      source.indexOf("export async function recordFirstAccessSmsConsent")
    );
    expect(mobileFn, "the metafield path must not touch the phone field").not.toContain("SET_PHONE");
    expect(mobileFn).not.toContain("defaultPhoneNumber");
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

  it("the ARCHIVED V1 theme sends nothing at all when the field is blank", () => {
    const source = code(THEME_JS_V1);
    expect(source).toMatch(/if \(phone === ''\) return null;/);
    expect(source).toMatch(/if \(!submission/);
  });
});

describe("the theme sends only what the endpoint needs", () => {
  it("the ARCHIVED V1 theme posts the address and the number, and no name or interests", () => {
    const source = code(THEME_JS_V1);
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
    expect(source).toMatch(/return \{ kind: "not_first_access" \}/);
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

/**
 * ============================================================================
 * THE LIVE THEME FILE, WHICH THIS FENCE PREVIOUSLY DID NOT WATCH
 * ============================================================================
 * `/pages/first-access` carries the template suffix `first-access-v2` and the
 * COMING SOON homepage renders the same section, so `first-access-v2.js` is the
 * file every real visitor runs. Everything above about V1 remained true while
 * the live page was governed by nothing.
 */
describe("the LIVE theme sends the consents and nothing it should not", () => {
  it("reads both consent boxes and sends them as real booleans", () => {
    const source = code(THEME_JS_V2);
    expect(source).toMatch(/data-fa2-email-consent/);
    expect(source).toMatch(/data-fa2-sms-consent/);
    expect(source).toMatch(/emailConsent: checked\(/);
    expect(source).toMatch(/smsConsent: checked\(/);
    // `!!box.checked`, so what crosses the wire is `true`/`false` and never
    // the string "true" or the checkbox's value attribute — the route reads
    // them with `=== true`.
    expect(source).toMatch(/return !!\(box && box\.checked\);/);
  });

  it("still sends no name and no interests", () => {
    // The original author's rule, unchanged by adding consents: anything a
    // public endpoint accepts is something a public endpoint could change.
    const source = code(THEME_JS_V2);
    expect(source).not.toMatch(/firstName:/);
    expect(source).not.toMatch(/lastName:/);
    expect(source).not.toMatch(/interests:/);
  });

  it("gates the whole submission on EMAIL, so an email-only signup still reaches us", () => {
    // The 2026-11-13 fix. Gating on phone meant the common case — a name and
    // an email — never called the backend at all, which is now also how the
    // email consent evidence would have been lost.
    const source = code(THEME_JS_V2);
    expect(source).toMatch(/if \(email === ''\) return null;/);
    expect(source).not.toMatch(/if \(phone === ''\) return null;/);
  });

  it("refuses to submit an SMS opt-in with no number, rather than dropping it", () => {
    // Shopify cannot hold an SMS consent for an account with no phone, so the
    // consent would vanish. The customer asked to be texted; say so.
    const source = code(THEME_JS_V2);
    expect(source).toMatch(/smsBox && smsBox\.checked && phoneField/);
    expect(source).toMatch(/errorSmsNeedsPhone/);
  });

  it("sends the consent copy version, so a stale cache is detectable", () => {
    expect(code(THEME_JS_V2)).toMatch(/consentCopyVersion: CONSENT_COPY_VERSION/);
  });

  it("posts the consents only AFTER the native form created the customer", () => {
    // The ordering that makes the whole design work: the customer must exist
    // before the proxy call, or the lookup finds nobody and the consent is
    // lost. Pinned because it is a two-line change to break.
    const source = code(THEME_JS_V2);
    const successIndex = source.indexOf("renderSuccess(signupEl, html)");
    const sendIndex = source.indexOf("sendSignup(submission)", successIndex);
    expect(successIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(successIndex);
  });
});

describe("the SMS confirmation never pretends", () => {
  it("the route logs and continues when no provider is configured", () => {
    const source = code(ROUTE);
    expect(source).toMatch(/if \(!sms\.configured\)/);
    expect(source).toMatch(/firstaccess\.sms_confirmation_unconfigured/);
  });

  it("a send failure does not undo the consent", () => {
    // The consent write happens first and is not rolled back: they asked to be
    // texted, and that permission stands whether or not the first text landed.
    // Measured on the CALL SITES, not on the imports: the import block lists
    // them alphabetically, so an index over the whole file compares the wrong
    // two lines and passes or fails for no reason. That is what it did first.
    const source = code(ROUTE);
    const consentCall = source.indexOf("await recordFirstAccessSmsConsent(");
    const sendCall = source.indexOf("sms.port.send(");
    expect(consentCall, "the consent call is missing").toBeGreaterThan(-1);
    expect(sendCall, "the send call is missing").toBeGreaterThan(-1);
    expect(sendCall).toBeGreaterThan(consentCall);
  });

  it("never logs the number, on any path", () => {
    // The one PII rule this route has always had, re-asserted now that there
    // are more log lines that could carry it.
    // Scanned line by line over the LOG CALLS only. A whole-file regex for
    // "e164 near a paren" matches the legitimate Shopify writes, which is why
    // the first version of this flagged correct code.
    const source = code(ROUTE);
    for (const line of source.split("\n")) {
      if (!/logger\.(info|warn|error)/.test(line)) continue;
      expect(line, `log line carries the number: ${line.trim()}`).not.toMatch(/e164|phoneResult\.e164/);
    }
  });
});
