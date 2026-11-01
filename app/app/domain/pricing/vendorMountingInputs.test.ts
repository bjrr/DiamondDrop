/**
 * Projecting Shopify's structured fields into pricing inputs.
 *
 * Owner decision 2026-11-01: Shopify is the operational source of truth for a
 * George's mounting, so these are the only inputs a price may be built from.
 *
 * Most of this file is about REFUSING. Every missing field has a tempting
 * default that produces a confidently wrong price and fails nothing, so the
 * tests exercise each absence individually and then all at once.
 */
import { describe, expect, it } from "vitest";

import { computeMountingPrice } from "./mountingPricing";
import {
  vendorMountingInputs,
  type ShopifyMountingPricingFields,
} from "./vendorMountingInputs";

/** The real pilot's Shopify data, 9x7 configuration. */
const PILOT: ShopifyMountingPricingFields = {
  unitCostAmount: "242.00",
  unitCostCurrency: "USD",
  defaultRingSize: "6.5",
  largeStoneSettingCount: "1",
  bandPaveDiamondCount: "0",
  hiddenHalo: "false",
};

function spec(overrides: Partial<ShopifyMountingPricingFields> = {}) {
  const r = vendorMountingInputs({ ...PILOT, ...overrides });
  return r.ok ? r.spec : null;
}
function reasons(overrides: Partial<ShopifyMountingPricingFields> = {}) {
  const r = vendorMountingInputs({ ...PILOT, ...overrides });
  return r.ok ? [] : r.reasons;
}

describe("the pilot's Shopify data becomes a priceable spec", () => {
  it("projects every field", () => {
    expect(spec()).toEqual({
      vendorCost: { amountMinorUnits: "24200", currency: "USD" },
      largeStoneCount: 1,
      bandPaveDiamondCount: 0,
      hasHiddenHalo: false,
      baseRingSize: "6.5",
    });
  });

  it("prices to the figure already published", () => {
    // The end-to-end check that the projection and the rules agree: $242
      // x 1.75 + $70 = $493.50 at the base size.
    const s = spec()!;
    expect(computeMountingPrice(s, "6.5").bankPaymentPrice.amountMinorUnits).toBe("49350");
    expect(computeMountingPrice(s, "6").bankPaymentPrice.amountMinorUnits).toBe("51850");
    expect(computeMountingPrice(s, "7").bankPaymentPrice.amountMinorUnits).toBe("53350");
  });

  it("converts the cost to minor units exactly", () => {
    expect(spec({ unitCostAmount: "191" })?.vendorCost.amountMinorUnits).toBe("19100");
    expect(spec({ unitCostAmount: "191.0" })?.vendorCost.amountMinorUnits).toBe("19100");
    expect(spec({ unitCostAmount: "346.00" })?.vendorCost.amountMinorUnits).toBe("34600");
    expect(spec({ unitCostAmount: "0.01" })?.vendorCost.amountMinorUnits).toBe("1");
  });

  it("accepts equivalent spellings of the base size", () => {
    expect(spec({ defaultRingSize: "6.5" })?.baseRingSize).toBe("6.5");
    expect(spec({ defaultRingSize: "6.50" })?.baseRingSize).toBe("6.5");
    expect(spec({ defaultRingSize: "7" })?.baseRingSize).toBe("7");
    expect(spec({ defaultRingSize: "7.0" })?.baseRingSize).toBe("7");
    expect(spec({ defaultRingSize: "11" })?.baseRingSize).toBe("11");
  });
});

describe("a zero is a fact; an absence is not", () => {
  it("accepts a confirmed zero band-pave count", () => {
    expect(spec({ bandPaveDiamondCount: "0" })?.bandPaveDiamondCount).toBe(0);
  });

  it("accepts a confirmed zero large-stone count", () => {
    // A mounting where CaratForUs sets nothing is legitimate.
    expect(spec({ largeStoneSettingCount: "0" })?.largeStoneCount).toBe(0);
  });

  it("refuses an absent band-pave count", () => {
    expect(spec({ bandPaveDiamondCount: null })).toBeNull();
    expect(reasons({ bandPaveDiamondCount: null })[0]).toMatch(/not established/);
    expect(reasons({ bandPaveDiamondCount: "" })[0]).toMatch(/not established/);
  });

  it("refuses an absent hidden-halo flag rather than assuming no halo", () => {
    expect(spec({ hiddenHalo: null })).toBeNull();
    expect(reasons({ hiddenHalo: null })[0]).toMatch(/under-prices the mounting by \$100/);
  });

  it("refuses an absent large-stone count rather than assuming one", () => {
    expect(spec({ largeStoneSettingCount: null })).toBeNull();
    expect(reasons({ largeStoneSettingCount: null })[0]).toMatch(/\$70 per stone wrong/);
  });
});

describe("supplier cost", () => {
  it("refuses an unset cost", () => {
    expect(spec({ unitCostAmount: null })).toBeNull();
    expect(reasons({ unitCostAmount: null })[0]).toMatch(/must hold George's actual cost/);
  });

  it("refuses a zero cost, which would price the fees alone", () => {
    expect(spec({ unitCostAmount: "0" })).toBeNull();
    expect(reasons({ unitCostAmount: "0.00" })[0]).toMatch(/priced at the setting fees alone/);
  });

  it("refuses a cost that is not a plain money amount", () => {
    expect(spec({ unitCostAmount: "242.005" })).toBeNull();
    expect(spec({ unitCostAmount: "1e5" })).toBeNull();
    expect(spec({ unitCostAmount: "-242" })).toBeNull();
    expect(spec({ unitCostAmount: "$242" })).toBeNull();
  });

  it("refuses a cost with no currency", () => {
    expect(spec({ unitCostCurrency: null })).toBeNull();
    expect(reasons({ unitCostCurrency: "" })[0]).toMatch(/no currency/);
  });
});

describe("base ring size", () => {
  it("refuses when unset, naming the import step", () => {
    expect(spec({ defaultRingSize: null })).toBeNull();
    expect(reasons({ defaultRingSize: null })[0]).toMatch(/read it from the vendor title at import/);
  });

  it("refuses a size finer than a half step", () => {
    expect(spec({ defaultRingSize: "6.25" })).toBeNull();
    expect(spec({ defaultRingSize: "6.7" })).toBeNull();
  });

  it("refuses a size outside 1 to 11", () => {
    expect(spec({ defaultRingSize: "12" })).toBeNull();
    expect(spec({ defaultRingSize: "0.5" })).toBeNull();
    expect(reasons({ defaultRingSize: "12" })[0]).toMatch(/between 1 and 11/);
  });

  it("accepts a base above 8, which always gets +$0", () => {
    const s = spec({ defaultRingSize: "9" })!;
    expect(s.baseRingSize).toBe("9");
    expect(computeMountingPrice(s, "9").breakdown.ringSizeAdjustmentMinorUnits).toBe(0n);
  });
});

describe("counts must be whole", () => {
  it("refuses a fractional or signed count", () => {
    expect(spec({ largeStoneSettingCount: "1.5" })).toBeNull();
    expect(spec({ bandPaveDiamondCount: "-1" })).toBeNull();
    expect(spec({ largeStoneSettingCount: "one" })).toBeNull();
  });
});

describe("the hidden-halo flag is read strictly", () => {
  it("reads Shopify's string booleans", () => {
    expect(spec({ hiddenHalo: "true" })?.hasHiddenHalo).toBe(true);
    expect(spec({ hiddenHalo: "false" })?.hasHiddenHalo).toBe(false);
  });

  it("refuses anything else rather than coercing it", () => {
    // "0", "no" and "" are all falsy in JavaScript and none of them is a
    // vendor statement. Coercing them would silently drop $100.
    for (const v of ["0", "1", "no", "yes", "TRUE", "False"]) {
      expect(spec({ hiddenHalo: v })).toBeNull();
    }
  });
});

describe("it reports every problem at once", () => {
  it("lists all missing fields together", () => {
    const all = reasons({
      unitCostAmount: null,
      defaultRingSize: null,
      largeStoneSettingCount: null,
      bandPaveDiamondCount: null,
      hiddenHalo: null,
    });
    expect(all).toHaveLength(5);
    expect(all.join(" ")).toMatch(/unitCost/);
    expect(all.join(" ")).toMatch(/default_ring_size/);
    expect(all.join(" ")).toMatch(/large_stone_setting_count/);
    expect(all.join(" ")).toMatch(/band_pave_diamond_count/);
    expect(all.join(" ")).toMatch(/hidden_halo/);
  });

  it("names the Shopify field in every reason, so staff know where to go", () => {
    for (const override of [
      { unitCostAmount: null },
      { defaultRingSize: null },
      { largeStoneSettingCount: null },
      { bandPaveDiamondCount: null },
      { hiddenHalo: null },
    ] as Partial<ShopifyMountingPricingFields>[]) {
      const r = reasons(override);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatch(/carat\.\w+|inventoryItem\.unitCost/);
    }
  });
});

describe("compatibility data has no pricing meaning", () => {
  it("accepts only the six pricing fields", () => {
    // The type is the fence: there is nowhere to put a vendor min/max, a
    // nominal centre size, a shape or a prong flag, so none of them can reach
    // a price even by accident.
    const keys = Object.keys(PILOT).sort();
    expect(keys).toEqual([
      "bandPaveDiamondCount",
      "defaultRingSize",
      "hiddenHalo",
      "largeStoneSettingCount",
      "unitCostAmount",
      "unitCostCurrency",
    ]);
  });
});
