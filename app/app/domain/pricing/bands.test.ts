import { describe, expect, it } from "vitest";

import {
  enumerateBandSizes,
  selectBandPrice,
  validateBandCoverage,
} from "./bands";
import type { BandSpec, SizeSpec } from "./types";

/**
 * CRITERION 11, 12 and CRITERION 35 — Ring-size bands (spec §5.7).
 * `selectBandPrice` tested against a three-line stub (criterion 35).
 */

describe("validateBandCoverage", () => {
  const sizeSpec: SizeSpec = {
    sizeAxis: "ring_size_us",
    allowedSizeMin: "2",
    allowedSizeMax: "11",
    sizeIncrement: "0.5",
    baseSize: "6",
  };

  it("accepts bands covering the range without gaps or overlaps (criterion 12)", () => {
    const bands: BandSpec[] = [
      { label: "Small", sizeMin: "2", sizeMax: "6" },
      { label: "Medium", sizeMin: "6.5", sizeMax: "8" },
      { label: "Large", sizeMin: "8.5", sizeMax: "11" },
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).not.toThrow();
  });

  it("rejects bands with a gap (criterion 12)", () => {
    const bands: BandSpec[] = [
      { label: "Small", sizeMin: "2", sizeMax: "6" },
      { label: "Medium", sizeMin: "7", sizeMax: "11" }, // Gap at 6.5
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).toThrow(/gap|overlap/);
  });

  it("rejects bands with an overlap (criterion 12)", () => {
    const bands: BandSpec[] = [
      { label: "Small", sizeMin: "2", sizeMax: "6.5" },
      { label: "Medium", sizeMin: "6", sizeMax: "11" }, // Overlaps at 6–6.5
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).toThrow(/gap|overlap/);
  });

  it("rejects when first band does not start at minimum", () => {
    const bands: BandSpec[] = [
      { label: "Small", sizeMin: "2.5", sizeMax: "11" },
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).toThrow(/must start/);
  });

  it("rejects when last band does not end at maximum", () => {
    const bands: BandSpec[] = [
      { label: "Small", sizeMin: "2", sizeMax: "10.5" },
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).toThrow(/must end/);
  });

  it("rejects when sizeMin > sizeMax", () => {
    const bands: BandSpec[] = [
      { label: "Bad", sizeMin: "6", sizeMax: "2" },
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).toThrow(/exceeds/);
  });

  it("rejects empty band list", () => {
    expect(() => validateBandCoverage([], sizeSpec)).toThrow(/at least one band/);
  });

  it("accepts single band covering entire range", () => {
    const bands: BandSpec[] = [
      { label: "One", sizeMin: "2", sizeMax: "11" },
    ];
    expect(() => validateBandCoverage(bands, sizeSpec)).not.toThrow();
  });

  it("reorders bands by size before validating", () => {
    const bands: BandSpec[] = [
      { label: "Large", sizeMin: "8.5", sizeMax: "11" },
      { label: "Small", sizeMin: "2", sizeMax: "6" },
      { label: "Medium", sizeMin: "6.5", sizeMax: "8" },
    ];
    // Should not throw despite non-sorted input
    expect(() => validateBandCoverage(bands, sizeSpec)).not.toThrow();
  });
});

describe("enumerateBandSizes", () => {
  const sizeSpec: SizeSpec = {
    sizeAxis: "ring_size_us",
    allowedSizeMin: "2",
    allowedSizeMax: "11",
    sizeIncrement: "0.5",
    baseSize: "6",
  };

  it("enumerates all sizes in a band on the increment grid", () => {
    const band: BandSpec = { label: "Test", sizeMin: "2", sizeMax: "3" };
    const sizes = enumerateBandSizes(band, sizeSpec);
    expect(sizes).toEqual(["2", "2.5", "3"]);
  });

  it("enumerates a half-size band", () => {
    const band: BandSpec = { label: "Test", sizeMin: "6.5", sizeMax: "7" };
    const sizes = enumerateBandSizes(band, sizeSpec);
    expect(sizes).toEqual(["6.5", "7"]);
  });

  it("includes minimum and maximum", () => {
    const band: BandSpec = { label: "Test", sizeMin: "2", sizeMax: "11" };
    const sizes = enumerateBandSizes(band, sizeSpec);
    expect(sizes[0]).toBe("2");
    expect(sizes[sizes.length - 1]).toBe("11");
  });

  it("throws InvalidBandError for empty band", () => {
    const emptyBand: BandSpec = { label: "Empty", sizeMin: "5", sizeMax: "4" };
    expect(() => enumerateBandSizes(emptyBand, sizeSpec)).toThrow(/empty|contains no/i);
  });

  it("respects quarter-size increments", () => {
    const quarterSpec: SizeSpec = {
      ...sizeSpec,
      sizeIncrement: "0.25",
    };
    const band: BandSpec = { label: "Test", sizeMin: "6", sizeMax: "6.5" };
    const sizes = enumerateBandSizes(band, quarterSpec);
    expect(sizes).toEqual(["6", "6.25", "6.5"]);
  });
});

describe("selectBandPrice (criterion 35 — tested against a stub priceAtSize)", () => {
  it("selects the maximum price across candidates", () => {
    const candidates = ["6", "6.5", "7", "7.5", "8"];
    // Stub: size 8 is most expensive
    const prices = {
      "6": 100n,
      "6.5": 105n,
      "7": 110n,
      "7.5": 125n, // This one is max
      "8": 120n,
    };
    const stub = (size: string) => ({
      bankPaymentPriceMinorUnits: prices[size as keyof typeof prices]!,
      result: { size },
    });

    const selection = selectBandPrice(candidates, stub);
    expect(selection.bandBankPaymentPriceMinorUnits).toBe(125n);
    expect(selection.costBasisSize).toBe("7.5");
  });

  it("records prices for all sizes", () => {
    const candidates = ["6", "6.5", "7"];
    const stub = (size: string) => ({
      bankPaymentPriceMinorUnits: BigInt(size.replace(".", "") as any),
      result: { size },
    });

    const selection = selectBandPrice(candidates, stub);
    expect(selection.perSize).toHaveLength(3);
    expect(selection.perSize.map((p) => p.size)).toEqual(["6", "6.5", "7"]);
  });

  it("includes the winning result", () => {
    const candidates = ["6"];
    const winningResult = { customData: "winner" };
    const stub = (_size: string) => ({
      bankPaymentPriceMinorUnits: 100n,
      result: winningResult,
    });

    const selection = selectBandPrice(candidates, stub);
    expect(selection.winning).toBe(winningResult);
  });

  it("resolves ties to the smallest size (criterion 11 interior override case)", () => {
    const candidates = ["6.5", "7", "7.5", "8"];
    // Interior size 7.5 is most expensive due to override (the "criterion 11 case")
    // Sizes 6.5 and 7.5 are equally expensive; should pick 6.5 (smallest)
    const prices = {
      "6.5": 130n,
      "7": 120n,
      "7.5": 130n, // Tie with 6.5
      "8": 125n,
    };
    const stub = (size: string) => ({
      bankPaymentPriceMinorUnits: prices[size as keyof typeof prices]!,
      result: { size },
    });

    const selection = selectBandPrice(candidates, stub);
    expect(selection.bandBankPaymentPriceMinorUnits).toBe(130n);
    expect(selection.costBasisSize).toBe("6.5"); // Tie broken to smallest
  });

  it("returns per-size prices as strings", () => {
    const candidates = ["6"];
    const stub = (size: string) => ({
      bankPaymentPriceMinorUnits: 12345n,
      result: { size },
    });

    const selection = selectBandPrice(candidates, stub);
    expect(typeof selection.perSize[0]!.bankPaymentPriceMinorUnits).toBe("string");
    expect(selection.perSize[0]!.bankPaymentPriceMinorUnits).toBe("12345");
  });

  it("handles single-size bands", () => {
    const candidates = ["7"];
    const stub = (size: string) => ({
      bankPaymentPriceMinorUnits: 150n,
      result: { size },
    });

    const selection = selectBandPrice(candidates, stub);
    expect(selection.bandBankPaymentPriceMinorUnits).toBe(150n);
    expect(selection.costBasisSize).toBe("7");
  });

  it("throws InvalidBandError for empty candidate list", () => {
    const stub = (_size: string) => ({
      bankPaymentPriceMinorUnits: 0n,
      result: {},
    });
    expect(() => selectBandPrice([], stub)).toThrow(/no candidate/);
  });

  it("handles interior override making an interior size the most expensive (criterion 11)", () => {
    // The key test case: without evaluating every size, a band.sizeMax shortcut
    // would incorrectly pick size 8, but the true maximum is at interior size 7.5
    // due to an exact weight override making it heavier than the model predicts.
    const candidates = ["6.5", "7", "7.5", "8"];
    // Model says: weight increases with size, so 8 is most expensive
    // But override at 7.5 makes it very heavy
    const prices = {
      "6.5": 10000n,
      "7": 10500n,
      "7.5": 10800n, // Override here makes this the max, not 8
      "8": 10700n, // Model fallback: 8 would be max if no override
    };
    const stub = (size: string) => ({
      bankPaymentPriceMinorUnits: prices[size as keyof typeof prices]!,
      result: { size, price: prices[size as keyof typeof prices] },
    });

    const selection = selectBandPrice(candidates, stub);
    // Must be 7.5, not 8
    expect(selection.bandBankPaymentPriceMinorUnits).toBe(10800n);
    expect(selection.costBasisSize).toBe("7.5");
    // The winning result should include the 7.5 data
    expect((selection.winning as any).size).toBe("7.5");
  });
});
