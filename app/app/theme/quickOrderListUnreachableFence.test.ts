import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression fence for the owner decision recorded in the 2B-2 handoff:
 * quick-order-list (Dawn's bulk-ordering feature) is OUT OF MVP1 and must
 * not be activatable in the CaratForUs theme without a future explicit
 * decision. The upstream files are deliberately NOT deleted (kept for
 * baseline provenance against the vendored Dawn commit) — this fence
 * enforces that they stay inert instead.
 *
 * THREE INDEPENDENT PATHS were found that could make the feature reachable,
 * and this fence checks all three so that closing one silently does not
 * create false confidence about the others:
 *
 *  1. A template JSON could list `quick-order-list` or `bulk-quick-order-list`
 *     as a section `type` directly.
 *  2. `sections/quick-order-list.liquid` / `sections/bulk-quick-order-list.liquid`
 *     could carry a `presets` block, which is what lets a merchant add the
 *     section from the theme editor's "Add section" picker — enabled_on
 *     alone does not prevent this, presets is the actual gate.
 *  3. LESS OBVIOUS: `sections/main-collection-product-grid.liquid` and
 *     `sections/featured-collection.liquid` each expose a `quick_add` select
 *     setting with a "bulk" option. Choosing it requires no code change and
 *     no preset — `snippets/card-product.liquid`'s `quick_add == 'bulk'`
 *     branch renders a `<bulk-modal>` element whose `connectedCallback` in
 *     `assets/global.js` (~line 658) fetches
 *     `${productUrl}?section_id=bulk-quick-order-list` directly through the
 *     Section Rendering API — a path presets/enabled_on do not gate at all.
 *     Both templates currently pin `"quick_add": "none"`, but that is a
 *     content/editor setting, not a code guard: a merchant could switch it
 *     to "Bulk" with no developer involved, in violation of "not activatable
 *     without a future explicit decision". Path 3 was closed by removing the
 *     "bulk" option from both schemas rather than relying on the current
 *     "none" default holding.
 *
 * DELIBERATELY LEFT ALONE — verified to be translation-key reuse, not the
 * feature: `sections.quick_order_list.each` (volume-pricing "$X each"
 * string used by card-product.liquid, main-product.liquid,
 * main-cart-items.liquid, featured-product.liquid) and
 * `window.quickOrderListStrings` in layout/theme.liquid, whose min_error /
 * max_error / step_error entries are read by assets/cart.js and
 * assets/global.js's generic <quantity-input> component — i.e. ANY quantity
 * input on the site, not just a bulk order list — and whose itemAdded(s) /
 * itemRemoved(s) / viewCart entries are read only inside
 * assets/quick-order-list.js itself, which cannot run without a
 * <quick-order-list> element, which this fence proves cannot appear. Do not
 * "clean up" these translation keys; doing so breaks ordinary volume pricing
 * display and quantity-input validation messages.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const TEMPLATES_DIR = join(THEME_ROOT, "templates");
const SECTIONS_DIR = join(THEME_ROOT, "sections");

const GUARDED_SECTION_TYPES = ["quick-order-list", "bulk-quick-order-list"] as const;

function readSchema(absoluteLiquidPath: string): Record<string, unknown> | null {
  const source = readFileSync(absoluteLiquidPath, "utf8");
  const match = source.match(/{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/);
  if (!match) return null;
  return JSON.parse(match[1]!);
}

function templateJsonFiles(): string[] {
  return readdirSync(TEMPLATES_DIR).filter((name) => name.endsWith(".json"));
}

function sectionLiquidFiles(): string[] {
  return readdirSync(SECTIONS_DIR).filter((name) => name.endsWith(".liquid"));
}

/** Every section `type` value referenced anywhere in a template JSON's `sections` map. */
function sectionTypesReferencedIn(templateJson: Record<string, unknown>): string[] {
  const sections = templateJson.sections;
  if (!sections || typeof sections !== "object") return [];
  return Object.values(sections as Record<string, unknown>)
    .filter((s): s is { type?: unknown } => typeof s === "object" && s !== null)
    .map((s) => s.type)
    .filter((t): t is string => typeof t === "string");
}

/** Every `quick_add` select setting's option values, from a section schema (empty if none). */
function quickAddOptionValues(schema: Record<string, unknown>): string[] {
  const settings = schema.settings;
  if (!Array.isArray(settings)) return [];
  const quickAdd = settings.find((s) => s && typeof s === "object" && (s as { id?: unknown }).id === "quick_add");
  if (!quickAdd || typeof quickAdd !== "object") return [];
  const options = (quickAdd as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options
    .filter((o): o is { value?: unknown } => typeof o === "object" && o !== null)
    .map((o) => o.value)
    .filter((v): v is string => typeof v === "string");
}

describe("quick-order-list stays unreachable — no template, no preset, no editor-settable path", () => {
  it("GUARDS THE GUARD: found template JSON files and section .liquid files to check", () => {
    expect(templateJsonFiles().length).toBeGreaterThanOrEqual(10);
    expect(sectionLiquidFiles().length).toBeGreaterThanOrEqual(40);
  });

  it("GUARDS THE GUARD: the two guarded section files still exist and still parse as schema-bearing sections", () => {
    for (const type of GUARDED_SECTION_TYPES) {
      const schema = readSchema(join(SECTIONS_DIR, `${type}.liquid`));
      expect(schema, `sections/${type}.liquid has no {% schema %} block — was it restructured?`).not.toBeNull();
    }
  });

  it.each(templateJsonFiles())("templates/%s does not reference quick-order-list or bulk-quick-order-list", (name) => {
    const templateJson = JSON.parse(readFileSync(join(TEMPLATES_DIR, name), "utf8"));
    const referenced = sectionTypesReferencedIn(templateJson).filter((type) =>
      (GUARDED_SECTION_TYPES as readonly string[]).includes(type)
    );

    expect(
      referenced,
      `templates/${name} references ${referenced.join(", ")} directly. This is out of MVP1 per owner decision — ` +
        "remove the section entry from the template, or get explicit owner sign-off and update this fence " +
        "deliberately rather than letting it slide through."
    ).toEqual([]);
  });

  it.each(GUARDED_SECTION_TYPES)("sections/%s.liquid has no presets block", (type) => {
    const schema = readSchema(join(SECTIONS_DIR, `${type}.liquid`))!;

    expect(
      "presets" in schema,
      `sections/${type}.liquid has a "presets" block. That is what lets a merchant add this section ` +
        "from the theme editor's Add Section picker with no code change at all — the actual activation " +
        "risk, per the owner decision that quick-order-list is out of MVP1. enabled_on alone does not " +
        "prevent this."
    ).toBe(false);
  });

  it.each(["main-collection-product-grid", "featured-collection"] as const)(
    "sections/%s.liquid's quick_add setting has no editor-selectable 'bulk' option",
    (name) => {
      const schema = readSchema(join(SECTIONS_DIR, `${name}.liquid`))!;
      const values = quickAddOptionValues(schema);

      // Guard the guard within this test: if the quick_add setting itself vanished, `values`
      // would be [] and the assertion below would vacuously pass while covering nothing.
      expect(
        values.length,
        `sections/${name}.liquid no longer defines a "quick_add" select setting (or it lost its options) — ` +
          "either the section was restructured (update this fence to match) or this check is silently " +
          "checking nothing."
      ).toBeGreaterThan(0);

      expect(
        values,
        `sections/${name}.liquid's quick_add setting offers "bulk" as a selectable option. Choosing it in ` +
          "the theme editor requires no code change and no preset: snippets/card-product.liquid's " +
          "quick_add == 'bulk' branch renders a <bulk-modal> element whose connectedCallback " +
          "(assets/global.js) fetches ?section_id=bulk-quick-order-list directly through the Section " +
          "Rendering API, bypassing presets/enabled_on entirely. Remove the 'bulk' option, or get explicit " +
          "owner sign-off to re-enable quick-order-list and update this fence deliberately."
      ).not.toContain("bulk");
    }
  );

  it("no other section schema in the theme defines a quick_add option with value 'bulk' either", () => {
    // Broader sweep beyond the two known offenders above, so a THIRD section adding its own
    // quick_add-with-bulk setting in the future is caught immediately rather than only after
    // someone thinks to add it to the it.each list above.
    const offenders: string[] = [];
    for (const file of sectionLiquidFiles()) {
      const schema = readSchema(join(SECTIONS_DIR, file));
      if (!schema) continue;
      if (quickAddOptionValues(schema).includes("bulk")) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

describe("guard the guard — the classifiers actually detect the violations they exist to catch", () => {
  it("flags a template that references quick-order-list as a section type", () => {
    const VIOLATING_TEMPLATE = {
      sections: {
        main: { type: "quick-order-list", settings: {} },
      },
      order: ["main"],
    };
    const referenced = sectionTypesReferencedIn(VIOLATING_TEMPLATE).filter((type) =>
      (GUARDED_SECTION_TYPES as readonly string[]).includes(type)
    );
    expect(referenced).toEqual(["quick-order-list"]);
  });

  it("does not flag a template referencing an unrelated section type", () => {
    const SAFE_TEMPLATE = {
      sections: { main: { type: "main-product", settings: {} } },
      order: ["main"],
    };
    expect(sectionTypesReferencedIn(SAFE_TEMPLATE)).toEqual(["main-product"]);
  });

  it("flags a schema with a presets block", () => {
    const VIOLATING_SCHEMA = { name: "x", presets: [{ name: "Default" }] };
    expect("presets" in VIOLATING_SCHEMA).toBe(true);
  });

  it("flags a quick_add setting offering a 'bulk' option", () => {
    const VIOLATING_SCHEMA = {
      settings: [
        {
          type: "select",
          id: "quick_add",
          options: [{ value: "none" }, { value: "standard" }, { value: "bulk" }],
        },
      ],
    };
    expect(quickAddOptionValues(VIOLATING_SCHEMA)).toContain("bulk");
  });

  it("does not flag a quick_add setting with only none/standard", () => {
    const SAFE_SCHEMA = {
      settings: [
        { type: "select", id: "quick_add", options: [{ value: "none" }, { value: "standard" }] },
      ],
    };
    expect(quickAddOptionValues(SAFE_SCHEMA)).not.toContain("bulk");
  });
});
