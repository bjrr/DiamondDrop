import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { InvalidSizeError, InvalidWeightError } from "./errors";
import { calculateWeightGrams, validateSize } from "./weight";
import type { SizeSpec, WeightSpec } from "./types";

/**
 * CRITERION 9, 10 — Weight calculations and validation (spec §5.1).
 * Pure unit tests; no database or clock.
 */

describe("validateSize", () => {
  const ringSpec: SizeSpec = {
    sizeAxis: "ring_size_us",
    allowedSizeMin: "2",
    allowedSizeMax: "11",
    sizeIncrement: "0.5",
    baseSize: "6",
  };

  it("passes for a size at the minimum", () => {
    expect(() => validateSize(ringSpec, "2")).not.toThrow();
  });

  it("passes for a size at the maximum", () => {
    expect(() => validateSize(ringSpec, "11")).not.toThrow();
  });

  it("passes for a size on the increment grid", () => {
    expect(() => validateSize(ringSpec, "6.5")).not.toThrow();
    expect(() => validateSize(ringSpec, "7.5")).not.toThrow();
  });

  it("passes for a quarter size on a quarter-increment product", () => {
    // Quarter sizes are only valid where the PRODUCT offers them. With a 0.5
    // increment, 2.25 is off-grid and validateSize is correct to reject it.
    const quarterSpec: SizeSpec = { ...ringSpec, sizeIncrement: "0.25" };
    expect(() => validateSize(quarterSpec, "2.25")).not.toThrow();
    expect(() => validateSize(quarterSpec, "2.75")).not.toThrow();
    expect(() => validateSize(ringSpec, "2.25")).toThrow(InvalidSizeError);
  });

  it("rejects a size below the minimum", () => {
    expect(() => validateSize(ringSpec, "1.5")).toThrow(InvalidSizeError);
  });

  it("rejects a size above the maximum", () => {
    expect(() => validateSize(ringSpec, "11.5")).toThrow(InvalidSizeError);
  });

  it("rejects a size not on the increment grid", () => {
    expect(() => validateSize(ringSpec, "6.3")).toThrow(InvalidSizeError);
  });

  it("rejects a size with too fine a granularity", () => {
    expect(() => validateSize(ringSpec, "6.51")).toThrow(InvalidSizeError);
  });

  it("skips validation when sizeAxis is 'none'", () => {
    const noSizeSpec: SizeSpec = {
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
    };
    expect(() => validateSize(noSizeSpec, "999")).not.toThrow();
  });

  it("validates inch-based sizes the same way", () => {
    const inchSpec: SizeSpec = {
      sizeAxis: "length_inches",
      allowedSizeMin: "16",
      allowedSizeMax: "24",
      sizeIncrement: "0.5",
      baseSize: "18",
    };
    expect(() => validateSize(inchSpec, "18.5")).not.toThrow();
    expect(() => validateSize(inchSpec, "18.3")).toThrow(InvalidSizeError);
  });
});

describe("calculateWeightGrams", () => {
  const baseSpec: WeightSpec = {
    sizeAxis: "ring_size_us",
    allowedSizeMin: "2",
    allowedSizeMax: "11",
    sizeIncrement: "0.5",
    baseSize: "6",
    baseWeightGrams: "3.2000",
    weightPerFullSizeGrams: "0.1500",
  };

  it("matches at base size (criterion 9)", () => {
    const weight = calculateWeightGrams(baseSpec, "6");
    // 3.2000 + (6 - 6) * 0.1500 = 3.2000
    expect(weight).toBe("3.2");
  });

  it("matches above base size (criterion 9)", () => {
    const weight = calculateWeightGrams(baseSpec, "8");
    // 3.2000 + (8 - 6) * 0.1500 = 3.2000 + 0.3000 = 3.5000
    expect(weight).toBe("3.5");
  });

  it("matches below base size (criterion 9)", () => {
    const weight = calculateWeightGrams(baseSpec, "4");
    // 3.2000 + (4 - 6) * 0.1500 = 3.2000 - 0.3000 = 2.9000
    expect(weight).toBe("2.9");
  });

  it("matches at a half size (criterion 9)", () => {
    const weight = calculateWeightGrams(baseSpec, "6.5");
    // 3.2000 + (6.5 - 6) * 0.1500 = 3.2000 + 0.0750 = 3.2750
    expect(weight).toBe("3.275");
  });

  it("matches at a quarter size (criterion 9)", () => {
    const quarterSpec = { ...baseSpec, sizeIncrement: "0.25" };
    const weight = calculateWeightGrams(quarterSpec, "6.25");
    // 3.2000 + (6.25 - 6) * 0.1500 = 3.2000 + 0.0375 = 3.2375
    expect(weight).toBe("3.2375");
  });

  it("is exact to 4 decimal places (criterion 9)", () => {
    const weight = calculateWeightGrams(baseSpec, "7");
    // Criterion 9 requires accuracy to 4 dp, not a fixed-width format.
    // decimal.js drops trailing zeros, so assert the VALUE: 3.35 equals 3.3500
    // to 4 dp. Asserting the string shape would test a serialization choice
    // rather than the R8 weight rule.
    expect(new MoneyDecimal(weight).toDecimalPlaces(4).equals(new MoneyDecimal("3.3500"))).toBe(true);
  });

  it("exact override takes precedence (criterion 10)", () => {
    const specWithOverride: WeightSpec = {
      ...baseSpec,
      overrides: {
        "7": "3.7500", // Manual measurement overrides the linear model
      },
    };
    const weight = calculateWeightGrams(specWithOverride, "7");
    expect(weight).toBe("3.75");
  });

  it("override at interior size can differ from model (criterion 10)", () => {
    const modelWeight = calculateWeightGrams(baseSpec, "7");
    const specWithOverride: WeightSpec = {
      ...baseSpec,
      overrides: {
        "7": "3.9000", // Heavier than model predicts
      },
    };
    const overrideWeight = calculateWeightGrams(specWithOverride, "7");
    expect(overrideWeight).not.toBe(modelWeight);
    expect(overrideWeight).toBe("3.9");
  });

  it("out-of-range size throws InvalidSizeError (criterion 10)", () => {
    expect(() => calculateWeightGrams(baseSpec, "0.5")).toThrow(InvalidSizeError);
    expect(() => calculateWeightGrams(baseSpec, "12")).toThrow(InvalidSizeError);
  });

  it("off-increment size throws InvalidSizeError (criterion 10)", () => {
    expect(() => calculateWeightGrams(baseSpec, "6.3")).toThrow(InvalidSizeError);
  });

  it("weight ≤ 0 throws InvalidWeightError (criterion 10)", () => {
    const lightSpec: WeightSpec = {
      ...baseSpec,
      baseWeightGrams: "0.1",
      weightPerFullSizeGrams: "-0.1",
    };
    // Size must be ABOVE base for a negative per-size delta to drive the
    // weight non-positive: 0.1 + (11 - 6) x -0.1 = -0.4. At size 2 the same
    // spec yields +0.5, which is correctly NOT an error.
    expect(() => calculateWeightGrams(lightSpec, "11")).toThrow(InvalidWeightError);
    expect(calculateWeightGrams(lightSpec, "2")).toBe("0.5");
  });

  it("zero weight throws InvalidWeightError (criterion 10)", () => {
    const zeroSpec: WeightSpec = {
      ...baseSpec,
      baseWeightGrams: "0",
    };
    expect(() => calculateWeightGrams(zeroSpec, "6")).toThrow(InvalidWeightError);
  });

  it("returns weight as a string, never a number", () => {
    const weight = calculateWeightGrams(baseSpec, "6");
    expect(typeof weight).toBe("string");
  });

  it("sizeAxis='none' returns base weight regardless of size", () => {
    const noSizeSpec: WeightSpec = {
      ...baseSpec,
      sizeAxis: "none",
    };
    const weight = calculateWeightGrams(noSizeSpec, "999");
    expect(weight).toBe("3.2");
  });

  it("preserves precision through calculation", () => {
    // Test a case with many decimal places
    const preciseSpec: WeightSpec = {
      ...baseSpec,
      baseWeightGrams: "3.1415",
      weightPerFullSizeGrams: "0.1618",
    };
    const weight = calculateWeightGrams(preciseSpec, "7");
    // 3.1415 + (7-6) * 0.1618 = 3.1415 + 0.1618 = 3.3033
    const expected = new MoneyDecimal("3.1415")
      .plus(new MoneyDecimal("7").minus("6").times("0.1618"))
      .toString();
    expect(weight).toBe(expected);
  });
});
