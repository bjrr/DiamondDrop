import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION FENCE, found by an actual failed push (Slice 5 task 5-5,
 * 2026-09-25/26) and then investigated empirically rather than guessed at.
 *
 * `shopify theme check` validates `{% schema %}` JSON *structure* (shape,
 * types, cross-references such as setting ids/block types/translation keys
 * existing) but NOT Shopify Admin's own VALUE-level rules on individual
 * settings. `sections/warranty-claim-form.liquid` shipped a
 * `type: "text"` setting with `"default": ""`, which passed a clean local
 * `theme check` run and was then rejected by the live Shopify Admin API on
 * push: `Invalid schema: setting with id="heading" default can't be blank`.
 * The push ALSO reported a second, downstream error — the referencing
 * template said the section "does not refer to an existing section file" —
 * because the whole schema is invalidated as one unit when any setting
 * inside it fails Admin's validation.
 *
 * THE SCOPE OF THIS FENCE IS EXACTLY WHAT WAS VERIFIED, NOT A GUESS WIDENED
 * TO BE SAFE. A follow-up empirical probe (six setting types, two live
 * pushes against a real dev store, artifacts cleaned up afterward) found:
 *   - REJECTED by Admin, invisible to local `theme check`:
 *       - `type: "text"` with `"default": ""`
 *       - `type: "range"` with a `default` outside `min`/`max`
 *   - ACCEPTED by Admin (confirmed NOT part of this rule, despite an
 *     initial hypothesis that blank defaults were unsafe on every
 *     text-like type): `textarea`, `richtext`, and `html` with
 *     `"default": ""`, and `url` with `"default": ""`. A `select` whose
 *     `default` matched none of its declared `options` was also accepted.
 * This fence deliberately does NOT flag `textarea`/`richtext`/`html`/`url`
 * blank defaults or a mismatched `select` default — doing so would flag
 * code that is actually fine, and a check that cries wolf teaches people to
 * ignore it. See the "guard the guard" block below, which asserts the
 * negative for exactly these cases so a future edit cannot silently widen
 * the rule back to the wrong, broader shape.
 *
 * WHAT REMAINS UNVERIFIED, NOT CONFIRMED SAFE. Only six setting types were
 * probed (text, textarea, richtext, html, url, select, range). Other types
 * — checkbox, number, color, color_scheme, font_picker, collection,
 * product, product_list, collection_list, video, image_picker, article,
 * blog, page, url — were never pushed against a live store with an
 * edge-case default and have no rule encoded here either way. If one of
 * those is ever found to have its own Admin-only default-value rule, that
 * is a new, separately-verified addition to this fence, not an assumption
 * that today's silence already covers it.
 *
 * THE FIX, NAMED IN THE FAILURE MESSAGE ITSELF. Omit the `default` key
 * entirely rather than setting it to `""` — Liquid reads an omitted
 * default and an explicit blank one identically (`section.settings.x`
 * resolves to blank either way), so this costs nothing and is exactly what
 * fixed `warranty-claim-form.liquid`.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const SCANNED_DIRS = ["sections", "snippets"] as const;

interface SchemaSetting {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly default?: unknown;
  readonly min?: unknown;
  readonly max?: unknown;
}

interface SchemaViolation {
  readonly settingId: string;
  readonly message: string;
}

/**
 * Pure. The one place the actual rule lives — see this file's header
 * comment for exactly what is and is not covered, and why.
 */
function findSchemaDefaultViolations(settings: readonly SchemaSetting[]): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  for (const setting of settings) {
    const id = typeof setting.id === "string" ? setting.id : "(no id)";

    if (setting.type === "text" && "default" in setting && setting.default === "") {
      violations.push({
        settingId: id,
        message:
          `setting "${id}" is type "text" with "default": "" — Shopify Admin rejects this at push time ` +
          `("default can't be blank"), even though it passes a local theme check. ` +
          `Fix: omit the "default" key entirely rather than setting it to "".`,
      });
    }

    if (
      setting.type === "range" &&
      typeof setting.default === "number" &&
      typeof setting.min === "number" &&
      typeof setting.max === "number" &&
      (setting.default < setting.min || setting.default > setting.max)
    ) {
      violations.push({
        settingId: id,
        message:
          `setting "${id}" is type "range" with a "default" (${setting.default}) outside its ` +
          `"min"/"max" (${setting.min}-${setting.max}) — Shopify Admin rejects this at push time ` +
          `("default must be between the min and max value"), even though it passes a local theme check. ` +
          `Fix: set "default" to a value within min/max.`,
      });
    }
  }

  return violations;
}

/** Every setting a schema object can declare one of these rules against — top-level AND block-level, since both are real setting locations. */
function allSettingsIn(schema: Record<string, unknown>): SchemaSetting[] {
  const settings: SchemaSetting[] = Array.isArray(schema.settings) ? (schema.settings as SchemaSetting[]) : [];
  const blocks = Array.isArray(schema.blocks) ? schema.blocks : [];
  const blockSettings = blocks.flatMap((block) =>
    block && typeof block === "object" && Array.isArray((block as { settings?: unknown }).settings)
      ? ((block as { settings: SchemaSetting[] }).settings)
      : []
  );
  return [...settings, ...blockSettings];
}

const SCHEMA_TAG_PATTERN = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;

/** Returns the parsed `{% schema %}` object for a `.liquid` source, or `null` if the file has none. Throws if a schema tag exists but is not valid JSON — that is `theme check`'s ValidSchema/JSONSyntaxError's job to catch, not silently swallowed here. */
function extractSchema(source: string): Record<string, unknown> | null {
  const match = SCHEMA_TAG_PATTERN.exec(source);
  const captured = match?.[1];
  if (captured === undefined) return null;
  return JSON.parse(captured) as Record<string, unknown>;
}

function liquidFilesIn(dir: string): string[] {
  const base = join(THEME_ROOT, dir);
  return readdirSync(base)
    .filter((name) => name.endsWith(".liquid"))
    .map((name) => join(base, name));
}

describe("schema setting defaults Shopify Admin rejects at push, invisible to theme check", () => {
  it("guards the guard: found at least one real section with a schema, so the walk below is exercising something", () => {
    const withSchema = SCANNED_DIRS.flatMap((dir) => liquidFilesIn(dir)).filter((file) =>
      SCHEMA_TAG_PATTERN.test(readFileSync(file, "utf8"))
    );
    expect(withSchema.length).toBeGreaterThan(0);
  });

  it.each(SCANNED_DIRS)("every schema under theme/%s has no text-blank-default or range-out-of-bounds default", (dir) => {
    const offenders: string[] = [];

    for (const file of liquidFilesIn(dir)) {
      const schema = extractSchema(readFileSync(file, "utf8"));
      if (!schema) continue;

      const violations = findSchemaDefaultViolations(allSettingsIn(schema));
      for (const violation of violations) {
        offenders.push(`${file.split(/[\\/]/).pop()}: ${violation.message}`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("guard the guard — the detector fires on exactly the two verified rules and nothing else", () => {
  it("flags a text setting with an explicit blank default", () => {
    const violations = findSchemaDefaultViolations([{ type: "text", id: "heading", default: "" }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.settingId).toBe("heading");
    expect(violations[0]!.message).toContain('omit the "default" key');
  });

  it("does NOT flag a text setting with the default key omitted entirely", () => {
    expect(findSchemaDefaultViolations([{ type: "text", id: "heading" }])).toEqual([]);
  });

  it("does NOT flag a text setting with a non-empty default", () => {
    expect(findSchemaDefaultViolations([{ type: "text", id: "heading", default: "Warranty Claim" }])).toEqual([]);
  });

  it("flags a range default below its min", () => {
    const violations = findSchemaDefaultViolations([{ type: "range", id: "padding_top", min: 10, max: 20, default: 5 }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain("min");
  });

  it("flags a range default above its max", () => {
    const violations = findSchemaDefaultViolations([{ type: "range", id: "padding_top", min: 10, max: 20, default: 999 }]);
    expect(violations).toHaveLength(1);
  });

  it("does NOT flag a range default within min/max", () => {
    expect(
      findSchemaDefaultViolations([{ type: "range", id: "padding_top", min: 10, max: 20, default: 15 }])
    ).toEqual([]);
  });

  it("does NOT flag a range with no default at all", () => {
    expect(findSchemaDefaultViolations([{ type: "range", id: "padding_top", min: 10, max: 20 }])).toEqual([]);
  });

  it.each(["textarea", "richtext", "html", "url"])(
    "does NOT flag a %s setting with a blank default — confirmed accepted by Admin, out of scope for this rule",
    (type) => {
      expect(findSchemaDefaultViolations([{ type, id: "body", default: "" }])).toEqual([]);
    }
  );

  it("does NOT flag a select default that matches none of its options — confirmed accepted by Admin", () => {
    expect(
      findSchemaDefaultViolations([
        { type: "select", id: "mode", default: "not_a_real_option" } as SchemaSetting,
      ])
    ).toEqual([]);
  });

  it("finds violations inside block-level settings, not just top-level settings", () => {
    const schema = {
      settings: [],
      blocks: [{ type: "text_block", settings: [{ type: "text", id: "block_heading", default: "" }] }],
    };
    expect(findSchemaDefaultViolations(allSettingsIn(schema))).toHaveLength(1);
  });

  it("handles a schema with neither settings nor blocks without throwing", () => {
    expect(findSchemaDefaultViolations(allSettingsIn({}))).toEqual([]);
  });
});

describe("guard the guard — the FILE-LEVEL extraction actually finds a violation end to end, not just the pure detector", () => {
  /**
   * The failure mode this specifically guards against: the pure detector
   * above could be perfectly correct while `extractSchema`'s regex/JSON
   * parsing silently matches nothing on a real file (a schema tag
   * whitespace variant, a trim-dash `{%- schema -%}` form, etc.), and the
   * whole fence would report zero violations for the wrong reason. This
   * test exercises the SAME `extractSchema` + `allSettingsIn` path the real
   * file walk above uses, against a synthetic `.liquid` source string, not
   * against pre-parsed objects.
   */
  it("extracts a violation from a synthetic .liquid source using a plain {% schema %} tag", () => {
    const source = `
      <div>hello</div>
      {% schema %}
      { "name": "Test", "settings": [ { "type": "text", "id": "heading", "default": "" } ] }
      {% endschema %}
    `;
    const schema = extractSchema(source);
    expect(schema).not.toBeNull();
    expect(findSchemaDefaultViolations(allSettingsIn(schema as Record<string, unknown>))).toHaveLength(1);
  });

  it("extracts a violation from a synthetic .liquid source using a trim-dash {%- schema -%} tag", () => {
    const source = `
      {%- schema -%}
      { "settings": [ { "type": "range", "id": "padding", "min": 0, "max": 10, "default": 50 } ] }
      {%- endschema -%}
    `;
    const schema = extractSchema(source);
    expect(schema).not.toBeNull();
    expect(findSchemaDefaultViolations(allSettingsIn(schema as Record<string, unknown>))).toHaveLength(1);
  });

  it("returns null (not a violation, not a throw) for a file with no schema tag at all", () => {
    expect(extractSchema("<div>a plain snippet with no schema</div>")).toBeNull();
  });

  it("returns no violations for a clean, real-shaped schema", () => {
    const source = `
      {% schema %}
      {
        "name": "Clean section",
        "settings": [
          { "type": "text", "id": "heading", "label": "Heading" },
          { "type": "range", "id": "padding_top", "min": 0, "max": 100, "step": 4, "default": 36 }
        ]
      }
      {% endschema %}
    `;
    const schema = extractSchema(source);
    expect(findSchemaDefaultViolations(allSettingsIn(schema as Record<string, unknown>))).toEqual([]);
  });
});
