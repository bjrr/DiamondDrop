import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * CUSTOMER-FACING COPY MAY NAME ONLY THE *ENABLED* BANK PAYMENT METHODS.
 *
 * There are two different lists and conflating them is how this broke.
 *
 *   ELIGIBLE FAMILY   — CLAUDE.md §14: electronic methods that MAY be
 *                       configured. Zelle, ACH, bank transfer, wire. This is
 *                       the policy ceiling, not an offer.
 *   ENABLED AT LAUNCH — Owner decision 2026-09-29, reconfirmed 2026-10-26:
 *                       Zelle and DOMESTIC WIRE ONLY.
 *
 * The backend already respected this — `bankPaymentCoordinates.server.ts`
 * exposes only two methods and `groupBuyPaymentInstructionsEmail.test.ts`
 * asserts the email never says "ach" or "bank transfer". The THEME did not.
 * Two live surfaces advertised methods a customer cannot actually use:
 *
 *   - `assets/group-buy-campaign.js` — "Zelle, bank transfer, ACH, or wire"
 *   - `templates/index.json`         — "Zelle, ACH, bank transfer and wire
 *                                       all qualify"
 *
 * Telling someone a payment method qualifies when it is switched off is a
 * material pricing misstatement: the Bank Payment Price is contingent on
 * paying by an enabled method. Hence a fence rather than a one-off fix.
 *
 * This deliberately scans the SHIPPED THEME rather than a constant, because
 * the defect was copy written straight into a template, where no amount of
 * backend discipline would have caught it.
 *
 * NOT IN SCOPE. The admin verification form legitimately records `ach` as a
 * method that *arrived* (`BANK_PAYMENT_METHODS` in verification.ts keeps all
 * four). Recording what a customer actually sent is not offering it, and that
 * surface is admin-only. Internal engineering comments are likewise exempt —
 * they document the policy ceiling on purpose.
 */

const THEME = join(process.cwd(), "..", "theme");

/** Surfaces a customer actually reads. Not `config/`, not `.md`. */
const CUSTOMER_FACING_DIRS = ["templates", "sections", "snippets", "assets", "locales"];

/** `\bach\b` alone matches "each"/"attach"; require it to read as the method. */
const DISABLED_METHODS: Array<{ label: string; pattern: RegExp }> = [
  { label: "ACH", pattern: /\bACH\b/ },
  { label: "bank transfer", pattern: /\bbank transfers?\b/i },
];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Strips `//` and `/* *\/` comments so an engineering note explaining the
 * policy ceiling does not read as an offer. Crude on purpose: it only has to
 * handle theme JS, and over-stripping would make the fence weaker, not wrong.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function customerFacingFiles(): string[] {
  return CUSTOMER_FACING_DIRS.flatMap((d) => {
    try {
      return walk(join(THEME, d));
    } catch {
      return [];
    }
  });
}

describe("theme copy names only the bank payment methods enabled at launch", () => {
  for (const { label, pattern } of DISABLED_METHODS) {
    it(`never offers ${label} to a customer`, () => {
      const offenders = customerFacingFiles()
        .filter((f) => pattern.test(stripComments(readFileSync(f, "utf8"))))
        .map((f) => f.slice(THEME.length + 1).replace(/\\/g, "/"));

      expect(
        offenders,
        `${label} is NOT enabled at launch (owner decision 2026-09-29, ` +
          `reconfirmed 2026-10-26). Only Zelle and domestic wire may be named ` +
          `to a customer. Offending theme files: ${offenders.join(", ")}`
      ).toEqual([]);
    });
  }

  it("still names the two methods that ARE enabled, so the fence cannot pass by saying nothing", () => {
    const corpus = customerFacingFiles()
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    expect(/\bZelle\b/i.test(corpus)).toBe(true);
    expect(/\bwire\b/i.test(corpus)).toBe(true);
  });
});
