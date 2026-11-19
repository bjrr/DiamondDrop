import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL,
  FIRST_ACCESS_CONSENT_COPY_VERSION,
  FIRST_ACCESS_EMAIL_CONSENT_LOCALE_KEY,
  FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG,
  FIRST_ACCESS_EMAIL_CONSENT_POLICY_VERSION,
  FIRST_ACCESS_EMAIL_CONSENT_TEXT,
  FIRST_ACCESS_SMS_CONSENT_LOCALE_KEY,
  FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG,
  FIRST_ACCESS_SMS_CONSENT_POLICY_VERSION,
  FIRST_ACCESS_SMS_CONSENT_TEXT,
} from "./marketingConsentCopy";

/**
 * ============================================================================
 * THE SENTENCE STORED AS EVIDENCE MUST BE THE SENTENCE THE CUSTOMER READ
 * ============================================================================
 * Three places hold this wording — this module, the theme locale file, and the
 * `policy_version` migration — and only the locale file is what a customer
 * actually sees. If the module drifts from it, every consent record stores a
 * sentence nobody was shown, which is worse than storing nothing: a confident
 * record of the wrong thing.
 *
 * So this file reads the REAL theme locale JSON and the REAL migration SQL off
 * disk and compares them byte for byte. It is deliberately not a test of
 * constants against themselves.
 */

const REPO_ROOT = join(process.cwd(), "..");
const LOCALE_PATH = join(REPO_ROOT, "theme", "locales", "en.default.json");
const FORM_SNIPPET_PATH = join(REPO_ROOT, "theme", "snippets", "first-access-v2-form.liquid");
const THEME_JS_PATH = join(REPO_ROOT, "theme", "assets", "first-access-v2.js");
const MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20261118160000_first_access_marketing_consent_policies",
  "migration.sql"
);

/**
 * The snippet with its Liquid comments removed.
 *
 * NECESSARY, not convenient. The snippet's own header documents the hidden
 * `contact[accepts_marketing]` field it replaced, by quoting it — which is
 * exactly the documentation a future reader needs, and exactly the string a
 * naive search for that field would find. Stripping comments asserts on the
 * MARKUP rather than on the prose about the markup.
 */
function formMarkup(): string {
  return readFileSync(FORM_SNIPPET_PATH, "utf8").replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

/**
 * One `<input>` tag, found by a marker inside it.
 *
 * `[^>]*` on both sides, never `[\s\S]*?`: a lazy any-character match starts
 * at the FIRST input in the file and runs to the marker, so it returns several
 * tags glued together and every assertion about "the" tag then describes the
 * wrong one. That bug made four of these tests pass for the wrong reason
 * before it made them fail for the right one.
 */
function inputWith(marker: string): string {
  const match = formMarkup().match(new RegExp(`<input\\b[^>]*${marker}[^>]*>`));
  expect(match, `no <input> found containing ${marker}`).not.toBeNull();
  return match![0];
}

function localeForm(): Record<string, string> {
  const json = JSON.parse(readFileSync(LOCALE_PATH, "utf8")) as {
    templates: { first_access: { form: Record<string, string> } };
  };
  return json.templates.first_access.form;
}

describe("the consent wording is one string, in three places", () => {
  it("the EMAIL sentence in the theme locale is exactly the module's", () => {
    expect(localeForm()[FIRST_ACCESS_EMAIL_CONSENT_LOCALE_KEY]).toBe(FIRST_ACCESS_EMAIL_CONSENT_TEXT);
  });

  it("the SMS sentence in the theme locale is exactly the module's", () => {
    expect(localeForm()[FIRST_ACCESS_SMS_CONSENT_LOCALE_KEY]).toBe(FIRST_ACCESS_SMS_CONSENT_TEXT);
  });

  it("the migration stores both sentences verbatim, with hashes that match them", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");

    for (const [slug, text] of [
      [FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG, FIRST_ACCESS_EMAIL_CONSENT_TEXT],
      [FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG, FIRST_ACCESS_SMS_CONSENT_TEXT],
    ] as const) {
      expect(sql, `migration is missing the ${slug} row`).toContain(`'${slug}'`);
      // The SQL literal, with no escaping needed because neither sentence
      // contains a single quote. If one ever does, this assertion failing is
      // the correct outcome: the migration would need escaping and a plain
      // `toContain` would no longer be a valid check.
      expect(text).not.toContain("'");
      expect(sql, `migration text differs from the module for ${slug}`).toContain(`'${text}'`);
      // PLAIN sha256 of the exact string, NOT canonical-JSON hashed.
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      expect(sql, `migration hash differs from the module for ${slug}`).toContain(`'${hash}'`);
    }
  });

  it("the theme JS sends the same copy version this module declares", () => {
    // A mismatch would make every signup log a version warning, which would
    // then be ignored as noise — the usual fate of an alarm that is always on.
    const js = readFileSync(THEME_JS_PATH, "utf8");
    expect(js).toContain(`var CONSENT_COPY_VERSION = '${FIRST_ACCESS_CONSENT_COPY_VERSION}';`);
  });
});

describe("the live form renders the consents correctly", () => {
  it("has NO hidden accepts_marketing field — consent is never pre-asserted", () => {
    // THE DEFECT THIS WHOLE CHANGE EXISTS TO FIX. A hidden field fixed at
    // "true" subscribed every signup without anyone agreeing to anything.
    const markup = formMarkup();
    expect(markup).not.toMatch(/type="hidden"[^>]*name="contact\[accepts_marketing\]"/);
    expect(markup).not.toMatch(/name="contact\[accepts_marketing\]"[^>]*type="hidden"/);
    // And it is gone as markup, not merely reordered: the only remaining
    // mention of the field is on a checkbox.
    expect(markup.match(/name="contact\[accepts_marketing\]"/g) ?? []).toHaveLength(1);
  });

  it("binds the email opt-in to the NATIVE Shopify field, as a checkbox", () => {
    // Native means an unchecked box is omitted by the browser and Shopify
    // records no subscription, with no code deciding that.
    const emailBox = inputWith("data-fa2-email-consent");
    expect(emailBox).toContain('type="checkbox"');
    expect(emailBox).toContain('name="contact[accepts_marketing]"');
  });

  it("gives the SMS opt-in NO name attribute, so it cannot look submitted when it isn't", () => {
    // Shopify's customer form has no SMS field; a named input would be posted
    // and ignored, which is how a consent gets quietly lost.
    const smsBox = inputWith("data-fa2-sms-consent");
    expect(smsBox).toContain('type="checkbox"');
    expect(smsBox).not.toContain("name=");
  });

  it("pre-checks NEITHER box and requires NEITHER", () => {
    for (const marker of ["data-fa2-email-consent", "data-fa2-sms-consent"]) {
      const box = inputWith(marker);
      expect(box, `${marker} is pre-checked`).not.toMatch(/\bchecked\b/);
      expect(box, `${marker} is required`).not.toMatch(/\brequired\b/);
    }
  });

  it("renders both consents from the locale, never from inline text", () => {
    // Inline copy would be a fourth place for the wording to live, and the one
    // place this test could not compare against the evidence.
    const markup = formMarkup();
    expect(markup).toContain("'templates.first_access.form.email_consent' | t");
    expect(markup).toContain("'templates.first_access.form.sms_consent' | t");
    expect(markup).not.toContain("Email me CaratForUs");
    expect(markup).not.toContain("Text me CaratForUs");
  });

  it("links the Privacy Policy and Terms beside the consents", () => {
    const markup = formMarkup();
    expect(markup).toContain("privacy_url");
    expect(markup).toContain("terms_url");
    const legal = localeForm().consent_legal_html;
    expect(legal).toContain("Privacy Policy");
    expect(legal).toContain("Terms");
    expect(legal).toContain("unsubscribe at any time");
  });

  it("still carries the first-access tag", () => {
    // Existing behaviour that must not be collateral damage.
    expect(formMarkup()).toContain('name="contact[tags]" value="first-access"');
  });

  it("keeps the mobile number optional", () => {
    const phone = inputWith('name="contact\\[phone\\]"');
    expect(phone).not.toMatch(/\brequired\b/);
    // And the label says so, while naming the one case where it is needed.
    expect(localeForm().phone_label).toMatch(/optional/i);
  });
});

describe("the SMS wording carries the disclosures a marketing opt-in needs", () => {
  it("names the channel, the frequency, the rates and how to stop", () => {
    // Each one is a separate requirement, so each gets its own assertion: a
    // single regex over the whole sentence would pass while missing one.
    expect(FIRST_ACCESS_SMS_CONSENT_TEXT).toContain("Text me");
    expect(FIRST_ACCESS_SMS_CONSENT_TEXT).toContain("Message frequency varies");
    expect(FIRST_ACCESS_SMS_CONSENT_TEXT).toContain("Msg & data rates may apply");
    expect(FIRST_ACCESS_SMS_CONSENT_TEXT).toContain("Reply STOP to unsubscribe");
  });

  it("names what will actually be sent, on both channels", () => {
    // Consent to "updates" is not consent to promotions. Both sentences list
    // the owner's own categories so the permission covers what we intend.
    for (const text of [FIRST_ACCESS_EMAIL_CONSENT_TEXT, FIRST_ACCESS_SMS_CONSENT_TEXT]) {
      expect(text).toContain("early access");
      expect(text).toContain("new arrivals");
      expect(text).toContain("Group Buys");
      expect(text).toContain("special offers");
      expect(text).toContain("sales");
      expect(text).toContain("promotions");
    }
  });

  it("does not let the email sentence imply texting, or the SMS one imply email", () => {
    // The two permissions are independent, and the wording has to be too.
    expect(FIRST_ACCESS_EMAIL_CONSENT_TEXT.toLowerCase()).not.toContain("text");
    expect(FIRST_ACCESS_EMAIL_CONSENT_TEXT.toLowerCase()).not.toContain("sms");
    expect(FIRST_ACCESS_SMS_CONSENT_TEXT.toLowerCase()).not.toContain("email me");
  });
});

describe("the policy identity", () => {
  it("uses two separate slugs, one per channel", () => {
    expect(FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG).toBe("first-access-email-marketing-consent");
    expect(FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG).toBe("first-access-sms-marketing-consent");
    expect(FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG).not.toBe(FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG);
  });

  it("names the signup surface in the slug, so a later surface gets its own", () => {
    for (const slug of [FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG, FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG]) {
      expect(slug.startsWith("first-access-")).toBe(true);
    }
  });

  it("starts both channels at version 1", () => {
    expect(FIRST_ACCESS_EMAIL_CONSENT_POLICY_VERSION).toBe(1);
    expect(FIRST_ACCESS_SMS_CONSENT_POLICY_VERSION).toBe(1);
  });

  it("records what the customer DID, not merely that they did something", () => {
    expect(FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL).toBe("Checked the opt-in box");
  });
});
