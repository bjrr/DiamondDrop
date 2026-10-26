import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";

/**
 * F2 (2026-10-25, owner-approved): FAQ CATEGORY ORDER.
 *
 * In production, `sections/faq.liquid` ordered categories by first
 * appearance in `shop.metaobjects.faq_entry.values`, which Shopify returns
 * in an unspecified order. The page rendered Returns & Cancellations first
 * and Group Buys third.
 *
 * The fix fixes the ORDER and nothing else. These tests render the REAL
 * section and snippets with liquidjs, because a source scan can prove a list
 * is written but not that it orders without filtering. They pin three things:
 *   1. approved categories render in the approved order, whatever order the
 *      entries arrive in;
 *   2. a category outside the approved list still renders, after them;
 *   3. uncategorised entries still render, last, under the configured heading.
 * They also pin that each entry renders exactly once and that `sort_key`
 * still orders questions within a category.
 *
 * Shopify-only tags (`style`, `schema`) are stripped before parsing; liquidjs
 * has no equivalent and they do not affect ordering. Unknown filters
 * (`asset_url`, `metafield_tag`, `inline_asset_content`) pass their input
 * through unchanged, which is liquidjs's documented default.
 */

const THEME = join(process.cwd(), "..", "theme");

const APPROVED_ORDER = [
  "Group Buys",
  "Pricing & Refunds",
  "Production & Delivery",
  "Materials & Stones",
  "Ring Sizing",
  "Custom Jewelry",
  "Warranty & Repairs",
  "Returns & Cancellations",
  "Payments",
  "Shipping & Insurance",
  "Contacting us",
] as const;

const UNCATEGORISED_HEADING = "Other questions";

function sectionSource(): string {
  return readFileSync(join(THEME, "sections", "faq.liquid"), "utf8")
    .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, "")
    .replace(/\{%-?\s*style\s*-?%\}[\s\S]*?\{%-?\s*endstyle\s*-?%\}/g, "");
}

interface Entry {
  question: string;
  answer: string;
  category?: string;
  sort_key?: number;
}

async function renderFaq(entries: Entry[]): Promise<string> {
  const engine = new Liquid({ root: [join(THEME, "snippets")], extname: ".liquid" });
  return engine.parseAndRender(sectionSource(), {
    shop: { metaobjects: { faq_entry: { values: entries } } },
    section: {
      id: "faq-test",
      settings: {
        heading: "Frequently asked questions",
        heading_size: "h1",
        intro: "",
        uncategorised_heading: UNCATEGORISED_HEADING,
        color_scheme: "scheme-1",
        padding_top: 36,
        padding_bottom: 36,
      },
    },
  });
}

/** Category headings in render order, HTML-unescaped. */
function headingsInOrder(html: string): string[] {
  return [...html.matchAll(/<h2 class="carat-faq__heading[^"]*">([^<]*)<\/h2>/g)].map((m) =>
    m[1]!.replace(/&amp;/g, "&").trim()
  );
}

function entry(category: string | undefined, n: number, sort_key?: number): Entry {
  const label = category ?? "none";
  return {
    question: `Q ${label} #${n}?`,
    answer: `A ${label} #${n}`,
    ...(category === undefined ? {} : { category }),
    ...(sort_key === undefined ? {} : { sort_key }),
  };
}

// The production order observed on 2026-10-25, deliberately NOT approved order.
const PRODUCTION_OBSERVED_ORDER = [
  "Returns & Cancellations",
  "Materials & Stones",
  "Group Buys",
  "Shipping & Insurance",
  "Custom Jewelry",
  "Ring Sizing",
  "Payments",
  "Pricing & Refunds",
  "Contacting us",
  "Production & Delivery",
  "Warranty & Repairs",
];

describe("FAQ category order (F2)", () => {
  it("guards the guard: the scrambled fixture really is out of approved order", () => {
    expect(PRODUCTION_OBSERVED_ORDER).not.toEqual([...APPROVED_ORDER]);
    expect([...PRODUCTION_OBSERVED_ORDER].sort()).toEqual([...APPROVED_ORDER].sort());
  });

  it("renders the approved categories in the approved order, whatever order entries arrive in", async () => {
    const entries = PRODUCTION_OBSERVED_ORDER.map((c, i) => entry(c, i + 1, 1));
    const html = await renderFaq(entries);
    expect(headingsInOrder(html)).toEqual([...APPROVED_ORDER]);
  });

  it("still renders a category outside the approved list, after the approved ones", async () => {
    const entries = [entry("Gift Cards", 1, 1), entry("Payments", 2, 1), entry("Group Buys", 3, 1)];
    const html = await renderFaq(entries);
    expect(headingsInOrder(html)).toEqual(["Group Buys", "Payments", "Gift Cards"]);
    expect(html).toContain("Q Gift Cards #1?");
  });

  it("still renders uncategorised entries, last, under the configured heading", async () => {
    const entries = [entry(undefined, 1), entry("Gift Cards", 2, 1), entry("Ring Sizing", 3, 1)];
    const html = await renderFaq(entries);
    expect(headingsInOrder(html)).toEqual(["Ring Sizing", "Gift Cards", UNCATEGORISED_HEADING]);
    expect(html).toContain("Q none #1?");
  });

  it("renders every entry exactly once — an approved category is not repeated in the unknown pass", async () => {
    const entries = [
      ...PRODUCTION_OBSERVED_ORDER.map((c, i) => entry(c, i + 1, 1)),
      entry("Gift Cards", 50, 1),
      entry(undefined, 51),
    ];
    const html = await renderFaq(entries);
    for (const e of entries) {
      expect(html.split(e.question).length - 1, e.question).toBe(1);
    }
  });

  it("keeps sort_key ordering inside a category", async () => {
    const entries = [entry("Group Buys", 3, 3), entry("Group Buys", 1, 1), entry("Group Buys", 2, 2)];
    const html = await renderFaq(entries);
    const positions = [1, 2, 3].map((n) => html.indexOf(`Q Group Buys #${n}?`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("renders nothing at all with no entries", async () => {
    const html = await renderFaq([]);
    expect(headingsInOrder(html)).toEqual([]);
    expect(html).not.toContain("Frequently asked questions");
  });
});
