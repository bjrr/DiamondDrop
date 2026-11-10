import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE DIAMOND SURFACE — provider-neutral by construction.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 * The owner's instruction was explicit: keep /pages/diamonds provider-neutral
 * internally, "so we can later replace Nivoda with UNI or another provider
 * without changing homepage/navigation URLs."
 *
 * That is a promise about the FUTURE, which means the thing most likely to
 * break it is a future edit — someone wiring up a supplier and reaching for
 * the quickest spelling. A supplier name in the page handle, the section, or
 * a CTA link is cheap to add and expensive to remove, because by then it is
 * in customers' browser history, in search indexes and in ad campaigns.
 *
 * So the neutrality is pinned here rather than written down and hoped for.
 *
 * ===========================================================================
 * THE OTHER THING PINNED HERE
 * ===========================================================================
 * The homepage already has one <h1>, in the hero. The obvious section to
 * reuse for a headline-plus-two-buttons band was `carat-pagehead`, and it
 * emits an <h1> — its own comment says level 1 belongs to the homepage. A
 * second <h1> is a real accessibility and SEO defect that renders fine and
 * so would never be noticed by looking at the page.
 */

const THEME = join(process.cwd(), "..", "theme");
const SECTION_PATH = join(THEME, "sections", "carat-diamond-cta.liquid");
const SECTION = readFileSync(SECTION_PATH, "utf8");
const INDEX = readFileSync(join(THEME, "templates", "index.json"), "utf8");
const PAGE_TEMPLATE = readFileSync(join(THEME, "templates", "page.diamonds.json"), "utf8");

/** Shopify JSON templates may carry a leading block comment. */
function parseTemplate(source: string): {
  sections: Record<string, { type: string; settings?: Record<string, unknown> }>;
  order: string[];
} {
  return JSON.parse(source.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
}

/** Liquid with comments and `{% style %}` blocks removed. */
function liquidCode(source: string): string {
  return source
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    .replace(/\{%-?\s*style\s*-?%\}[\s\S]*?\{%-?\s*endstyle\s*-?%\}/g, "");
}

/**
 * Comments removed, `{% style %}` KEPT.
 *
 * Two different questions need two different views of the source, and the
 * first version of this file got it wrong. "Does this section pull in the
 * shared stylesheet" must ignore comments — the section's own header
 * paragraph NAMES carat-editorial.css to explain why it deliberately does
 * not use it, so asserting against the raw file fails on the prose
 * documenting the behaviour. "Is the CSS scoped to the section instance" is
 * a question about the style block, so stripping it makes the question
 * unanswerable. Hence two strippers.
 */
function withoutComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

const CODE = liquidCode(SECTION);
const LIVE = withoutComments(SECTION);

/**
 * Every supplier whose name must not appear in a customer-facing URL, handle
 * or template name. Spelled out rather than regex-guessed so that adding a
 * provider to the business means deliberately adding it here too.
 */
const SUPPLIER_NAMES = ["nivoda", "unbridaled", "uni-diamonds", "rapnet", "idex", "vdb"];

describe("the diamond homepage section", () => {
  it("emits an h2 and never an h1", () => {
    // THE CORE ACCESSIBILITY ASSERTION. One <h1> per page, and on the
    // homepage that one belongs to the hero.
    expect(CODE).toContain("<h2");
    expect(CODE).not.toContain("<h1");
  });

  it("names no supplier, anywhere, including in its class names", () => {
    const haystack = SECTION.toLowerCase();
    for (const supplier of SUPPLIER_NAMES) {
      expect(haystack).not.toContain(supplier);
    }
  });

  it("defaults both buttons to the provider-neutral diamond page", () => {
    // `default:` matters as much as the template settings: a section dropped
    // onto another page with empty settings must still not invent a
    // destination, least of all a supplier's own site.
    const defaults = CODE.match(/default:\s*'([^']*)'/g) ?? [];
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    for (const fallback of defaults) {
      if (fallback.includes("/")) expect(fallback).toContain("/pages/diamonds");
    }
  });

  it("escapes every piece of merchant-entered copy", () => {
    // These are theme-editor settings, so they are merchant input rendered
    // into HTML. The section is plain text and has no reason to emit raw
    // markup anywhere.
    for (const setting of ["eyebrow", "heading", "text", "cta_label", "cta2_label", "note"]) {
      const pattern = new RegExp(`section\\.settings\\.${setting}\\s*\\|\\s*escape`);
      expect(CODE, `${setting} must be escaped`).toMatch(pattern);
    }
  });

  it("ships its own styling instead of editing a shared stylesheet", () => {
    // carat-editorial.css is a 40KB asset shared by every carat-* section,
    // and the copies on the store have drifted from this repository. An
    // additive section that overwrites it to draw two buttons would trade a
    // large regression risk for a small convenience.
    expect(LIVE).toMatch(/\{%-?\s*style\s*-?%\}/);
    expect(LIVE).not.toContain("carat-editorial.css");
    // Scoped to the section instance, so two instances cannot fight.
    expect(LIVE).toContain("#shopify-section-{{ section.id }}");
  });
});

describe("the homepage wiring", () => {
  const index = parseTemplate(INDEX);

  it("carries exactly one diamond section", () => {
    const diamondKeys = Object.entries(index.sections)
      .filter(([, section]) => section.type === "carat-diamond-cta")
      .map(([key]) => key);
    expect(diamondKeys).toEqual(["diamonds"]);
  });

  it("places it immediately after the hero, which is the prominent slot", () => {
    // The brief asked for a PROMINENT homepage section. "Present somewhere on
    // the homepage" would satisfy the letter of that and not the point, so
    // the position is pinned rather than left to whoever edits next.
    expect(index.order[0]).toBe("heroslider");
    expect(index.order[1]).toBe("diamonds");
  });

  it("uses the approved copy and labels", () => {
    const settings = index.sections.diamonds!.settings!;
    expect(settings.heading).toBe("Buy Diamonds at Direct Prices");
    expect(settings.text).toBe(
      "Search certified natural and lab-grown diamonds with transparent CaratForUs pricing."
    );
    expect(settings.cta_label).toBe("Shop Lab-Grown Diamonds");
    expect(settings.cta2_label).toBe("Shop Natural Diamonds");
  });

  it("sends both buttons to /pages/diamonds and never off-site", () => {
    const settings = index.sections.diamonds!.settings!;
    for (const key of ["cta_link", "cta2_link"] as const) {
      const link = String(settings[key]);
      expect(link.startsWith("/pages/diamonds")).toBe(true);
      // A supplier's own storefront is the one destination the brief rules
      // out by name: "Do not redirect customers to the Nivoda B2B website."
      expect(link).not.toMatch(/^https?:/);
      for (const supplier of SUPPLIER_NAMES) {
        expect(link.toLowerCase()).not.toContain(supplier);
      }
    }
  });
});

describe("the /pages/diamonds template", () => {
  const template = parseTemplate(PAGE_TEMPLATE);

  it("is named for the product, not the provider", () => {
    // The template suffix IS the public contract: page.diamonds.json serves
    // /pages/diamonds. A page.nivoda.json would mean the URL could not
    // survive a provider change, which is the whole thing being avoided.
    expect(existsSync(join(THEME, "templates", "page.diamonds.json"))).toBe(true);
    for (const supplier of SUPPLIER_NAMES) {
      expect(existsSync(join(THEME, "templates", `page.${supplier}.json`))).toBe(false);
    }
  });

  it("hosts the diamond feed through the theme's app-block section", () => {
    // `apps` is Shopify's own @app block host. Using it means the feed is
    // added and removed in the theme editor, so swapping providers is a
    // merchant action rather than a code change — which is what makes the
    // neutrality above actually worth something.
    const types = template.order.map((key) => template.sections[key]!.type);
    expect(types).toContain("apps");
  });

  it("references only sections that exist in the theme", () => {
    for (const key of template.order) {
      const type = template.sections[key]!.type;
      expect(
        existsSync(join(THEME, "sections", `${type}.liquid`)),
        `sections/${type}.liquid is missing`
      ).toBe(true);
    }
  });

  it("leads with the page heading before the feed", () => {
    // The feed is a third-party block; the branded header must come first so
    // the page reads as CaratForUs rather than as an embedded tool.
    expect(template.order.indexOf("head")).toBeLessThan(template.order.indexOf("feed"));
  });

  it("names no supplier in the template itself", () => {
    const haystack = PAGE_TEMPLATE.toLowerCase();
    for (const supplier of SUPPLIER_NAMES) {
      expect(haystack).not.toContain(supplier);
    }
  });
});
