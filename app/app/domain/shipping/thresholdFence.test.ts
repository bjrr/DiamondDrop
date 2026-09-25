import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION FENCE for docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criterion
 * 175 and docs/specs/SLICE-11-READINESS.md G1: "order value" — the
 * denominator for README's $100 signature threshold and its "full order
 * value" insurance rule — is undefined in every document that governs
 * shipping, and is an open owner question. This module records what staff
 * arranged (criteria 171-179); it must never quietly answer G1 by
 * encoding a $100 figure or a comparison against an order amount.
 *
 * A comment saying "we don't do this" (see `signatureRequirement.ts`'s and
 * `insuredValue.ts`'s own header comments) does not fail a build. This does.
 *
 * WALKS THE SOURCE of every non-test file in this directory, same reasoning
 * as `luxurysteals/metafieldEligibilityFence.test.ts`: a denylist of the
 * concrete SHAPES an invented threshold would take (a $100/10000 literal, an
 * identifier naming an order amount, a function named as if it derives a
 * requirement from one) fails on new code in whatever form it takes, rather
 * than only on a hand-maintained list of files someone remembered to check.
 */

const SHIPPING_DOMAIN_DIR = join(process.cwd(), "app", "domain", "shipping");

/** Block and line comments removed, so this file's own prose about the rule cannot trip its own fence. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const HUNDRED_DOLLAR_LITERAL_PATTERN = /\$\s?100\b/;
// 100, 100n (bigint literal), or 100_00 / 100_00n (a plausible minor-units-of-$100 spelling).
const HUNDRED_NUMERIC_LITERAL_PATTERN = /\b100(?:_00)?n?\b/;
// 10000 / 10_000 / 10,000, each optionally suffixed with the bigint literal's trailing "n" — $100.00 in cents.
const TEN_THOUSAND_MINOR_UNITS_PATTERN = /\b10[,_]?000n?\b/;
const ORDER_AMOUNT_IDENTIFIER_PATTERN = /order(?:Total|Amount|Value)(?:MinorUnits)?/i;
const DERIVE_FROM_AMOUNT_PATTERN = /(?:derive|compute|calculate)[A-Za-z]*Signature/i;

interface FenceResult {
  violated: boolean;
  reasons: string[];
}

/** PURE — no I/O. The detector, proven by the "guard the guard" tests below, not just trusted. */
function checkThresholdFence(source: string): FenceResult {
  const code = stripComments(source);
  const reasons: string[] = [];
  if (HUNDRED_DOLLAR_LITERAL_PATTERN.test(code)) reasons.push('contains a "$100"-shaped literal');
  if (HUNDRED_NUMERIC_LITERAL_PATTERN.test(code)) reasons.push('contains a bare "100" numeric literal');
  if (TEN_THOUSAND_MINOR_UNITS_PATTERN.test(code)) reasons.push('contains a "10000"-shaped minor-units literal');
  if (ORDER_AMOUNT_IDENTIFIER_PATTERN.test(code)) reasons.push("references an order-amount identifier");
  if (DERIVE_FROM_AMOUNT_PATTERN.test(code)) reasons.push("names a function as if it derives a signature requirement from an amount");
  return { violated: reasons.length > 0, reasons };
}

const WHY_THIS_MATTERS =
  '"Order value" (docs/specs/SLICE-11-READINESS.md G1) is undefined in every document that ' +
  "governs shipping, and is an open owner question. README's $100 signature threshold and " +
  '"full order value" insurance rule are real, but nothing in this codebase may encode them ' +
  "until the owner answers what the figure is measured against — doing so here would silently " +
  "pick an answer by the shape of a parameter list or a literal, exactly the invented default " +
  "this task was told not to produce. Record what staff arranged; do not compute what policy " +
  "requires. See docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md §5.";

function sourceFiles(): string[] {
  return readdirSync(SHIPPING_DOMAIN_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

describe("Slice 11 order-value threshold fence — no invented $100/order-amount logic", () => {
  it("finds at least the three domain modules it is supposed to check", () => {
    // Guards the guard: an empty directory listing would make the it.each
    // below vacuously pass.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files).toEqual(expect.arrayContaining(["addressChange.ts", "insuredValue.ts", "signatureRequirement.ts"]));
  });

  it.each(sourceFiles())("%s never encodes an order-value threshold", (fileName) => {
    const source = readFileSync(join(SHIPPING_DOMAIN_DIR, fileName), "utf8");
    const result = checkThresholdFence(source);
    expect(result.violated, `${fileName} ${result.reasons.join("; ")}.\n\n${WHY_THIS_MATTERS}`).toBe(false);
  });
});

describe("guard the guard — the detector actually catches each violation shape", () => {
  it("flags a $100 literal", () => {
    expect(checkThresholdFence("if (orderTotal.compareTo('$100') > 0) {}").violated).toBe(true);
  });

  it("flags a bare 100 numeric literal", () => {
    expect(checkThresholdFence("const THRESHOLD = 100;").violated).toBe(true);
  });

  it("flags a 100_00 minor-units literal", () => {
    expect(checkThresholdFence("const THRESHOLD_MINOR_UNITS = 100_00n;").violated).toBe(true);
  });

  it("flags a 10000-shaped minor-units literal", () => {
    expect(checkThresholdFence("const THRESHOLD_MINOR_UNITS = 10000n;").violated).toBe(true);
  });

  it("flags an orderTotal identifier", () => {
    expect(checkThresholdFence("function deriveFromTotal(orderTotal: bigint) {}").violated).toBe(true);
  });

  it("flags an orderValueMinorUnits identifier", () => {
    expect(checkThresholdFence("function f(orderValueMinorUnits: bigint) {}").violated).toBe(true);
  });

  it("flags a function named as if it derives a signature requirement from an amount", () => {
    expect(checkThresholdFence("function deriveSignatureRequired(amount: bigint) {}").violated).toBe(true);
  });

  it("is not fooled by a mention only in a comment — matches this repo's existing discipline", () => {
    const documented = `
      // We deliberately never compare against $100 or an orderTotal here —
      // see docs/specs/SLICE-11-READINESS.md G1.
      export function noop() {}
    `;
    expect(checkThresholdFence(documented).violated).toBe(false);
  });

  it("does not flag legitimate, unrelated numeric literals", () => {
    const clean = `
      export function validate(x: bigint) {
        if (x <= 0n) return { ok: false };
        return { ok: true };
      }
    `;
    expect(checkThresholdFence(clean).violated).toBe(false);
  });

  it("does not flag an unrelated identifier that merely contains 'order' as a substring", () => {
    const clean = `const sortOrder = 1; const orderRef = "gid://shopify/Order/1";`;
    expect(checkThresholdFence(clean).violated).toBe(false);
  });

  it("does not flag numbers unrelated to the $100/10000 shapes, like a positive count or a year", () => {
    const clean = `const attemptCount = 3; const year = 2026;`;
    expect(checkThresholdFence(clean).violated).toBe(false);
  });
});
