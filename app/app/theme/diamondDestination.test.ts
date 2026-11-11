import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * /pages/diamonds — THE DESTINATION, BEFORE A PROVIDER EXISTS.
 *
 * ===========================================================================
 * THE NARROW PATH THIS PINS
 * ===========================================================================
 * The page has to be a real shopping destination while there is no inventory
 * behind it, and the two ways that goes wrong are opposites:
 *
 *   too little — a blank app block or a technical error where the feed will
 *                be, which reads to a customer as a broken store;
 *   too much   — mock diamonds, prices, or filters that look operational,
 *                which is a customer being shown stock that does not exist.
 *
 * Everything below pins the path between those, plus the seam that lets a
 * provider take over the feed area without the rest of the page being
 * rebuilt. `diamondSurface.test.ts` is the sibling file and covers the
 * homepage entry point and the provider-neutral URL contract.
 */

const THEME = join(process.cwd(), "..", "theme");
const PAGE_TEMPLATE = readFileSync(join(THEME, "templates", "page.diamonds.json"), "utf8");

const DIAMOND_SECTIONS = [
  "carat-diamond-hero",
  "carat-diamond-feed",
  "carat-diamond-shapes",
  "carat-diamond-pillars",
  "carat-diamond-next",
] as const;

type SectionName = (typeof DIAMOND_SECTIONS)[number];

const SOURCES = Object.fromEntries(
  DIAMOND_SECTIONS.map((name) => [name, readFileSync(join(THEME, "sections", `${name}.liquid`), "utf8")])
) as Record<SectionName, string>;

const SHAPE_ICON = readFileSync(join(THEME, "snippets", "carat-diamond-shape-icon.liquid"), "utf8");
const DIAMOND_CSS = readFileSync(join(THEME, "assets", "carat-diamonds.css"), "utf8");

/** Suppliers whose names must never reach the permanent page architecture. */
const SUPPLIER_NAMES = ["nivoda", "unbridaled", "uni-diamonds", "rapnet", "idex", "vdb"];

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

/** Comments removed, everything else kept. */
function withoutComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

function schemaOf(source: string): {
  settings?: { id?: string; type: string; default?: unknown }[];
  blocks?: { type: string }[];
} {
  const match = source.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  if (!match) throw new Error("no schema block");
  return JSON.parse(match[1]!);
}

describe("the feed area is the only thing a provider replaces", () => {
  const code = liquidCode(SOURCES["carat-diamond-feed"]);

  it("accepts app blocks, which is what a provider installs", () => {
    expect(schemaOf(SOURCES["carat-diamond-feed"]).blocks).toEqual([{ type: "@app" }]);
  });

  it("branches on whether a block is present, so Coming Soon clears itself", () => {
    // THE SEAM. If this branch is ever flattened, connecting a provider
    // leaves the Coming Soon panel stacked above a live product grid — and
    // nobody notices until a customer sees both.
    expect(code).toMatch(/\{%-?\s*if\s+section\.blocks\.size\s*>\s*0\s*-?%\}/);
    expect(code).toMatch(/\{%-?\s*for\s+block\s+in\s+section\.blocks\s*-?%\}/);

    const elseAt = code.search(/\{%-?\s*else\s*-?%\}/);
    expect(elseAt).toBeGreaterThan(-1);
    // The Coming Soon copy must sit on the ELSE side of that branch.
    expect(code.indexOf("soon_heading")).toBeGreaterThan(elseAt);
  });

  it("keeps the control preview on the Coming Soon side, never beside a live feed", () => {
    // Two filter bars — one real, one decorative — is the worst available
    // outcome here, so the rail must not be reachable from the live branch.
    const elseAt = code.search(/\{%-?\s*else\s*-?%\}/);
    expect(code.indexOf("cd-rail")).toBeGreaterThan(elseAt);
  });

  it("is the whole provider surface — no other section hosts app blocks", () => {
    // Otherwise "replace the feed area" silently becomes "replace several
    // areas", and the promise that the rest of the page survives is false.
    for (const name of DIAMOND_SECTIONS) {
      if (name === "carat-diamond-feed") continue;
      expect(schemaOf(SOURCES[name]).blocks ?? [], `${name} must not host app blocks`).not.toContainEqual({
        type: "@app",
      });
    }
  });

  it("leaves the surrounding page owned by us", () => {
    const template = parseTemplate(PAGE_TEMPLATE);
    const feedKeys = template.order.filter((k) => template.sections[k]!.type === "carat-diamond-feed");
    expect(feedKeys).toEqual(["feed"]);
    // Five of the six sections survive a provider switch untouched.
    expect(template.order.length - feedKeys.length).toBe(5);
  });
});

describe("nothing on the page pretends to be inventory", () => {
  it("the control rail is inert and hidden from assistive technology", () => {
    // The brief: placeholder filters must not appear operational. `inert`
    // removes pointer events AND tab stops; aria-hidden stops a screen
    // reader narrating eight controls that do nothing.
    expect(liquidCode(SOURCES["carat-diamond-feed"])).toMatch(
      /class="cd-rail"\s+inert\s+aria-hidden="true"/
    );
  });

  it("says plainly that live inventory is not connected", () => {
    const settings = parseTemplate(PAGE_TEMPLATE).sections.feed!.settings!;
    expect(String(settings.preview_label).toLowerCase()).toContain("not connected");
    expect(settings.soon_heading).toBe("Diamond Marketplace Coming Soon");
  });

  it("has no price, cart or product markup in any diamond section", () => {
    // A mock price is the most damaging thing that could appear here: it is
    // indistinguishable from a real one, and it is a number a customer would
    // hold us to.
    for (const name of DIAMOND_SECTIONS) {
      const code = liquidCode(SOURCES[name]);
      expect(code, `${name} must not price anything`).not.toMatch(/\$\d|\bmoney\b/i);
      expect(code, `${name} must not add to cart`).not.toMatch(/cart\/add|product-form/i);
      expect(code, `${name} must not render products`).not.toMatch(/all_products|collections\[|product\.variants/);
    }
  });

  it("invents no inventory counts", () => {
    // "Round (1,284)" would be stock we do not have, and a count that is
    // wrong the day a feed connects is worse than no count at all.
    expect(liquidCode(SOURCES["carat-diamond-shapes"])).not.toMatch(/\bcount\b|\bavailable\b|in stock/i);
  });

  it("offers no purchase path before a provider exists", () => {
    // Both next-step options need a selected diamond and a connected
    // provider. Rendering them as <div> rather than a disabled <a> means
    // they promise nothing to a keyboard or a screen reader.
    const next = liquidCode(SOURCES["carat-diamond-next"]);
    expect(next).toContain('<div class="cd-next__option"');
    expect(next).not.toMatch(/<a[^>]*cd-next__option/);
    expect(next).not.toMatch(/<button/);
  });

  it("reflects a requested category without claiming to filter", () => {
    // ?type= marks and labels. An unrecognised value must be IGNORED rather
    // than defaulted, so a stale or hand-edited link cannot show the wrong
    // category with confidence.
    const hero = liquidCode(SOURCES["carat-diamond-hero"]);
    expect(hero).toContain("hasOwnProperty.call(CATEGORIES");
    expect(hero).toContain("hasOwnProperty.call(SHAPES");
  });
});

describe("the Coming Soon call to action reuses the existing signup", () => {
  it("points at First Access rather than a second subscriber system", () => {
    // First Access already captures a Loose Diamonds interest, so a new form
    // here would split one audience across two lists.
    expect(parseTemplate(PAGE_TEMPLATE).sections.feed!.settings!.soon_cta_link).toBe("/pages/first-access");
    expect(existsSync(join(THEME, "templates", "page.first-access-v2.liquid"))).toBe(true);
  });

  it("collects nothing itself", () => {
    expect(liquidCode(SOURCES["carat-diamond-feed"])).not.toMatch(/<form|customer\[email\]|type="email"/i);
  });
});

describe("the page's heading structure", () => {
  it("has exactly one h1, in the hero", () => {
    for (const name of DIAMOND_SECTIONS) {
      const h1s = (liquidCode(SOURCES[name]).match(/<h1[\s>]/g) ?? []).length;
      expect(h1s, name).toBe(name === "carat-diamond-hero" ? 1 : 0);
    }
  });

  it("gives every other section an h2", () => {
    for (const name of DIAMOND_SECTIONS) {
      if (name === "carat-diamond-hero") continue;
      expect(liquidCode(SOURCES[name]), name).toMatch(/<h2[\s>]/);
    }
  });
});

describe("the shape outlines", () => {
  const SHAPES = [
    "round",
    "oval",
    "emerald",
    "radiant",
    "cushion",
    "pear",
    "marquise",
    "princess",
    "asscher",
    "heart",
  ];

  function pathOf(shape: string): string {
    const at = SHAPE_ICON.indexOf("when '" + shape + "'");
    if (at === -1) throw new Error("no branch for " + shape);
    const found = SHAPE_ICON.slice(at).match(/\sd="([^"]+)"/);
    if (!found) throw new Error("no path for " + shape);
    return found[1]!;
  }

  function runs(path: string): { h: number; v: number } {
    const horizontal = path.match(/h-?\d+/g) ?? ["h0"];
    const vertical = path.match(/v-?\d+/g) ?? ["v0"];
    return {
      h: Math.max(...horizontal.map((v) => Math.abs(Number(v.slice(1))))),
      v: Math.max(...vertical.map((v) => Math.abs(Number(v.slice(1))))),
    };
  }

  it("draws all ten shapes the brief names", () => {
    for (const shape of SHAPES) {
      expect(SHAPE_ICON, shape + " is missing").toContain("when '" + shape + "'");
    }
    expect(liquidCode(SOURCES["carat-diamond-shapes"])).toContain(SHAPES.join(","));
  });

  it("renders nothing for an unknown shape rather than a wrong stone", () => {
    // No `else` in the case statement: a typo shows as an absence, which is
    // visible, instead of silently drawing something that is not that shape.
    expect(liquidCode(SHAPE_ICON)).not.toMatch(/\{%-?\s*else\s*-?%\}/);
  });

  it("keeps the three cut-corner shapes visually distinct", () => {
    // THE REGRESSION THIS EXISTS FOR. Emerald, radiant and asscher are all
    // cut-corner silhouettes, and the first version drew them at near
    // identical sizes — on the rendered page they were three
    // indistinguishable octagons, which makes a shape picker worse than no
    // shape picker. The trade separates them by aspect ratio, so these must.
    const emerald = pathOf("emerald");
    const radiant = pathOf("radiant");
    const asscher = pathOf("asscher");
    expect(new Set([emerald, radiant, asscher]).size).toBe(3);

    const e = runs(emerald);
    expect(e.v, "emerald must read as elongated").toBeGreaterThan(e.h * 2);

    const a = runs(asscher);
    expect(a.v, "asscher must read as square").toBe(a.h);

    const r = runs(radiant);
    expect(r.h, "radiant must be broader than emerald").toBeGreaterThan(e.h);
  });

  it("carries no facet detail that would be a claim about the cut", () => {
    // At 44px facets turn to mud, and a wrong facet pattern on an Asscher
    // asserts something about a stone we are not selling.
    expect(SHAPE_ICON).not.toContain("<line");
    expect(SHAPE_ICON).not.toContain('fill="#');
  });
});

describe("the destination stays provider-neutral and self-contained", () => {
  it("ships no supplier name to the browser", () => {
    // COMMENTS STRIPPED, and the first version of this test did not do that
    // — it failed on carat-diamond-feed.liquid's own header paragraph, which
    // says "connecting Nivoda, UNI or anyone else is one action in the theme
    // editor". That sentence is the documentation of the seam, not branding
    // on the page, and a test that forbids naming the thing being designed
    // for would make the architecture harder to explain than to build.
    //
    // What the brief actually forbids is hardcoded provider branding in the
    // permanent page. That is a question about rendered output, so this
    // checks rendered output.
    const files: [string, string][] = [
      ...DIAMOND_SECTIONS.map((n) => [n, withoutComments(SOURCES[n])] as [string, string]),
      ["shape-icon snippet", withoutComments(SHAPE_ICON)],
      ["carat-diamonds.css", DIAMOND_CSS.replace(/\/\*[\s\S]*?\*\//g, "")],
    ];
    for (const [label, source] of files) {
      for (const supplier of SUPPLIER_NAMES) {
        expect(source.toLowerCase(), label + " ships " + supplier).not.toContain(supplier);
      }
    }
  });

  it("names no supplier anywhere in the page template, comments included", () => {
    // The template is pure configuration — every string in it is either a
    // section type, a setting key or customer-facing copy, so there is no
    // documentation here that could legitimately name a provider. This one
    // stays strict.
    for (const supplier of SUPPLIER_NAMES) {
      expect(PAGE_TEMPLATE.toLowerCase(), "page.diamonds.json names " + supplier).not.toContain(supplier);
    }
  });

  it("renders the sections the brief asked for, in order", () => {
    const template = parseTemplate(PAGE_TEMPLATE);
    expect(template.order).toEqual(["hero", "feed", "shapes", "value", "education", "next"]);
    for (const key of template.order) {
      const type = template.sections[key]!.type;
      expect(existsSync(join(THEME, "sections", type + ".liquid")), type + " is missing").toBe(true);
    }
  });

  it("styles the page from its own stylesheet, not the shared one", () => {
    // carat-editorial.css is shared by five other section families and has
    // already drifted from this repo on the store, so an additive page must
    // not need to overwrite it.
    for (const name of DIAMOND_SECTIONS) {
      const live = withoutComments(SOURCES[name]);
      expect(live, name).toContain("carat-diamonds.css");
      expect(live, name + " must not load the shared editorial stylesheet").not.toContain("carat-editorial.css");
    }
  });

  it("uses one section for both four-up bands rather than two near-copies", () => {
    const template = parseTemplate(PAGE_TEMPLATE);
    expect(template.sections.value!.type).toBe("carat-diamond-pillars");
    expect(template.sections.education!.type).toBe("carat-diamond-pillars");
    // The only difference is the mark, which is a setting.
    expect(template.sections.value!.settings!.show_marks).toBe(false);
    expect(template.sections.education!.settings!.show_marks).toBe(true);
  });
});
