import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLISHED_POLICY_TERMS } from "~/domain/content/publishedPolicyTerms";

/**
 * THE POLICY TERMS THEME SURFACE — `sections/policy-terms.liquid`,
 * `assets/policy-terms.js` and the six `page.policy-*.json` templates.
 *
 * ============================================================================
 * WHY THESE ARE STATIC CHECKS AND NOT A RENDERING TEST
 * ============================================================================
 * This suite has no DOM environment, and the existing theme tests work by
 * loading a file into a `vm` sandbox and exercising exported pure functions.
 * `policy-terms.js` has none worth exporting — it fetches and appends.
 *
 * But its real risks are all statically visible, and they are the ones worth
 * guarding:
 *
 *   1. rendering a term as MARKUP instead of text;
 *   2. a hard-coded copy of a term appearing as a "fallback";
 *   3. a template naming a policy group the registry does not have, which
 *      renders an EMPTY page rather than an error — a policy page with no
 *      policies on it, looking exactly like one that is simply short.
 *
 * (3) is why this file lives under `app/` and imports the registry: it is the
 * only place the theme and the server's list of groups can be compared.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const SECTION = readFileSync(join(THEME_ROOT, "sections", "policy-terms.liquid"), "utf8");
const SCRIPT = readFileSync(join(THEME_ROOT, "assets", "policy-terms.js"), "utf8");

const TEMPLATE_DIR = join(THEME_ROOT, "templates");
const POLICY_TEMPLATES = readdirSync(TEMPLATE_DIR).filter((name) => name.startsWith("page.policy-"));

describe("a term is rendered as TEXT, never as markup", () => {
  it("never uses innerHTML, outerHTML, insertAdjacentHTML or document.write", () => {
    // Two reasons, and the second is the one people forget: the value
    // crosses a network boundary, AND a material term that renders
    // differently from how it is stored is a term we cannot prove we showed.
    for (const forbidden of [/\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/]) {
      expect(SCRIPT, `policy-terms.js uses ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("uses textContent to place content", () => {
    // Guard the guard: if the rendering were removed entirely the assertion
    // above would pass while protecting nothing.
    expect(SCRIPT).toMatch(/textContent/);
  });

  it("the Liquid section never interpolates a term into markup", () => {
    // The terms must not be server-rendered into the page by Liquid either —
    // they are not available to Liquid at all, and a `{{ ... }}` of anything
    // term-shaped would mean someone had introduced a second source.
    expect(SECTION).not.toMatch(/\{\{\s*section\.settings\.(term|terms|policy_text|text)\s*\}\}/);
  });
});

describe("there is no second copy of any term", () => {
  it("the section schema offers no setting that could hold term text", () => {
    // A settings field would be a second copy wearing a different hat, and
    // it would be the one nobody updates.
    const schemaMatch = SECTION.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
    expect(schemaMatch, "policy-terms.liquid has no schema block").not.toBeNull();

    const schema = JSON.parse(schemaMatch![1]!) as {
      settings: { id?: string; type: string }[];
    };
    const ids = schema.settings.map((s) => s.id).filter(Boolean) as string[];

    for (const forbidden of ["term", "terms", "policy_text", "text", "body", "content"]) {
      expect(ids, `the schema exposes a "${forbidden}" setting, which could hold a term`).not.toContain(
        forbidden
      );
    }
    // The ones it SHOULD have.
    expect(ids).toContain("group");
    expect(ids).toContain("heading");
  });

  it("the script carries no fallback policy wording", () => {
    /**
     * A stale material term shown as current is worse than a visible error:
     * the customer cannot tell the difference, and we have no record of what
     * they read. So a failure path must link or apologise, never recite.
     *
     * Detected by looking for the distinctive vocabulary of our actual
     * terms. The error strings ("could not load", "contact us") contain none
     * of it.
     */
    for (const termVocabulary of [
      /restocking/i,
      /final sale/i,
      /warrant/i,
      /RMA/,
      /calendar days/i,
      /Bank Payment Price/i,
    ]) {
      expect(SCRIPT, `policy-terms.js appears to contain policy wording (${termVocabulary})`).not.toMatch(
        termVocabulary
      );
    }
  });
});

describe("every template names a group the registry actually has", () => {
  const registryGroups = new Set(PUBLISHED_POLICY_TERMS.map((t) => t.group));

  it("the registry has groups to match against", () => {
    expect(registryGroups.size).toBeGreaterThan(0);
  });

  for (const template of POLICY_TEMPLATES) {
    it(`${template}`, () => {
      const parsed = JSON.parse(readFileSync(join(TEMPLATE_DIR, template), "utf8")) as {
        sections: Record<string, { type: string; settings?: Record<string, unknown> }>;
      };

      const termsSection = Object.values(parsed.sections).find((s) => s.type === "policy-terms");
      expect(termsSection, `${template} has no policy-terms section`).toBeDefined();

      const group = termsSection!.settings?.group;
      // A GROUP THE SERVER DOES NOT KNOW RENDERS AN EMPTY PAGE, not an
      // error — a policy page with no policies on it, indistinguishable
      // from one that is simply short.
      expect(registryGroups.has(group as never), `${template} names unknown group "${group}"`).toBe(true);
    });
  }

  it("covers every group the registry publishes", () => {
    // The other direction: a published group with no page is a term nobody
    // can read.
    const templateGroups = new Set(
      POLICY_TEMPLATES.map((template) => {
        const parsed = JSON.parse(readFileSync(join(TEMPLATE_DIR, template), "utf8")) as {
          sections: Record<string, { type: string; settings?: Record<string, unknown> }>;
        };
        return Object.values(parsed.sections).find((s) => s.type === "policy-terms")?.settings?.group;
      })
    );

    for (const group of registryGroups) {
      expect(templateGroups.has(group), `no page template shows the "${group}" terms`).toBe(true);
    }
  });

  it("the section's own group options match the registry exactly", () => {
    const schemaMatch = SECTION.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
    const schema = JSON.parse(schemaMatch![1]!) as {
      settings: { id?: string; options?: { value: string }[] }[];
    };
    const groupSetting = schema.settings.find((s) => s.id === "group");
    const offered = new Set((groupSetting?.options ?? []).map((o) => o.value));

    expect([...offered].sort()).toEqual([...registryGroups].sort());
  });
});

describe("the section points at the right endpoint", () => {
  it("fetches from /apps/carat/policies", () => {
    expect(SCRIPT).toContain("/apps/carat/policies");
  });

  it("sends the group as a query parameter, encoded", () => {
    expect(SCRIPT).toMatch(/encodeURIComponent\(group\)/);
  });
});
