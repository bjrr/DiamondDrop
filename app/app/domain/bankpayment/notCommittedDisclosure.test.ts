import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {

  NOT_COMMITTED_DISCLOSURE,
  NOT_COMMITTED_DISCLOSURE_LOCALE_PATH,
} from "./notCommittedDisclosure";

/**
 * The §22 disclosure exists in two artefacts built by two different
 * technologies — the storefront form (Liquid, via a locale key) and the
 * TypeScript constant. Liquid cannot import the constant, so the theme's
 * copy is genuinely a second artefact, and two copies of material customer
 * terms drift: one gets edited, the other does not, and a customer is told
 * two different things about whether their order exists.
 *
 * This file pins the INVARIANTS rather than only the wording: the two
 * surfaces agree, the material clauses survive, and neither carries a term
 * the merchandise-only savings rule forbids. `ownerApprovedCopy.test.ts`
 * pins the exact approved words separately — identical-but-wrong and
 * approved-but-divergent are different failures and need different tests.
 *
 * (The second surface was once Shopify's invoice email, via `customMessage`.
 * Bank Payment no longer sends one — register D15.)
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
  it("is character-for-character identical on the storefront and in the constant", () => {
    // The third assertion here used to compare `buildInvoiceCustomMessage()`
    // against the constant. That helper existed only to put the disclosure
    // into Shopify's draft-order invoice email, and Bank Payment no longer
    // sends one (register D15), so the helper is gone and with it the
    // surface it synchronised.
    const fromTheme = localeString(NOT_COMMITTED_DISCLOSURE_LOCALE_PATH);

    expect(typeof fromTheme).toBe("string");
    expect(fromTheme).toBe(NOT_COMMITTED_DISCLOSURE);
  });

  it("no longer promises a Shopify invoice, because none is sent", () => {
    // The clause superseded on 2026-10-24. Asserted as an absence so the old
    // promise cannot drift back in alongside the new one.
    expect(NOT_COMMITTED_DISCLOSURE).not.toMatch(/invoice/i);
    expect(NOT_COMMITTED_DISCLOSURE).toContain("We’ll show you payment instructions here");
  });

  it("keeps every other approved clause unchanged", () => {
    // The supersession was scoped to the delivery promise. These three are
    // the material terms and must survive it verbatim.
    expect(NOT_COMMITTED_DISCLOSURE).toContain(
      "Your Bank Payment Price is guaranteed for 24 hours."
    );
    expect(NOT_COMMITTED_DISCLOSURE).toContain(
      "Submitting this form does not complete your order or reserve your items."
    );
    expect(NOT_COMMITTED_DISCLOSURE).toContain(
      "Your order is not committed and availability is not guaranteed until your Bank Payment is received and verified."
    );
    expect(NOT_COMMITTED_DISCLOSURE).toContain("Nothing is charged when you submit this form.");
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
