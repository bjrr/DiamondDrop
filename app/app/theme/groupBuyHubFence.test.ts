import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE HUB MUST NOT REINTRODUCE THE THINGS IT WAS BUILT TO REMOVE.
 *
 * Three properties of the shipped theme files, none of which a unit test of
 * the server can see:
 *
 *   1. NO CAMPAIGN CONTENT IN THEME EDITOR. The hub lists every open
 *      campaign, and that membership changes on its own. A `campaign_code`
 *      or `campaign_options_json` setting appearing here would mean a
 *      merchant maintaining a second, always-stale copy of what the Admin
 *      Builder already knows.
 *   2. NO PRICE ARITHMETIC IN THE BROWSER. Every figure is derived by the
 *      server's own Group Buy pricing path. A division by 100 in the theme
 *      is how a price picks up a float error on its way to a shopper.
 *   3. NO REQUEST PER CAMPAIGN OR PER VARIANT. The existing campaign page
 *      fetches once per variant to fill its comparison table; the hub was
 *      told not to repeat that, so the fetch must happen exactly once.
 *
 * Asserted against the real files, with comments and strings stripped first
 * where a pattern would otherwise match this file's own prose.
 */

const THEME = join(process.cwd(), "..", "theme");
const SECTION = readFileSync(join(THEME, "sections", "group-buy-hub.liquid"), "utf8");
const SCRIPT = readFileSync(join(THEME, "assets", "group-buy-hub.js"), "utf8");
const CSS = readFileSync(join(THEME, "assets", "component-group-buy.css"), "utf8");
const TEMPLATE = readFileSync(join(THEME, "templates", "page.group-buy.json"), "utf8");

/** JS with block comments, line comments and string literals blanked out. */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const CODE = codeOnly(SCRIPT);

describe("the comment stripper the assertions rely on", () => {
  it("removes comments and string contents but keeps code", () => {
    expect(codeOnly("var a = 1; /* x/100 */")).not.toContain("/100");
    expect(codeOnly("var a = 1; // x/100")).not.toContain("/100");
    expect(codeOnly('var a = "x/100";')).not.toContain("/100");
    expect(codeOnly("var before = 1; /* c */ var after = 2;")).toContain("var after = 2");
  });

  it("actually stripped this file's own header", () => {
    expect(SCRIPT).toContain("ONE REQUEST FOR THE WHOLE PAGE");
    expect(CODE).not.toContain("ONE REQUEST FOR THE WHOLE PAGE");
  });
});

describe("the hub carries no campaign content in Theme Editor", () => {
  const schema = SECTION.slice(SECTION.indexOf("{% schema %}"));

  it.each([
    "campaign_code",
    "campaign_options_json",
    "variant_mapping",
    "hero_image",
    "gallery",
  ])("has no %s setting", (setting) => {
    expect(schema).not.toContain(`"id": "${setting}"`);
  });

  it("has no product picker, so campaign membership cannot be hand-maintained", () => {
    expect(schema).not.toContain('"type": "product"');
    expect(schema).not.toContain('"type": "collection"');
  });

  it("keeps only genuine theme presentation settings", () => {
    const ids = [...schema.matchAll(/"id":\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(ids.sort()).toEqual(
      ["color_scheme", "heading", "heading_size", "intro", "padding_bottom", "padding_top"].sort()
    );
  });

  it("tells the merchant the list maintains itself", () => {
    expect(SECTION).toMatch(/listed automatically/i);
  });

  it("is mounted on a page template that needs no per-campaign entry", () => {
    const parsed = JSON.parse(TEMPLATE) as { sections: Record<string, { type: string }> };
    expect(Object.values(parsed.sections).map((s) => s.type)).toContain("group-buy-hub");
    expect(TEMPLATE).not.toContain("campaign_code");
  });
});

describe("no price arithmetic reaches the browser", () => {
  it("never divides by 100", () => {
    expect(CODE).not.toMatch(/\/\s*100\b/);
  });

  it("uses no float-producing numeric conversion on a money value", () => {
    expect(CODE).not.toMatch(/parseFloat\s*\(/);
    expect(CODE).not.toMatch(/Number\s*\(\s*\w*[Mm]inorUnits/);
    expect(CODE).not.toMatch(/toFixed\s*\(/);
  });

  it("never multiplies by a tier rate or discount", () => {
    // Deriving a price in the browser is the specific failure: the page must
    // display the server's figure, not its own.
    expect(CODE).not.toMatch(/multiplier/i);
    expect(CODE).not.toMatch(/discount\s*\*/);
    expect(CODE).not.toMatch(/\*\s*(?:rate|tier|price)/i);
  });

  it("formats money by splitting digits, not by dividing", () => {
    expect(CODE).toMatch(/slice\(0, -2\)/);
    expect(CODE).toMatch(/slice\(-2\)/);
  });

  it("renders no price in Liquid either", () => {
    expect(SECTION).not.toMatch(/\|\s*money/);
    expect(SECTION).not.toMatch(/divided_by/);
    expect(SECTION).not.toMatch(/times:/);
  });
});

describe("one request, not one per campaign or variant", () => {
  it("calls fetch exactly once", () => {
    const calls = CODE.match(/\bfetch\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("asks the hub endpoint, not the per-campaign progress endpoint", () => {
    expect(SECTION).toContain("apps/carat/group-buy-campaigns");
    // The per-variant endpoint belongs to the detail page.
    expect(SCRIPT).not.toContain("/apps/carat/group-buy/");
  });

  it("does not loop over variants", () => {
    expect(CODE).not.toMatch(/variants\s*\.\s*forEach/);
    expect(CODE).not.toMatch(/priceCellsByVariantId/);
  });
});

describe("cards render from Admin Builder data", () => {
  it("uses the card image and preserves its Shopify alt text", () => {
    expect(CODE).toMatch(/campaign\.cardImage/);
    expect(CODE).toMatch(/cardImage\.altText/);
  });

  it("serves responsive images from the Shopify CDN and lazy-loads them", () => {
    // Attribute names are string literals, so these are asserted against the
    // RAW source — the stripper blanks string contents by design, which is
    // what makes the arithmetic assertions above trustworthy.
    expect(SCRIPT).toContain("srcset");
    expect(SCRIPT).toContain("sizes");
    expect(SCRIPT).toContain("cdn.shopify.com");
    expect(SCRIPT).toContain("width=");
    expect(SECTION).toContain('loading="lazy"');
  });

  it("links to the campaign's own shareable URL", () => {
    expect(SCRIPT).toContain("?campaign=");
    // The escaping is code rather than content, so it is asserted stripped.
    expect(CODE).toMatch(/encodeURIComponent\(campaign\.code\)/);
  });

  it("shows From, progress and countdown but no tier table", () => {
    expect(SCRIPT).toContain("From ");
    expect(CODE).toMatch(/progressLine/);
    expect(CODE).toMatch(/formatRemaining/);
    // The full tier detail belongs on the detail page.
    expect(CODE).not.toMatch(/tierMarkers/);
  });

  it("omits the price rather than inventing one when the server sent none", () => {
    expect(CODE).toMatch(/fromRegularCardPriceMinorUnits/);
    expect(CODE).toMatch(/price\.remove\(\)/);
  });
});

describe("honest states", () => {
  it("renders an intentional empty state rather than a blank grid", () => {
    expect(SECTION).toContain("data-carat-gb-empty-template");
    expect(SECTION).toMatch(/group_buy_hub\.empty_title/);
    // And routes onward, as required.
    expect(SECTION).toContain("past-group-buys");
    expect(SECTION).toContain("custom-jewelry");
  });

  it("never leaves a permanent loading state", () => {
    expect(CODE).toMatch(/catch\s*\(/);
    expect(SCRIPT).toMatch(/could not be loaded/i);
  });
});

describe("mobile-first CSS", () => {
  it("states one card per row as the BASE rule, not inside a media query", () => {
    const base = CSS.slice(0, CSS.indexOf("@media screen and (min-width: 750px)"));
    expect(base).toMatch(/\.gb-hub__grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  it("enhances upward with min-width only, never max-width for layout", () => {
    const layoutQueries = [...CSS.matchAll(/@media screen and \(([^)]+)\)/g)].map((m) => m[1]!);
    const maxWidth = layoutQueries.filter((q) => q.includes("max-width"));
    // One narrow-phone padding tweak at 374px is allowed; it adjusts spacing
    // for 320px rather than re-laying out the page.
    expect(maxWidth.every((q) => q.includes("374px"))).toBe(true);
  });

  it("goes to 2 columns at tablet and 3 at desktop", () => {
    expect(CSS).toMatch(/min-width: 750px[\s\S]*?grid-template-columns: repeat\(2, 1fr\)/);
    expect(CSS).toMatch(/min-width: 990px[\s\S]*?grid-template-columns: repeat\(3, 1fr\)/);
  });

  it("never lets the page scroll sideways", () => {
    // The container is bounded by the viewport rather than a fixed width.
    expect(CSS).toMatch(/width:\s*min\(100%/);
    expect(CSS).not.toMatch(/\.gb\s*\{[^}]*min-width:\s*\d/s);
  });

  it("gives touch targets real size and does not depend on hover", () => {
    expect(CSS).toMatch(/min-height:\s*4\.4rem/);
    // Selection state is border/weight, not a hover colour.
    expect(CSS).toMatch(/\[aria-pressed="true"\]/);
  });

  it("respects reduced motion and the iOS safe area", () => {
    expect(CSS).toContain("prefers-reduced-motion");
    expect(CSS).toContain("env(safe-area-inset-bottom");
  });
});
