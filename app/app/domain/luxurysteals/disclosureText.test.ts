import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FINAL_SALE_BADGE,
  FINAL_SALE_DISCLOSURE_BODY,
  FINAL_SALE_DISCLOSURE_CLAIMS,
  FINAL_SALE_DISCLOSURE_HEADING,
  FINAL_SALE_DISCLOSURE_LOCALE_PATHS,
} from "./disclosureText";

/**
 * Criterion 143 (docs/specs/SLICE-3-LUXURY-STEALS.md §13.1, "asserted by a
 * copy test, because this is the exact sentence a well-meaning edit shortens
 * into something untrue"). Same precedent as
 * `app/domain/bankpayment/notCommittedDisclosure.test.ts`: the module holds
 * the pinned constants, this file proves `theme/locales/en.default.json`'s
 * `luxury_steals.disclosure` keys are byte-identical to them, reading the
 * locale file FROM DISK rather than importing a shared constant. Liquid
 * cannot import a TypeScript module, so the theme's copy is genuinely a
 * second artefact — a test that compared this module to itself would pass
 * while the file a customer actually reads said something else entirely.
 *
 * If a test in this file fails, it is not a lint rule: it means the
 * owner-approved Final Sale disclosure has drifted from what was approved,
 * and — for the claims-paragraph tests specifically — that the one sentence
 * keeping "Final Sale" from reading as an end to CaratForUs's responsibility
 * for a defective, wrong, or not-as-described item may have been trimmed.
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

/**
 * Strips HTML tags before comparing. Chosen deliberately over a raw string
 * comparison, even though none of the three `luxury_steals.disclosure` keys
 * carry markup today (unlike `luxury_steals.acknowledgment.body_html`,
 * governed separately by this slice's `acknowledgmentText.ts`, which does).
 * Criterion 143's requirement is that the WORDS cannot change, not that the
 * bolding cannot — so this fence keeps protecting the wording unmodified if
 * a later change moves any of these three keys to an "_html" variant with
 * inline emphasis, rather than needing to be rewritten at that point. A
 * plain `.replace(/<[^>]+>/g, "")` is sufficient here: this copy is prose
 * with, at most, simple inline tags, not nested/attributed markup.
 */
function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

describe("criterion 143 — the Final Sale disclosure is pinned and matches the theme", () => {
  it("badge is character-for-character identical on the storefront", () => {
    const fromTheme = localeString(FINAL_SALE_DISCLOSURE_LOCALE_PATHS.badge);
    expect(typeof fromTheme).toBe("string");
    expect(stripHtml(fromTheme as string)).toBe(stripHtml(FINAL_SALE_BADGE));
  });

  it("heading is character-for-character identical on the storefront, including the em dash", () => {
    const fromTheme = localeString(FINAL_SALE_DISCLOSURE_LOCALE_PATHS.heading);
    expect(typeof fromTheme).toBe("string");
    expect(stripHtml(fromTheme as string)).toBe(stripHtml(FINAL_SALE_DISCLOSURE_HEADING));
    expect(FINAL_SALE_DISCLOSURE_HEADING).toContain("—"); // em dash, per spec §13.1's own callout
  });

  it("body is character-for-character identical on the storefront, including the curly apostrophe", () => {
    const fromTheme = localeString(FINAL_SALE_DISCLOSURE_LOCALE_PATHS.body);
    expect(typeof fromTheme).toBe("string");
    expect(stripHtml(fromTheme as string)).toBe(stripHtml(FINAL_SALE_DISCLOSURE_BODY));
    expect(FINAL_SALE_DISCLOSURE_BODY).toContain("can’t");
  });

  it(
    "claims paragraph is character-for-character identical on the storefront — " +
      "this is the sentence that keeps Final Sale from reading as an end to " +
      "CaratForUs's responsibility, and it is the one most at risk from a " +
      "well-meaning trim",
    () => {
      const fromTheme = localeString(FINAL_SALE_DISCLOSURE_LOCALE_PATHS.claims);
      expect(typeof fromTheme).toBe("string");
      expect(stripHtml(fromTheme as string)).toBe(stripHtml(FINAL_SALE_DISCLOSURE_CLAIMS));
      expect(FINAL_SALE_DISCLOSURE_CLAIMS).toContain("we’ll");
    }
  );

  it("fails if any of the four theme keys goes missing entirely, not just if it differs", () => {
    for (const [name, path] of Object.entries(FINAL_SALE_DISCLOSURE_LOCALE_PATHS)) {
      expect(localeString(path), `luxury_steals key for "${name}" is missing from the theme locale`).toBeTypeOf(
        "string"
      );
      expect(localeString([...path, "nope"])).toBeUndefined();
    }
  });
});

describe("criterion 143 / §4.5 separation — the disclosure must not read as ending our responsibility", () => {
  it("the heading scopes the restriction to change-of-mind reasons, not a flat 'cannot be returned'", () => {
    // The owner's specific revision (spec §13.1): the heading must not read
    // as a blanket "this item cannot be returned" with the qualifier
    // dropped — that would misstate criteria 141-142's scope.
    expect(FINAL_SALE_DISCLOSURE_HEADING).toMatch(/change-of-mind reasons/i);
  });

  it("the claims paragraph names the categories of claim Final Sale does not block (criterion 142)", () => {
    expect(FINAL_SALE_DISCLOSURE_CLAIMS).toMatch(/damaged/i);
    expect(FINAL_SALE_DISCLOSURE_CLAIMS).toMatch(/not what you ordered/i);
    expect(FINAL_SALE_DISCLOSURE_CLAIMS).toMatch(/does not match its description/i);
    expect(FINAL_SALE_DISCLOSURE_CLAIMS).toMatch(/warranty/i);
  });

  it("the claims paragraph promises a REVIEW under policy, never a pre-inspection remedy", () => {
    // Spec §13.1's own callout: "review it under the applicable ... policy",
    // not "put it right" — a promised remedy before inspection would commit
    // CaratForUs to an outcome it has not yet determined.
    expect(FINAL_SALE_DISCLOSURE_CLAIMS).toMatch(/review it under the applicable/i);
    expect(FINAL_SALE_DISCLOSURE_CLAIMS).not.toMatch(/we will (fix|replace|refund|put it right)/i);
  });

  it("nowhere does the disclosure claim CaratForUs has no responsibility after purchase", () => {
    const full = `${FINAL_SALE_DISCLOSURE_HEADING} ${FINAL_SALE_DISCLOSURE_BODY} ${FINAL_SALE_DISCLOSURE_CLAIMS}`;
    expect(full).not.toMatch(/no (further )?responsibility|as[- ]is|no warranty/i);
  });
});
