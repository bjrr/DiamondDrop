import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
} from "./acknowledgmentText";

/**
 * Criterion 154 / task 5-5 — proves `theme/locales/en.default.json`'s
 * `templates.warranty_claim.form.acknowledgment_text` and
 * `.acknowledgment_affirm_label` are byte-identical to the constants this
 * app pins in `acknowledgmentText.ts`. Same precedent as
 * `app/domain/luxurysteals/disclosureText.test.ts`: the module holds the
 * pinned constants, this file proves the theme's SECOND, independent copy
 * of the same words has not drifted — reading the locale file from disk
 * rather than importing a shared constant, because Liquid cannot import a
 * TypeScript module.
 *
 * WHY THE LABEL MATTERS AS MUCH AS THE TEXT. The label is stored as
 * evidence of what the customer actually clicked
 * (`Acknowledgment.affirmativeActionLabel`, set from
 * `WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL` in
 * `apps.carat.warranty-claim.tsx`). If the theme ever rendered a DIFFERENT
 * caption on the checkbox than what the server records, the evidence row
 * would describe a button the customer never actually saw — the same
 * hazard `luxurysteals/luxury-product-gate.liquid`'s acknowledgment gate
 * guards against for Final Sale.
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

const TEXT_PATH = ["templates", "warranty_claim", "form", "acknowledgment_text"] as const;
const LABEL_PATH = ["templates", "warranty_claim", "form", "acknowledgment_affirm_label"] as const;

describe("criterion 154 — the Warranty Claim acknowledgment is pinned and matches the theme", () => {
  it("acknowledgment text is character-for-character identical on the storefront", () => {
    const fromTheme = localeString(TEXT_PATH);
    expect(typeof fromTheme).toBe("string");
    expect(fromTheme).toBe(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT);
  });

  it("affirmative-action label is character-for-character identical on the storefront — the ampersand, not 'and'", () => {
    const fromTheme = localeString(LABEL_PATH);
    expect(typeof fromTheme).toBe("string");
    expect(fromTheme).toBe(WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL);
    expect(fromTheme).toContain("&");
  });

  it("fails if either theme key goes missing entirely, not just if it differs", () => {
    expect(localeString(TEXT_PATH), "templates.warranty_claim.form.acknowledgment_text is missing from the theme locale").toBeTypeOf(
      "string"
    );
    expect(
      localeString(LABEL_PATH),
      "templates.warranty_claim.form.acknowledgment_affirm_label is missing from the theme locale"
    ).toBeTypeOf("string");
    expect(localeString([...TEXT_PATH, "nope"])).toBeUndefined();
  });
});
