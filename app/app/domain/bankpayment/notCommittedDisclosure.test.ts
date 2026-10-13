import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInvoiceCustomMessage,
  NOT_COMMITTED_DISCLOSURE,
  NOT_COMMITTED_DISCLOSURE_LOCALE_PATH,
} from "./notCommittedDisclosure";

/**
 * The §22 disclosure has to say the same thing in two places built by two
 * different technologies — the storefront form (Liquid, via a locale key) and
 * the invoice email (server-side, via Shopify's `customMessage`). Two copies
 * of material customer terms drift: one gets edited, the other does not, and a
 * customer is told two different things about whether their order exists.
 *
 * So this file's job is not to pin the wording — the owner has not approved
 * any wording yet, and pinning a draft would dress it as a decision. Its job
 * is to pin the INVARIANTS that survive an approval edit: the two surfaces
 * agree, and neither carries a term the merchandise-only savings rule forbids.
 */

function localeString(path: readonly string[]): unknown {
  const locale = JSON.parse(
    readFileSync(join(process.cwd(), "..", "theme", "locales", "en.default.json"), "utf8")
  );
  return path.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    locale
  );
}

describe("the §22 not-committed disclosure", () => {
  it("is character-for-character identical on the storefront and in the invoice email", () => {
    const fromTheme = localeString(NOT_COMMITTED_DISCLOSURE_LOCALE_PATH);

    expect(typeof fromTheme).toBe("string");
    expect(fromTheme).toBe(NOT_COMMITTED_DISCLOSURE);
    expect(buildInvoiceCustomMessage()).toBe(NOT_COMMITTED_DISCLOSURE);
  });

  /**
   * Reading the locale from disk rather than importing a shared constant is
   * deliberate. Liquid cannot import a TypeScript module, so the theme's copy
   * is genuinely a second artefact — and a test that compared the constant to
   * itself would pass while the file a customer actually reads said something
   * else entirely.
   */
  it("fails if the theme's key goes missing entirely, not just if it differs", () => {
    expect(localeString([...NOT_COMMITTED_DISCLOSURE_LOCALE_PATH, "nope"])).toBeUndefined();
    expect(localeString(NOT_COMMITTED_DISCLOSURE_LOCALE_PATH)).toBeTypeOf("string");
  });

  it("says the two things §22 requires: not committed, and nothing charged yet", () => {
    // Asserted on meaning, not phrasing, so an approved rewording still passes
    // while a rewrite that quietly drops a material term does not.
    expect(NOT_COMMITTED_DISCLOSURE).toMatch(/not placed|not committed/i);
    expect(NOT_COMMITTED_DISCLOSURE).toMatch(/verif/i);
    expect(NOT_COMMITTED_DISCLOSURE).toMatch(/nothing is charged|no payment/i);
  });

  it("carries no money figure and no forbidden pricing vocabulary", () => {
    // The rule is NO MONEY FIGURE, not "no digits" — the approved copy names
    // the 24-hour guarantee, which is a duration, not a price. An earlier
    // version of this test banned every digit and would have blocked the
    // owner's own wording, which is the wrong kind of strictness: it enforces
    // the letter of a rule against the thing the rule exists to protect.
    expect(NOT_COMMITTED_DISCLOSURE).not.toMatch(/\$|\d+(\.\d{2})|\d+\s*(USD|dollars)/i);
    expect(NOT_COMMITTED_DISCLOSURE).not.toMatch(
      /surcharge|card fee|cash discount|uplift|tier|margin|markup|landed cost|%/i
    );
    // The only number the approved text uses is the guarantee window.
    expect(NOT_COMMITTED_DISCLOSURE.match(/\d+/g)).toEqual(["24"]);
  });
});
