import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILDER_OPTION_ROLES,
  OPTION_ROLE_LABELS,
} from "~/domain/groupbuy/campaignBuilder";

/**
 * Two promises the price preview makes that a type signature cannot keep.
 *
 * 1. IT DOES NOT REPRODUCE PRICING (§9). The preview must compose the real
 *    engine, not multiply a base price by a tier multiplier itself. A second
 *    copy of a money derivation is the specific failure `campaignTierPricing
 *    .ts` was extracted to prevent, and its own header says so: the copies
 *    agree until one is updated, and the disagreement is invisible because
 *    every individual figure stays plausible.
 *
 * 2. IT LEAKS NO INTERNAL COST DATA (§9, CLAUDE.md rule 10). The functions
 *    it calls return landed cost, margin floors, the pricing profile and its
 *    id. None of that may reach a caller, and "the interface has no field
 *    for it" is only true for as long as nobody adds one.
 *
 * Both are properties of the SOURCE, so the source is what gets asserted.
 * This is the same technique as `cartMoneySurfaceFence.test.ts` and the
 * other fences in this repository.
 *
 * The file is read with comments and string literals REMOVED before any
 * pattern runs. A fence that matched its own explanatory prose — or an error
 * message mentioning a cost — would pass or fail for reasons unrelated to
 * the code, which is how a previous fence in this repository came to be
 * satisfied by an import line.
 */

const MODULE_PATH = join(process.cwd(), "app", "jobs", "groupbuy", "campaignPricePreview.server.ts");
const SOURCE = readFileSync(MODULE_PATH, "utf8");

/** Source with block comments, line comments and string/template literals blanked out. */
function codeOnly(source: string): string {
  let out = "";
  let index = 0;
  const length = source.length;

  while (index < length) {
    const two = source.slice(index, index + 2);
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (two === "//") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? length : end;
      continue;
    }
    const character = source[index]!;
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      while (index < length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === character) {
          index += 1;
          break;
        }
        index += 1;
      }
      out += '""';
      continue;
    }
    out += character;
    index += 1;
  }

  return out;
}

const CODE = codeOnly(SOURCE);

describe("the comment stripper the rest of this file depends on", () => {
  // If this helper is wrong, every assertion below is meaningless, so it is
  // tested rather than trusted.
  it("removes block comments, line comments and string contents", () => {
    expect(codeOnly("const a = 1; /* landedCost */")).not.toContain("landedCost");
    expect(codeOnly("const a = 1; // landedCost")).not.toContain("landedCost");
    expect(codeOnly('const a = "landedCost";')).not.toContain("landedCost");
    expect(codeOnly("const a = `landedCost`;")).not.toContain("landedCost");
    expect(codeOnly('const a = "it\\"s";const b = 2;')).toContain("const b = 2");
  });

  it("keeps the code either side of a comment", () => {
    expect(codeOnly("const before = 1; /* x */ const after = 2;")).toContain("const before = 1");
    expect(codeOnly("const before = 1; /* x */ const after = 2;")).toContain("const after = 2");
  });

  it("actually stripped this module's header", () => {
    expect(SOURCE).toContain("PRICE PREVIEW for a draft Group Buy campaign");
    expect(CODE).not.toContain("PRICE PREVIEW for a draft Group Buy campaign");
  });
});

describe("the preview composes the real pricing engine", () => {
  it("calls the one shared tier-price definition", () => {
    // Asserted as a CALL, not merely an import: an import that nothing calls
    // would satisfy a naive fence while the real arithmetic happened inline.
    expect(CODE).toMatch(/campaignTierDualPrices\s*\(/);
    expect(SOURCE).toContain('from "~/domain/groupbuy/campaignTierPricing"');
  });

  it("gets its base price from the same two calls the open path makes", () => {
    expect(CODE).toMatch(/resolveInputsForVariant\s*\(/);
    expect(CODE).toMatch(/computeBuyNowPrice\s*\(/);
    expect(SOURCE).toContain('from "~/domain/pricing/engine"');
  });

  it("does no money arithmetic of its own", () => {
    // Multiplication, division and subtraction on a price are how a
    // reimplementation starts. The preview has nothing legitimate to do with
    // any of them: every figure it returns arrives already computed.
    expect(CODE).not.toMatch(/[*/]\s*(?:tier|price|rate|multiplier)/i);
    expect(CODE).not.toMatch(/(?:priceMultiplier|bankPayment\w*)\s*[*/-]/);
    expect(CODE).not.toMatch(/\btimes\s*\(/);
    expect(CODE).not.toMatch(/\bminus\s*\(/);
    expect(CODE).not.toMatch(/\bdividedBy\s*\(/);
  });

  it("does not round anything", () => {
    // Rounding a money figure outside the versioned registry is forbidden
    // repository-wide; here it would also mean the preview quoted a figure
    // the checkout would not.
    expect(CODE).not.toMatch(/toFixed\s*\(/);
    expect(CODE).not.toMatch(/\bround\b/i);
    expect(CODE).not.toMatch(/\bceil\b/i);
    expect(CODE).not.toMatch(/\bfloor\b/i);
    expect(CODE).not.toMatch(/applyPriceEnding\s*\(/);
  });

  it("does not open, freeze, or write anything (§8 is untouched)", () => {
    expect(CODE).not.toMatch(/openGroupBuyCampaign/);
    expect(CODE).not.toMatch(/prisma\.\w+\.(?:create|update|upsert|delete|createMany|updateMany|deleteMany)\b/);
    expect(CODE).not.toMatch(/\$transaction/);
    expect(CODE).not.toMatch(/\$executeRaw/);
  });
});

describe("the preview leaks no internal cost or margin data", () => {
  /**
   * Every identifier that may appear in this module. A new field on a
   * returned interface has to be added here deliberately, which is the
   * point: the allow-list is the review step.
   */
  const FORBIDDEN_IDENTIFIERS = [
    "landedCost",
    "landedCostMinorUnits",
    "variantFloor",
    "variantFloorMinorUnits",
    "minGrossMarginRate",
    "minDollarProfit",
    "targetGrossMarginRate",
    "targetMarkupRate",
    "marginModel",
    "pricingProfileId",
    "supplierCost",
    "vendorSku",
    "rawVendorSku",
    "gramWeight",
    "appliedUpliftRate",
    "appliedTierLabel",
    "autoApplyToleranceBps",
    "breakdown",
  ];

  it.each(FORBIDDEN_IDENTIFIERS)("never mentions %s in code", (identifier) => {
    expect(CODE).not.toContain(identifier);
  });

  it("returns only the fields its own interfaces declare", () => {
    // The three returned shapes, spelled out. If a field is added to any of
    // them, this list is what forces someone to look at whether it is
    // customer-safe.
    const tierPriceFields = ["tierNumber", "bankPaymentMinorUnits", "regularCardMinorUnits"];
    const rowFields = [
      "variantGroupSignature",
      "description",
      "configurationCount",
      "tierPrices",
      "problem",
    ];
    const previewFields = ["currency", "pricedAsOf", "tiers", "rows", "problems"];

    const declared = (interfaceName: string): readonly string[] => {
      const match = SOURCE.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
      expect(match, `interface ${interfaceName} not found`).not.toBeNull();
      return [...match![1]!.matchAll(/^\s*readonly ([A-Za-z0-9_]+)[?]?:/gm)].map((m) => m[1]!);
    };

    expect([...declared("PreviewTierPrice")].sort()).toEqual([...tierPriceFields].sort());
    expect([...declared("PreviewRow")].sort()).toEqual([...rowFields].sort());
    expect([...declared("CampaignPricePreview")].sort()).toEqual([...previewFields].sort());
  });

  it("exposes only id and label on a mappable variant", () => {
    // §6 wants the merchant choosing from a readable list. A cost or a raw
    // vendor SKU on that list would be an internal leak into a dropdown.
    const match = SOURCE.match(/export interface MappableVariantOption \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const fields = [...match![1]!.matchAll(/^\s*readonly ([A-Za-z0-9_]+)[?]?:/gm)].map((m) => m[1]!);
    expect(fields.sort()).toEqual(["label", "masterVariantId"]);
  });

  it("logs no price, cost or customer data when a variant fails to price", () => {
    const logCalls = [...CODE.matchAll(/logger\.\w+\(([\s\S]*?)\);/g)].map((m) => m[1]!);
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/cost|margin|profit|email|phone|customer/i);
    }
  });
});

describe("the builder's merchant-facing role labels say price in plain words", () => {
  // §4 asks the merchant to classify options as price-affecting or not, and
  // §18 asks for merchant-friendly labels. The stored role NAMES avoid the
  // word deliberately (the options contract's forbidden-key backstop would
  // reject it); the labels must not inherit that evasion.
  it("covers every role", () => {
    expect(Object.keys(OPTION_ROLE_LABELS).sort()).toEqual([...BUILDER_OPTION_ROLES].sort());
  });

  it("uses the word price rather than internal vocabulary", () => {
    for (const label of Object.values(OPTION_ROLE_LABELS)) {
      expect(label.toLowerCase()).toContain("price");
      expect(label).not.toMatch(/variant_defining|customer_preference|signature/);
    }
  });
});
