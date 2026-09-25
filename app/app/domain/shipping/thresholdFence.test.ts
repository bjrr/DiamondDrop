import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION FENCE, D31 (docs/ARCHITECTURE-MVP1.md, resolved 2026-09-25).
 *
 * SUPERSEDES the earlier version of this file. Before D29/D31, "order
 * value" was undefined and this fence forbade the number 100/10000
 * anywhere in this directory outright — the number had no defined meaning,
 * so no code was allowed to use it. That question is now answered: D29
 * defines the basis (shipment merchandise value) and D31 defines the figure
 * ($100.00). The $100 threshold is now a real, encodable rule.
 *
 * What still needs a fence is a DIFFERENT failure mode: the same number
 * restated in more than one place. A threshold that exists in two spots
 * can drift — someone "fixes" one occurrence during a refactor and leaves
 * the other, and now the effective rule depends on which code path ran.
 * `STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD` in
 * `signatureRequirement.ts` is the ONE declaration; every other file in
 * this directory must import it rather than restate the figure.
 *
 * SCOPE. This fence covers `app/domain/shipping/**` — the surface this task
 * owns. If a future task adds a repository or route that needs the
 * threshold (to gate fulfilment, to display it to staff, etc.), that
 * consumer must import `STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD`
 * too, and this fence's scope should widen to cover it — noted here so
 * that expansion is a deliberate decision, not a silent gap.
 */

const SHIPPING_DOMAIN_DIR = join(process.cwd(), "app", "domain", "shipping");
const DECLARATION_FILE = "signatureRequirement.ts";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Matches every plausible spelling of $100.00 / 10000 minor units as a literal (not an identifier reference to the exported constant). */
const THRESHOLD_LITERAL_PATTERNS: readonly RegExp[] = [
  /\$\s?100(?:\.00)?\b/, // $100 / $100.00
  /\b100_00n?\b/, // 100_00 / 100_00n — a plausible minor-units-of-$100 spelling
  /\b10[,_]?000n?\b/, // 10000 / 10_000 / 10,000, each optionally suffixed with bigint's "n"
];

function countThresholdLiterals(source: string): number {
  const code = stripComments(source);
  return THRESHOLD_LITERAL_PATTERNS.reduce((count, pattern) => count + (code.match(new RegExp(pattern, "g"))?.length ?? 0), 0);
}

function sourceFiles(): string[] {
  return readdirSync(SHIPPING_DOMAIN_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

describe("D31 threshold — exactly one declaration, never restated", () => {
  it("finds the declaration file and at least three other domain modules to check", () => {
    const files = sourceFiles();
    expect(files).toContain(DECLARATION_FILE);
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it(`${DECLARATION_FILE} declares the threshold literal exactly once`, () => {
    const source = readFileSync(join(SHIPPING_DOMAIN_DIR, DECLARATION_FILE), "utf8");
    expect(countThresholdLiterals(source)).toBe(1);
  });

  it.each(sourceFiles().filter((name) => name !== DECLARATION_FILE))(
    "%s never restates the threshold literal — it must import STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD instead",
    (fileName) => {
      const source = readFileSync(join(SHIPPING_DOMAIN_DIR, fileName), "utf8");
      expect(
        countThresholdLiterals(source),
        `${fileName} contains a literal that looks like the D31 $100.00 threshold. ` +
          `Import STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD from ./signatureRequirement instead of restating the figure.`
      ).toBe(0);
    }
  );
});

describe("guard the guard — the detector actually catches each restatement shape", () => {
  it("counts a $100 literal", () => {
    expect(countThresholdLiterals("if (value > '$100') {}")).toBe(1);
  });

  it("counts a $100.00 literal", () => {
    expect(countThresholdLiterals("const label = '$100.00 or less';")).toBe(1);
  });

  it("counts a 100_00n minor-units literal", () => {
    expect(countThresholdLiterals("const t = 100_00n;")).toBe(1);
  });

  it("counts a bare 10000n minor-units literal", () => {
    expect(countThresholdLiterals("const t = 10000n;")).toBe(1);
  });

  it("counts multiple restatements in one file", () => {
    expect(countThresholdLiterals("const a = 10000n; const b = '$100.00';")).toBe(2);
  });

  it("is not fooled by a mention only in a comment", () => {
    const documented = `
      // The D31 threshold is $100.00 / 10000n — declared once in signatureRequirement.ts.
      import { STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD } from "./signatureRequirement";
      export const x = STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD;
    `;
    expect(countThresholdLiterals(documented)).toBe(0);
  });

  it("does not flag an unrelated large number", () => {
    expect(countThresholdLiterals("const attemptCount = 1000000;")).toBe(0);
  });

  it("does not flag an unrelated small number that merely contains '100' as a substring of a larger one", () => {
    expect(countThresholdLiterals("const year = 21000;")).toBe(0);
  });
});
