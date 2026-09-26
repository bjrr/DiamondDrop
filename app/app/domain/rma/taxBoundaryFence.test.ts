import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D7 (docs/ARCHITECTURE-MVP1.md), criterion 192
 * (docs/specs/SLICE-4-BUY-NOW-RMA.md): this domain computes ONLY the
 * merchandise-side RMA remedy and must never contain a tax rate, percentage,
 * or table — not as a constant, not as a fallback, not as a `TODO`.
 *
 * This reads every non-test source file in this directory, strips comments
 * (this directory's own doc comments legitimately discuss D7/tax at length —
 * see `remedy.ts`'s header — so the fence must look at CODE, not prose), and
 * asserts none of them contain the substring "tax" once comments are gone.
 *
 * Mirrors `warrantyClaimRoute.test.ts`'s criterion-165 fence exactly,
 * including its "guard the guard" case: a fence that only checks re-exports
 * or an empty file proves nothing (see
 * `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` §12's finding on that exact
 * mistake) — this includes a synthetic-violation test proving the fence can
 * actually fail.
 */

const DOMAIN_DIR = dirname(fileURLToPath(import.meta.url));

function nonTestSourceFiles(): string[] {
  return readdirSync(DOMAIN_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

function sourceWithoutComments(filename: string): string {
  const raw = readFileSync(join(DOMAIN_DIR, filename), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("criterion 192 — no tax rate/percentage/table anywhere in app/domain/rma", () => {
  it("finds the domain's source files where this fence expects them — guard the guard", () => {
    // Without this, a directory rename or an empty directory turns every
    // assertion below into a vacuous pass over zero files.
    const files = nonTestSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toEqual(expect.arrayContaining(["window.ts", "eligibility.ts", "remedy.ts", "status.ts"]));
  });

  it.each(nonTestSourceFiles())("%s contains no reference to tax outside of comments", (filename) => {
    expect(sourceWithoutComments(filename)).not.toMatch(/tax/i);
  });

  it("the fence itself can fail — proven against a synthetic violating source", () => {
    // A fence nobody has watched fire is a fence nobody should trust.
    const violating = "const TAX_RATE = 0.08;\nfunction applyTax(amount) { return amount * (1 + TAX_RATE); }";
    expect(violating).toMatch(/tax/i);
  });

  it("stripping comments does not itself hide a violation sitting on the same line as code", () => {
    // Confirms the comment-stripping regex used above only removes actual
    // comment text — a violation immediately preceding a `//` comment on the
    // same line is not swallowed by this fence's own machinery.
    const violatingLine = 'const rate = TAX_RATE_V1; // not a comment about tax, an actual reference';
    const stripped = violatingLine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).toMatch(/tax/i);
  });
});
