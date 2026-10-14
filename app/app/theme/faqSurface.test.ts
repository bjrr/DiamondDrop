import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE FAQ THEME SURFACE — `sections/faq.liquid`, `snippets/faq-list.liquid`,
 * `snippets/product-faq.liquid`, `templates/page.faq.json`.
 *
 * ============================================================================
 * WHAT THESE TESTS ARE FOR
 * ============================================================================
 * The FAQ renders from Shopify metaobjects, which this suite cannot create or
 * query. So these are not rendering tests — they pin the things that are
 * statically checkable and that fail SILENTLY if wrong:
 *
 *   1. the metaobject TYPE HANDLE and FIELD KEYS the Liquid reads. Liquid
 *      returns nil for an unknown field, so an Admin definition using
 *      `answer_text` instead of `answer` produces blank entries with no error
 *      anywhere — the worst possible failure, because the content exists and
 *      looks fine in Admin;
 *   2. the product metafield namespace and key, for the same reason;
 *   3. that both surfaces render through ONE snippet, so an answer cannot
 *      look different on the FAQ page and the product page;
 *   4. that no FAQ content is hardcoded in the theme — the whole point is
 *      that Admin owns it.
 *
 * The field names asserted here are the ones `docs/specs/SLICE-12-CONTENT.md`
 * §4.2 specifies: question, answer, category, and an optional sort key.
 */

const THEME = join(process.cwd(), "..", "theme");
const SECTION = readFileSync(join(THEME, "sections", "faq.liquid"), "utf8");
const LIST = readFileSync(join(THEME, "snippets", "faq-list.liquid"), "utf8");
const PRODUCT = readFileSync(join(THEME, "snippets", "product-faq.liquid"), "utf8");
const ENTRY = readFileSync(join(THEME, "snippets", "faq-entry.liquid"), "utf8");
const TEMPLATE = readFileSync(join(THEME, "templates", "page.faq.json"), "utf8");

/**
 * The field keys are read across TWO snippets: `faq-list` reads `sort_key`
 * for ordering, `faq-entry` reads question/answer/category for output.
 * Checking only one would pass while the other silently read a wrong key.
 */
const FIELD_READERS = [LIST, ENTRY].join("\n");

describe("the metaobject contract with the Admin definition", () => {
  it("reads the type handle `faq_entry`", () => {
    // If Admin creates the definition under a different handle, the page
    // renders nothing at all and no error appears anywhere.
    expect(SECTION).toContain("shop.metaobjects.faq_entry.values");
  });

  it("reads exactly the four fields the spec defines", () => {
    for (const field of ["question", "answer", "category", "sort_key"]) {
      expect(FIELD_READERS, `nothing reads entry.${field}`).toMatch(
        new RegExp(String.raw`entry\.${field}|sort:\s*'${field}'|where:\s*'${field}'`)
      );
    }
  });

  it("the spec still documents those field names", () => {
    // Guard against the test and the spec drifting apart: if §4.2 is reworded
    // to different field names, this fails rather than the theme silently
    // disagreeing with Admin.
    const spec = readFileSync(
      join(process.cwd(), "..", "docs", "specs", "SLICE-12-CONTENT.md"),
      "utf8"
    );
    expect(spec).toMatch(/question/i);
    expect(spec).toMatch(/answer/i);
    expect(spec).toMatch(/category/i);
    expect(spec).toMatch(/sort key/i);
  });
});

describe("the product metafield contract", () => {
  it("reads carat.faq_entries", () => {
    expect(PRODUCT).toContain("product.metafields.carat.faq_entries");
  });

  it("uses the `carat` namespace, matching every other CaratForUs metafield", () => {
    // carat.bank_payment_price_minor_units, carat.luxury_steal. A different
    // namespace here would be a second convention nobody remembers.
    expect(PRODUCT).not.toMatch(/metafields\.(?!carat\.)[a-z_]+\.faq/);
  });

  it("reads `.value` so a reference LIST resolves to entries", () => {
    // Without `.value` a list-of-references metafield yields the metafield
    // object, not the referenced metaobjects, and the loop silently iterates
    // nothing.
    expect(PRODUCT).toMatch(/faq_entries\.value/);
  });
});

describe("one renderer, so the two surfaces cannot diverge", () => {
  it("the FAQ page renders through faq-list", () => {
    expect(SECTION).toMatch(/render 'faq-list'/);
  });

  it("the product snippet renders through faq-list", () => {
    expect(PRODUCT).toMatch(/render 'faq-list'/);
  });

  it("only faq-entry emits the disclosure markup", () => {
    /**
     * COMMENTS STRIPPED — and this is the THIRD time in this slice that a
     * fence of mine matched its own documentation. `faq-list.liquid`'s header
     * explains why native `<details>`/`<summary>` was chosen over a scripted
     * accordion, which is exactly the sort of reasoning that belongs next to
     * the code; the assertion is about EMITTED MARKUP, not about whether the
     * file may discuss it.
     *
     * The recurring lesson, recorded because I kept relearning it: a
     * text-scanning fence must first reduce the file to the thing it actually
     * governs. Prose that names the forbidden construct is not the forbidden
     * construct.
     */
    for (const [name, src] of [
      ["faq.liquid", SECTION],
      ["faq-list.liquid", LIST],
      ["product-faq.liquid", PRODUCT],
    ] as const) {
      const code = withoutComments(src);
      expect(code, `${name} emits its own <details>`).not.toMatch(/<details/);
      expect(code, `${name} emits its own <summary>`).not.toMatch(/<summary/);
    }
    expect(withoutComments(ENTRY)).toMatch(/<details/);
    expect(withoutComments(ENTRY)).toMatch(/<summary/);
  });

  it("faq-list reaches entries only through faq-entry", () => {
    expect(LIST).toMatch(/render 'faq-entry'/);
  });
});

/**
 * CODE ONLY — Liquid comments stripped.
 *
 * The first version of the two assertions below scanned whole files and
 * failed on this surface's own documentation: the `sort_key` rationale quotes
 * an example question ("How long will my piece take?"), and the section
 * header cites the README's ten categories by name. Both are explanation, and
 * a fence that forbids explaining the design pushes the explanation out of
 * the code — which is the opposite of useful.
 *
 * Same error I made in `faqCopyConsistency.test.ts`, where the unit was lines
 * rather than blockquotes. The unit here is the comment block.
 */
function withoutComments(liquid: string): string {
  return liquid.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ");
}

describe("Admin owns the content, not the theme", () => {
  it("the comment stripper actually removes documentation", () => {
    // Guard the guard: if this returned the input unchanged, both assertions
    // below would be scanning comments again.
    expect(LIST).toMatch(/How long will my piece take/);
    expect(withoutComments(LIST)).not.toMatch(/How long will my piece take/);
  });

  it("hardcodes no FAQ question or answer text", () => {
    // Settings defaults (headings) are fine; a question or answer is not.
    for (const [name, src] of [
      ["faq.liquid", SECTION],
      ["faq-list.liquid", LIST],
      ["product-faq.liquid", PRODUCT],
    ] as const) {
      expect(
        withoutComments(src),
        `${name} appears to hardcode a question`
      ).not.toMatch(/"(How|What|Can|Do|Does|Will|Where|Why|When)\b[^"]{10,}\?"/);
    }
  });

  it("does not hardcode the ten README categories", () => {
    // Categories are derived from the entries. A hardcoded list means an
    // entry filed under an unknown category never appears.
    const code = withoutComments(SECTION);
    for (const category of ["Ring Sizing", "Materials & Stones", "Pricing & Refunds"]) {
      expect(code, `faq.liquid hardcodes the category "${category}"`).not.toContain(category);
    }
  });

  it("renders nothing when there are no entries", () => {
    // An empty FAQ heading over blank space looks broken; an absent section
    // looks like a page without an FAQ, which is the truth.
    expect(SECTION).toMatch(/if all_entries != blank and all_entries\.size > 0/);
  });

  it("still shows entries that have no category, rather than hiding them", () => {
    // Hiding them makes a content mistake invisible: staff see the entry in
    // Admin and never on the page.
    expect(SECTION).toMatch(/where: 'category', blank/);
    expect(SECTION).toMatch(/uncategorised_heading/);
  });
});

describe("accessibility and markup", () => {
  it("uses native <details>/<summary> rather than scripted accordions", () => {
    expect(LIST).toMatch(/<details/);
    expect(LIST).toMatch(/<summary/);
  });

  it("ships no JavaScript for the FAQ at all", () => {
    // The data is in Shopify and available to Liquid; unlike policy terms
    // there is nothing to fetch, so there is no script to fail.
    for (const src of [SECTION, LIST, PRODUCT]) {
      expect(src).not.toMatch(/<script/);
    }
  });

  it("restores a visible focus ring after removing the native marker", () => {
    // Hiding the marker without restoring focus makes the disclosure
    // unusable by keyboard — easy to break on <details> specifically.
    const css = readFileSync(join(THEME, "assets", "component-faq.css"), "utf8");
    expect(css).toMatch(/list-style:\s*none/);
    expect(css).toMatch(/:focus-visible/);
  });

  it("honours prefers-reduced-motion for the caret", () => {
    const css = readFileSync(join(THEME, "assets", "component-faq.css"), "utf8");
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe("the page template", () => {
  it("is valid JSON and wires the faq section after the page body", () => {
    const parsed = JSON.parse(TEMPLATE) as {
      sections: Record<string, { type: string }>;
      order: string[];
    };
    const types = Object.values(parsed.sections).map((s) => s.type);
    expect(types).toContain("main-page");
    expect(types).toContain("faq");

    // Body first, FAQ below it — same arrangement as the policy pages, so an
    // introduction written in Admin appears above the questions.
    const faqKey = Object.keys(parsed.sections).find((k) => parsed.sections[k]!.type === "faq")!;
    const mainKey = Object.keys(parsed.sections).find((k) => parsed.sections[k]!.type === "main-page")!;
    expect(parsed.order.indexOf(mainKey)).toBeLessThan(parsed.order.indexOf(faqKey));
  });
});
