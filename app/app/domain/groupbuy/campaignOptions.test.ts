import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findForbiddenPricingKeys,
  isGroupBuyOptionSelectionValid,
  validateGroupBuyCampaignOptions,
  type GroupBuyCampaignOptions,
} from "./campaignOptions";

/**
 * §11: "Invalid combinations must not be purchasable" and "the application
 * must render from campaign configuration rather than assuming that all
 * products share ring-style fields." This fixture is a BRACELET, on
 * purpose — a ring fixture would let a ring-shaped assumption slip through
 * unnoticed, since a ring-shaped validator would happen to look correct
 * against ring-shaped data.
 */
const VALID_BRACELET_CONFIG = {
  schemaVersion: 1,
  campaign: { productType: "bracelet", title: "Tennis Bracelet Group Buy" },
  optionDimensions: [
    {
      key: "metal",
      label: "Metal",
      required: true,
      displayOrder: 1,
      allowedValues: [
        { value: "gold", label: "Gold" },
        { value: "platinum", label: "Platinum" },
      ],
    },
    {
      key: "length",
      label: "Length",
      required: true,
      displayOrder: 2,
      allowedValues: [
        { value: "6.5in", label: "6.5 inches" },
        { value: "7in", label: "7 inches" },
        { value: "7.5in", label: "7.5 inches" },
      ],
    },
    {
      key: "clasp",
      label: "Clasp style",
      required: false,
      displayOrder: 3,
      allowedValues: [
        { value: "lobster", label: "Lobster clasp" },
        { value: "box", label: "Box clasp" },
      ],
    },
  ],
  validCombinations: [
    { values: { metal: "gold", length: "6.5in", clasp: "lobster" } },
    { values: { metal: "gold", length: "7in" } }, // clasp is optional — a combination may omit it
    { values: { metal: "platinum", length: "7.5in", clasp: "box" } },
  ],
  tableView: { columns: ["metal", "length"] },
  orderingFlow: { steps: ["metal", "length", "clasp"] },
};

describe("validateGroupBuyCampaignOptions — a valid, non-ring, multi-dimension campaign", () => {
  it("accepts the bracelet fixture", () => {
    const result = validateGroupBuyCampaignOptions(VALID_BRACELET_CONFIG);
    expect(result.ok).toBe(true);
  });

  it("the validator's CODE never names a ring-specific field — only its own doc comments discuss the word, explaining why there is none", () => {
    // Comments stripped first (same discipline as metafieldEligibilityFence.test.ts):
    // this file's own header explains, in prose, that there is no `ringSize`
    // field — that explanation would otherwise trip a naive substring check
    // for saying the right thing. What must never appear is the field in
    // actual code: a property access, a type member, a literal key.
    const source = readFileSync(join(process.cwd(), "app", "domain", "groupbuy", "campaignOptions.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/ringSize/i);
  });
});

describe("validateGroupBuyCampaignOptions — schema version", () => {
  it("refuses an unknown schema version rather than best-guessing the shape", () => {
    const result = validateGroupBuyCampaignOptions({ ...VALID_BRACELET_CONFIG, schemaVersion: 2 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes("schemaVersion"))).toBe(true);
  });

  it("refuses a missing schema version", () => {
    const { schemaVersion: _omit, ...withoutVersion } = VALID_BRACELET_CONFIG;
    const result = validateGroupBuyCampaignOptions(withoutVersion);
    expect(result.ok).toBe(false);
  });
});

describe("validateGroupBuyCampaignOptions — forbidden pricing keys (§12), rejected individually by name", () => {
  const cases: ReadonlyArray<[string, unknown]> = [
    ["margin", { ...VALID_BRACELET_CONFIG, margin: "0.35" }],
    ["upliftTier", { ...VALID_BRACELET_CONFIG, upliftTier: 4 }],
    ["minimumProfit", { ...VALID_BRACELET_CONFIG, minimumProfit: "50.00" }],
    ["pricingRuleId", { ...VALID_BRACELET_CONFIG, pricingRuleId: "rule-123" }],
    ["processorFee", { ...VALID_BRACELET_CONFIG, processorFee: "2.9%" }],
    ["pricingFormula", { ...VALID_BRACELET_CONFIG, pricingFormula: "base * 1.1" }],
  ];

  it.each(cases)("refuses a top-level %s key, naming it in the message", (key, config) => {
    const result = validateGroupBuyCampaignOptions(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes(`"${key}"`))).toBe(true);
  });

  it("refuses a forbidden key nested inside an option dimension, not only at the top level", () => {
    const nested = {
      ...VALID_BRACELET_CONFIG,
      optionDimensions: [
        { ...VALID_BRACELET_CONFIG.optionDimensions[0], margin: "0.1" },
        ...VALID_BRACELET_CONFIG.optionDimensions.slice(1),
      ],
    };
    const result = validateGroupBuyCampaignOptions(nested);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes("optionDimensions[0].margin"))).toBe(true);
  });

  it("refuses a forbidden key nested inside a valid combination", () => {
    const nested = {
      ...VALID_BRACELET_CONFIG,
      validCombinations: [
        { ...VALID_BRACELET_CONFIG.validCombinations[0], bankCardUplift: "0.04" },
        ...VALID_BRACELET_CONFIG.validCombinations.slice(1),
      ],
    };
    const result = validateGroupBuyCampaignOptions(nested);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes("bankCardUplift"))).toBe(true);
  });

  it("still catches a bare 'price' key via the general backstop", () => {
    const result = validateGroupBuyCampaignOptions({ ...VALID_BRACELET_CONFIG, price: "199.00" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes('"price"'))).toBe(true);
  });

  it("collects multiple forbidden keys in one pass, not just the first", () => {
    const result = validateGroupBuyCampaignOptions({ ...VALID_BRACELET_CONFIG, margin: "0.1", processorFee: "0.03" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.filter((p) => p.includes('"margin"') || p.includes('"processorFee"'))).toHaveLength(2);
  });
});

describe("findForbiddenPricingKeys — the recursive walk directly", () => {
  it("finds nothing in a clean object", () => {
    expect(findForbiddenPricingKeys({ a: 1, b: { c: 2 } })).toEqual([]);
  });

  it("reports the exact path for a deeply nested violation", () => {
    const violations = findForbiddenPricingKeys({ a: [{ b: { margin: 1 } }] });
    expect(violations).toEqual([{ path: "$.a[0].b.margin", key: "margin", reason: "a margin rule" }]);
  });

  it("does not flag a string VALUE that happens to contain a forbidden word — only keys are checked", () => {
    const violations = findForbiddenPricingKeys({ description: "A campaign with a healthy margin of quality." });
    expect(violations).toEqual([]);
  });
});

describe("validateGroupBuyCampaignOptions — valid combinations must not reference undeclared values", () => {
  it("refuses a combination referencing an undeclared dimension key", () => {
    const config = {
      ...VALID_BRACELET_CONFIG,
      validCombinations: [{ values: { metal: "gold", length: "7in", finish: "matte" } }],
    };
    const result = validateGroupBuyCampaignOptions(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes("undeclared option dimension \"finish\""))).toBe(true);
  });

  it("refuses a combination referencing an undeclared VALUE for a declared dimension — this is how a broken campaign reaches customers", () => {
    const config = {
      ...VALID_BRACELET_CONFIG,
      validCombinations: [{ values: { metal: "gold", length: "9in" } }], // "9in" is not an allowed length
    };
    const result = validateGroupBuyCampaignOptions(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes('"9in"'))).toBe(true);
  });

  it("refuses a combination missing a required dimension", () => {
    const config = {
      ...VALID_BRACELET_CONFIG,
      validCombinations: [{ values: { metal: "gold" } }], // length is required
    };
    const result = validateGroupBuyCampaignOptions(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems.some((p) => p.includes('missing required dimension "length"'))).toBe(true);
  });

  it("refuses tableView/orderingFlow referencing an undeclared dimension", () => {
    const badTable = { ...VALID_BRACELET_CONFIG, tableView: { columns: ["metal", "finish"] } };
    expect(validateGroupBuyCampaignOptions(badTable).ok).toBe(false);

    const badFlow = { ...VALID_BRACELET_CONFIG, orderingFlow: { steps: ["metal", "finish"] } };
    expect(validateGroupBuyCampaignOptions(badFlow).ok).toBe(false);
  });
});

describe("validateGroupBuyCampaignOptions — other structural refusals", () => {
  it("refuses a duplicate dimension key", () => {
    const config = {
      ...VALID_BRACELET_CONFIG,
      optionDimensions: [...VALID_BRACELET_CONFIG.optionDimensions, VALID_BRACELET_CONFIG.optionDimensions[0]],
    };
    expect(validateGroupBuyCampaignOptions(config).ok).toBe(false);
  });

  it("refuses a duplicate allowed value within one dimension", () => {
    const config = {
      ...VALID_BRACELET_CONFIG,
      optionDimensions: [
        {
          key: "metal",
          label: "Metal",
          required: true,
          displayOrder: 1,
          allowedValues: [
            { value: "gold", label: "Gold" },
            { value: "gold", label: "Gold (again)" },
          ],
        },
        ...VALID_BRACELET_CONFIG.optionDimensions.slice(1),
      ],
    };
    expect(validateGroupBuyCampaignOptions(config).ok).toBe(false);
  });

  it("refuses a non-object top level", () => {
    expect(validateGroupBuyCampaignOptions("not an object").ok).toBe(false);
    expect(validateGroupBuyCampaignOptions(null).ok).toBe(false);
    expect(validateGroupBuyCampaignOptions([1, 2, 3]).ok).toBe(false);
  });

  it("refuses an empty optionDimensions array", () => {
    expect(validateGroupBuyCampaignOptions({ ...VALID_BRACELET_CONFIG, optionDimensions: [] }).ok).toBe(false);
  });

  it("refuses a missing campaign.productType", () => {
    expect(validateGroupBuyCampaignOptions({ ...VALID_BRACELET_CONFIG, campaign: {} }).ok).toBe(false);
  });
});

describe("isGroupBuyOptionSelectionValid — §11: invalid combinations must not be purchasable", () => {
  const validated = validateGroupBuyCampaignOptions(VALID_BRACELET_CONFIG);
  const config = validated.ok ? validated.value : (undefined as never as GroupBuyCampaignOptions);

  it("a selection matching a declared valid combination exactly is valid", () => {
    expect(isGroupBuyOptionSelectionValid(config, { metal: "gold", length: "6.5in", clasp: "lobster" })).toBe(true);
  });

  it("a selection matching a combination that omits the optional dimension is valid on its own (no clasp key at all)", () => {
    expect(isGroupBuyOptionSelectionValid(config, { metal: "gold", length: "7in" })).toBe(true);
  });

  it("a selection matching NO declared combination is refused — the exact criterion this function exists for", () => {
    expect(isGroupBuyOptionSelectionValid(config, { metal: "gold", length: "7.5in" })).toBe(false);
  });

  it("a selection with an undeclared value is refused", () => {
    expect(isGroupBuyOptionSelectionValid(config, { metal: "silver", length: "7in" })).toBe(false);
  });

  it("a selection that is a superset of a valid combination (extra key) is refused, not guessed as 'close enough'", () => {
    expect(isGroupBuyOptionSelectionValid(config, { metal: "gold", length: "7in", clasp: "box" })).toBe(false);
  });
});

describe("group-buy-options.schema.json — the formal schema artifact (§13)", () => {
  const schemaPath = join(process.cwd(), "app", "domain", "groupbuy", "group-buy-options.schema.json");

  it("is valid, parseable JSON", () => {
    const raw = readFileSync(schemaPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("declares the same top-level required keys the TypeScript contract expects, so the two cannot silently drift apart", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { required: readonly string[] };
    expect(new Set(schema.required)).toEqual(
      new Set(["schemaVersion", "campaign", "optionDimensions", "validCombinations", "tableView", "orderingFlow"])
    );
  });

  it("closes every object with additionalProperties: false, the schema-level backstop against an unrecognised (e.g. pricing) key", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    function collectObjectSchemas(node: unknown, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        const obj = node as Record<string, unknown>;
        if (obj.type === "object") acc.push(obj);
        for (const value of Object.values(obj)) collectObjectSchemas(value, acc);
      }
      return acc;
    }
    const objectSchemas = collectObjectSchemas(schema);
    expect(objectSchemas.length).toBeGreaterThan(0);
    for (const objectSchema of objectSchemas) {
      // The one intentional exception: validCombinations[].values is an
      // open map keyed by campaign-chosen dimension keys — see the schema's
      // own description for why a closed shape there would be wrong.
      if (objectSchema.additionalProperties && typeof objectSchema.additionalProperties === "object") continue;
      expect(objectSchema.additionalProperties).toBe(false);
    }
  });
});
