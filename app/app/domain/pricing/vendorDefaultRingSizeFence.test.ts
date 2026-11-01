/**
 * PRICING MAY NOT DERIVE THE BASE RING SIZE. IT MUST BE GIVEN ONE.
 *
 * Owner direction 2026-11-01: the vendor's title is an IMPORT source only.
 * The operational source of truth is the Shopify product metafield
 * `carat.default_ring_size`, which is pinned so staff can verify it against
 * the vendor listing.
 *
 * The failure this prevents is specific and quiet. The pilot's Shopify title
 * is ALREADY the cleaned-up one:
 *
 *   vendor:   "14K Pear Solitaire — Ultra Light Tulip (Size 6.5)"
 *   Shopify:  "14K Pear Solitaire — Ultra Light Tulip Mounting"
 *
 * A parser in the pricing path would find no size in the live title and
 * either throw on a product that prices perfectly well, or fall back to
 * something — option order, the first variant, another number in the string —
 * and reprice 75 variants by $25, $40 or $100 without failing anything.
 *
 * So this scans the real pricing sources for the ways a base size could be
 * re-derived, rather than trusting a convention.
 *
 * WHAT IS NOT FENCED: `vendorDefaultRingSize.ts` itself, which is the import
 * -time parser and is meant to read a title, and the tests.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PRICING_DIR = join(process.cwd(), "app", "domain", "pricing");

/** The import-time parser is the one module allowed to read a title. */
const EXEMPT = new Set(["vendorDefaultRingSize.ts"]);

function pricingSources(): { file: string; source: string }[] {
  return readdirSync(PRICING_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXEMPT.has(f))
    .map((file) => ({ file, source: readFileSync(join(PRICING_DIR, file), "utf8") }));
}

/** Comments explain the rule on purpose; only executable code is fenced. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("no pricing module re-derives the vendor base ring size", () => {
  it("found pricing sources to scan", () => {
    // A fence that silently scans nothing passes forever.
    const files = pricingSources();
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.file)).toContain("mountingPricing.ts");
  });

  it("none of them imports the import-time title parser", () => {
    const offenders = pricingSources()
      .filter(({ source }) => /vendorDefaultRingSize/.test(stripComments(source)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("none of them parses a title", () => {
    const offenders: string[] = [];
    for (const { file, source } of pricingSources()) {
      const code = stripComments(source);
      // A regex mentioning "size", or any read of a title-shaped property.
      if (/\/[^\n/]*\bsize\b[^\n/]*\/[gimsuy]*/i.test(code)) {
        offenders.push(`${file}: a regex matching "size"`);
      }
      if (/\b(productTitle|vendorTitle)\b/.test(code) || /\.title\b/.test(code)) {
        offenders.push(`${file}: reads a title`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("none of them reads option order, option values or a first variant", () => {
    const offenders: string[] = [];
    for (const { file, source } of pricingSources()) {
      const code = stripComments(source);
      for (const [pattern, what] of [
        [/\bselectedOptions\b/, "selectedOptions"],
        [/\boptionValues\b/, "optionValues"],
        [/\boptionOrder\b/, "optionOrder"],
        [/\bvariants\s*\[\s*0\s*\]/, "variants[0]"],
        [/\boptions\s*\[\s*0\s*\]/, "options[0]"],
      ] as const) {
        if (pattern.test(code)) offenders.push(`${file}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("mountingPricing takes the base size as a required input", () => {
  const source = readFileSync(join(PRICING_DIR, "mountingPricing.ts"), "utf8");

  it("declares baseRingSize on the spec, not optionally", () => {
    expect(source).toMatch(/readonly baseRingSize: DecimalString;/);
    expect(source).not.toMatch(/baseRingSize\?:/);
  });

  it("documents that the value comes from the vendor title, via the field", () => {
    expect(source).toMatch(/VENDOR'S product title/);
  });

  it("has no default for it", () => {
    // A default would let a caller that forgot to read the metafield price a
    // mounting anyway, at whatever size the default happened to be.
    expect(source).not.toMatch(/baseRingSize\s*[=:]\s*["']\d/);
  });
});
