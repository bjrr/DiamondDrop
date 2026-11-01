/**
 * Vendor-mounting pricing, owner-locked 2026-11-01.
 *
 * These are money rules on a product that is live and purchasable, so the
 * tests state the owner's figures literally rather than recomputing them from
 * the constants — a test that re-derives the expected value from the same
 * constant it is checking passes even when the constant is wrong.
 *
 * The headline case is the real pilot, whose prices were wrong in production:
 * the size adjustment had been folded into COST and multiplied by 1.75, which
 * made ring size 6.5 cheaper than size 6 by $43.75 (= $25 x 1.75).
 */
import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import {
  MOUNTING_PRICING_RULE_ID,
  RingSizeNotSupportedError,
  VendorSpecificationMissingError,
  computeMountingPrice,
  ringSizeAdjustment,
  type MountingSpec,
} from "./mountingPricing";

function usd(minorUnits: string) {
  return { amountMinorUnits: minorUnits, currency: "USD" };
}

/** The real pilot: George's "14K Pear Solitaire — Ultra Light Tulip (Size 6.5)". */
const PILOT_9X7: MountingSpec = {
  vendorCost: usd("24200"),
  largeStoneCount: 1,
  bandPaveDiamondCount: 0,
  hasHiddenHalo: false,
  baseRingSize: "6.5",
};

function bank(spec: MountingSpec, size: string) {
  return computeMountingPrice(spec, size).bankPaymentPrice.amountMinorUnits;
}
function card(spec: MountingSpec, size: string) {
  return computeMountingPrice(spec, size).regularCardPrice.amountMinorUnits;
}

describe("the pilot: 9x7 pear solitaire, vendor cost $242, base size 6.5", () => {
  it("prices the base size at cost x 1.75 + $70", () => {
    // 242.00 x 1.75 = 423.50; + 70.00 = 493.50
    expect(bank(PILOT_9X7, "6.5")).toBe("49350");
  });

  it("adds $25 flat below the base size", () => {
    expect(bank(PILOT_9X7, "6")).toBe("51850");
  });

  it("adds $40 flat above the base size, through 8", () => {
    expect(bank(PILOT_9X7, "7")).toBe("53350");
    expect(bank(PILOT_9X7, "7.5")).toBe("53350");
    expect(bank(PILOT_9X7, "8")).toBe("53350");
  });

  it("never prices a larger size below a smaller one", () => {
    // The production defect, stated as a property. Size 6.5 was $43.75 under
    // size 6 because the $25 adjustment had been multiplied by the markup.
    const six = BigInt(bank(PILOT_9X7, "6"));
    const sixHalf = BigInt(bank(PILOT_9X7, "6.5"));
    const seven = BigInt(bank(PILOT_9X7, "7"));
    expect(sixHalf).toBeLessThan(six);
    expect(six).toBeLessThan(seven);
  });

  it("derives the card price through the shared locked rule", () => {
    expect(card(PILOT_9X7, "6.5")).toBe("52000"); // 493.50 x 1.05 -> ceil $5
    expect(card(PILOT_9X7, "6")).toBe("54500"); // 518.50 x 1.045 -> ceil $5
    expect(card(PILOT_9X7, "7")).toBe("56000"); // 533.50 x 1.045 -> ceil $5
  });

  it("reports savings measured after the $5 ceiling, not from the percentage", () => {
    const r = computeMountingPrice(PILOT_9X7, "6.5");
    expect(r.bankPaymentSavings.amountMinorUnits).toBe("2650");
    expect(
      BigInt(r.regularCardPrice.amountMinorUnits) - BigInt(r.bankPaymentPrice.amountMinorUnits)
    ).toBe(2650n);
  });

  it("stamps the versioned rule id", () => {
    expect(computeMountingPrice(PILOT_9X7, "6.5").ruleId).toBe("VENDOR_MOUNTING_MARKUP_175_V1");
    expect(MOUNTING_PRICING_RULE_ID).toBe("VENDOR_MOUNTING_MARKUP_175_V1");
  });
});

describe("ring-size adjustment", () => {
  it("is +$0 at the vendor's base size", () => {
    expect(ringSizeAdjustment("7", "7").minorUnits).toBe(0n);
  });

  it("is $25 FLAT below the base, not $25 per half size", () => {
    expect(ringSizeAdjustment("6.5", "7").minorUnits).toBe(2500n);
    expect(ringSizeAdjustment("6", "7").minorUnits).toBe(2500n);
    expect(ringSizeAdjustment("4", "7").minorUnits).toBe(2500n);
  });

  it("is $40 flat above the base through size 8", () => {
    expect(ringSizeAdjustment("7.5", "7").minorUnits).toBe(4000n);
    expect(ringSizeAdjustment("8", "7").minorUnits).toBe(4000n);
  });

  it("is $100 above size 8, and NOT cumulative with the $40", () => {
    expect(ringSizeAdjustment("8.5", "7").minorUnits).toBe(10000n);
    expect(ringSizeAdjustment("9", "7").minorUnits).toBe(10000n);
    expect(ringSizeAdjustment("11", "7").minorUnits).toBe(10000n);
    // 140 would be the cumulative reading the owner ruled out.
    expect(ringSizeAdjustment("8.5", "7").minorUnits).not.toBe(14000n);
  });

  it("refuses sizes above 11", () => {
    expect(() => ringSizeAdjustment("11.5", "7")).toThrow(RingSizeNotSupportedError);
    expect(() => ringSizeAdjustment("12", "7")).toThrow(/maximum supported size of 11/);
  });

  describe("when the vendor's base size is itself above 8", () => {
    // The title-defined default always wins over the size number.
    it("charges nothing at the base size, even though it is above 8", () => {
      expect(ringSizeAdjustment("9", "9").minorUnits).toBe(0n);
    });

    it("treats smaller sizes as below the base, at $25", () => {
      expect(ringSizeAdjustment("8", "9").minorUnits).toBe(2500n);
      expect(ringSizeAdjustment("8.5", "9").minorUnits).toBe(2500n);
      expect(ringSizeAdjustment("6", "9").minorUnits).toBe(2500n);
    });

    it("charges $100 above the base, since those sizes exceed 8", () => {
      expect(ringSizeAdjustment("9.5", "9").minorUnits).toBe(10000n);
      expect(ringSizeAdjustment("11", "9").minorUnits).toBe(10000n);
    });
  });

  it("explains itself for admin surfaces", () => {
    expect(ringSizeAdjustment("6", "6.5").reason).toMatch(/below base size 6\.5/);
    expect(ringSizeAdjustment("6.5", "6.5").reason).toMatch(/base size 6\.5 from the vendor title/);
  });
});

describe("large-stone setting fee", () => {
  const base = { ...PILOT_9X7, vendorCost: usd("10000") };

  it("is $70 for a solitaire", () => {
    // 100.00 x 1.75 = 175.00; + 70.00 = 245.00
    expect(bank({ ...base, largeStoneCount: 1 }, "6.5")).toBe("24500");
  });

  it("is $210 for a three-stone", () => {
    expect(bank({ ...base, largeStoneCount: 3 }, "6.5")).toBe("38500");
  });

  it("is $350 for a five-stone", () => {
    expect(bank({ ...base, largeStoneCount: 5 }, "6.5")).toBe("52500");
  });

  it("is nothing when CaratForUs sets no large stone", () => {
    expect(bank({ ...base, largeStoneCount: 0 }, "6.5")).toBe("17500");
  });
});

describe("band pave diamonds", () => {
  const base = { ...PILOT_9X7, vendorCost: usd("10000"), largeStoneCount: 1 };

  it("charges $10 per confirmed diamond", () => {
    // 245.00 + 20 x 10.00 = 445.00
    expect(bank({ ...base, bandPaveDiamondCount: 20 }, "6.5")).toBe("44500");
  });

  it("charges nothing on a plain band", () => {
    expect(bank({ ...base, bandPaveDiamondCount: 0 }, "6.5")).toBe("24500");
  });

  it("REFUSES to price when the vendor did not state the count", () => {
    // Defaulting to zero would under-price every pave mounting, and the result
    // would be indistinguishable from a correctly priced plain band.
    expect(() => computeMountingPrice({ ...base, bandPaveDiamondCount: null }, "6.5")).toThrow(
      VendorSpecificationMissingError
    );
    expect(() => computeMountingPrice({ ...base, bandPaveDiamondCount: null }, "6.5")).toThrow(
      /Flag for review/
    );
  });

  it("refuses a fractional or negative count", () => {
    expect(() => computeMountingPrice({ ...base, bandPaveDiamondCount: 2.5 }, "6.5")).toThrow(
      VendorSpecificationMissingError
    );
    expect(() => computeMountingPrice({ ...base, bandPaveDiamondCount: -1 }, "6.5")).toThrow(
      VendorSpecificationMissingError
    );
  });
});

describe("hidden halo", () => {
  const base = { ...PILOT_9X7, vendorCost: usd("10000") };

  it("is $100 flat when present", () => {
    expect(bank({ ...base, hasHiddenHalo: true }, "6.5")).toBe("34500");
  });

  it("is nothing when absent", () => {
    expect(bank({ ...base, hasHiddenHalo: false }, "6.5")).toBe("24500");
  });

  it("is flat, NOT per hidden-halo diamond", () => {
    // Charging the $10 band rate for hidden-halo stones is the mistake this
    // pins: a 16-stone hidden halo is $100, not $160, and the band count is
    // unaffected by it.
    const withHalo = bank({ ...base, hasHiddenHalo: true, bandPaveDiamondCount: 0 }, "6.5");
    expect(withHalo).toBe("34500");
  });

  it("stacks with band pave, which is a separate charge", () => {
    expect(bank({ ...base, hasHiddenHalo: true, bandPaveDiamondCount: 12 }, "6.5")).toBe("46500");
  });
});

describe("the fees land AFTER the markup, never before it", () => {
  it("does not multiply the ring-size adjustment by 1.75", () => {
    const atBase = BigInt(bank(PILOT_9X7, "6.5"));
    const below = BigInt(bank(PILOT_9X7, "6"));
    // Exactly $25. $43.75 is the production defect — $25 pushed through cost.
    expect(below - atBase).toBe(2500n);
  });

  it("does not multiply the large-stone fee by 1.75", () => {
    const one = BigInt(bank({ ...PILOT_9X7, largeStoneCount: 1 }, "6.5"));
    const two = BigInt(bank({ ...PILOT_9X7, largeStoneCount: 2 }, "6.5"));
    expect(two - one).toBe(7000n);
  });

  it("does not multiply the hidden-halo fee by 1.75", () => {
    const without = BigInt(bank(PILOT_9X7, "6.5"));
    const with_ = BigInt(bank({ ...PILOT_9X7, hasHiddenHalo: true }, "6.5"));
    expect(with_ - without).toBe(10000n);
  });

  it("records the exact unrounded markup for audit", () => {
    const r = computeMountingPrice(PILOT_9X7, "6.5");
    expect(r.breakdown.markedUpExactMinorUnits).toBe("42350");
    expect(r.breakdown.markupRate).toBe("0.75");
    expect(r.breakdown.vendorCostMinorUnits).toBe(24200n);
    expect(r.breakdown.largeStoneFeeMinorUnits).toBe(7000n);
    expect(r.breakdown.ringSizeAdjustmentMinorUnits).toBe(0n);
  });
});

describe("card-price derivation uses the shared tiers, selected from the BANK price", () => {
  it("matches the owner's worked example at $820", () => {
    // 820 x 1.045 = 856.90 -> $860. Reached by choosing a vendor cost that
    // lands the bank price exactly on 820: (820 - 70) / 1.75 = 428.571428...
    // so the fee is adjusted instead, keeping the arithmetic exact.
    const spec: MountingSpec = {
      vendorCost: usd("42857"),
      largeStoneCount: 0,
      bandPaveDiamondCount: 0,
      hasHiddenHalo: false,
      baseRingSize: "7",
    };
    const r = computeMountingPrice(spec, "7");
    // 428.57 x 1.75 = 750.00 (exactly, 42857 x 1.75 = 74999.75 -> 75000)
    expect(r.bankPaymentPrice.amountMinorUnits).toBe("75000");
    expect(r.appliedCardUpliftTierLabel).toBe("$500–$999.99");
  });

  it("picks the tier from the bank price even when the card price crosses a boundary", () => {
    // A $990 bank price stays in the 4.5% band although its card price exceeds
    // $1,000 — the rule must not read its own output.
    const spec: MountingSpec = {
      vendorCost: usd("52571"),
      largeStoneCount: 1,
      bandPaveDiamondCount: 0,
      hasHiddenHalo: false,
      baseRingSize: "7",
    };
    const r = computeMountingPrice(spec, "7");
    expect(r.appliedCardUpliftRate).toBe("0.045000");
    expect(BigInt(r.regularCardPrice.amountMinorUnits)).toBeGreaterThan(100000n);
  });

  it("uses the under-$500 tier just below the boundary", () => {
    const r = computeMountingPrice(PILOT_9X7, "6.5");
    expect(r.bankPaymentPrice.amountMinorUnits).toBe("49350");
    expect(r.appliedCardUpliftRate).toBe("0.050000");
    expect(r.appliedCardUpliftTierLabel).toBe("Under $500");
  });

  it("always rounds the card price UP to a $5 multiple, and never the bank price", () => {
    for (const size of ["6", "6.5", "7", "7.5", "8"]) {
      const r = computeMountingPrice(PILOT_9X7, size);
      expect(BigInt(r.regularCardPrice.amountMinorUnits) % 500n).toBe(0n);
      expect(BigInt(r.regularCardPrice.amountMinorUnits)).toBeGreaterThanOrEqual(
        BigInt(r.bankPaymentPrice.amountMinorUnits)
      );
    }
    // The bank price keeps its cents; it is not nudged onto a $5 boundary.
    expect(BigInt(bank(PILOT_9X7, "6.5")) % 500n).not.toBe(0n);
  });

  it("never applies less than the 3% floor", () => {
    const r = computeMountingPrice({ ...PILOT_9X7, vendorCost: usd("1000000") }, "6.5");
    // Compared as an exact decimal rather than coerced to a float: the
    // money-safety check forbids a float path on a rate for the same reason it
    // does on an amount.
    expect(new MoneyDecimal(r.appliedCardUpliftRate).greaterThanOrEqualTo("0.03")).toBe(true);
  });
});

describe("money representation", () => {
  it("keeps a high-value mounting exact to the cent", () => {
    // 123456.78 x 1.75 = 216049.365 -> half-up at the single boundary.
    const r = computeMountingPrice({ ...PILOT_9X7, vendorCost: usd("12345678") }, "6.5");
    expect(r.breakdown.markedUpExactMinorUnits).toBe("21604936.5");
    expect(r.bankPaymentPrice.amountMinorUnits).toBe("21611937");
  });

  it("carries the currency through from the vendor cost", () => {
    expect(computeMountingPrice(PILOT_9X7, "6.5").currency).toBe("USD");
    expect(computeMountingPrice(PILOT_9X7, "6.5").bankPaymentPrice.currency).toBe("USD");
  });
});
