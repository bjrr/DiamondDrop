import { describe, expect, it } from "vitest";

import {
  minorUnitsToDisplayAmount,
  rateToPercentDisplay,
  validatePricingProfileSettings,
} from "./profileSettings";

/**
 * Validation for operator-entered pricing settings.
 *
 * These matter more than most validation tests because the database guard
 * that appears to cover these fields does not: the
 * `pricing_profile_min_margin_le_target` CHECK compares against
 * `target_gross_margin_rate`, which is NULL under `MARKUP_ON_COST_V1`, and a
 * CHECK passes on NULL. For every profile this business actually uses, the
 * assertions below are the only thing standing between a typo and a stored
 * pricing policy.
 */

const VALID = {
  targetMarkupPercent: "40",
  minGrossMarginPercent: "20",
  minDollarProfit: "100.00",
  currency: "USD",
};

const problemsFor = (over: Partial<typeof VALID>): readonly string[] => {
  const result = validatePricingProfileSettings({ ...VALID, ...over });
  return result.ok ? [] : result.problems;
};

describe("the happy path", () => {
  it("converts percentages to rates exactly", () => {
    const result = validatePricingProfileSettings(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.targetMarkupRate).toBe("0.4");
    expect(result.value.minGrossMarginRate).toBe("0.2");
    expect(result.value.minDollarProfitMinorUnits).toBe(10000n);
    expect(result.value.currency).toBe("USD");
  });

  it("converts a percentage that binary floating point gets wrong", () => {
    // 20.1 / 100 is 0.20099999999999998 as a double. Decimal arithmetic is
    // the whole reason this module exists.
    const result = validatePricingProfileSettings({ ...VALID, minGrossMarginPercent: "20.1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.minGrossMarginRate).toBe("0.201");
  });

  it("accepts a zero minimum profit", () => {
    // "No fixed profit floor, rely on the margin floor" is a legitimate
    // configuration. Only a NEGATIVE floor is nonsense.
    const result = validatePricingProfileSettings({ ...VALID, minDollarProfit: "0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.minDollarProfitMinorUnits).toBe(0n);
  });

  it("accepts a zero markup", () => {
    expect(problemsFor({ targetMarkupPercent: "0" })).toEqual([]);
  });

  it("tolerates typed noise — %, $, commas, spaces", () => {
    expect(
      problemsFor({ targetMarkupPercent: " 40% ", minDollarProfit: " $1,000.00 " })
    ).toEqual([]);
  });
});

describe("target markup", () => {
  it("is required", () => {
    expect(problemsFor({ targetMarkupPercent: "" })).toContain("Target markup is required.");
  });

  it("rejects a negative value", () => {
    expect(problemsFor({ targetMarkupPercent: "-5" })).toContain("Target markup cannot be negative.");
  });

  it("has NO invented upper bound", () => {
    // No approved requirement specifies a ceiling, and inventing one is a
    // business rule smuggled in as validation.
    expect(problemsFor({ targetMarkupPercent: "500" })).toEqual([]);
  });

  it("rejects more precision than the column can hold", () => {
    // Decimal(9,6) holds six places after the division by 100, so five
    // decimal places in a percent would be silently rounded by Postgres —
    // storing something other than what the operator confirmed.
    expect(problemsFor({ targetMarkupPercent: "40.12345" })).not.toEqual([]);
    expect(problemsFor({ targetMarkupPercent: "40.1234" })).toEqual([]);
  });
});

describe("minimum gross margin", () => {
  it("is required", () => {
    expect(problemsFor({ minGrossMarginPercent: "" })).toContain("Minimum gross margin is required.");
  });

  it("rejects a negative value", () => {
    expect(problemsFor({ minGrossMarginPercent: "-1" })).toContain(
      "Minimum gross margin cannot be negative."
    );
  });

  it("rejects 100% and above", () => {
    // A 100% gross margin implies an infinite price.
    expect(problemsFor({ minGrossMarginPercent: "100" })).toContain(
      "Minimum gross margin must be below 100%."
    );
    expect(problemsFor({ minGrossMarginPercent: "150" })).not.toEqual([]);
  });

  it("accepts just under 100%", () => {
    expect(problemsFor({ minGrossMarginPercent: "99.9999" })).toEqual([]);
  });
});

describe("minimum profit", () => {
  it("is required", () => {
    expect(problemsFor({ minDollarProfit: "" })).toContain("Minimum profit is required.");
  });

  it("rejects a negative amount", () => {
    expect(problemsFor({ minDollarProfit: "-100" })).toContain("Minimum profit cannot be negative.");
  });

  it("rejects sub-cent precision", () => {
    expect(problemsFor({ minDollarProfit: "100.001" })).not.toEqual([]);
  });
});

describe("rejecting what decimal.js would otherwise swallow", () => {
  it.each(["1e5", "Infinity", "NaN", "0x10", "abc", "1,5", "--4"])("rejects %s as a markup", (bad) => {
    expect(problemsFor({ targetMarkupPercent: bad })).not.toEqual([]);
  });
});

describe("currency", () => {
  it("must be a three-letter code", () => {
    expect(problemsFor({ currency: "US" })).toContain("Currency must be a three-letter code such as USD.");
  });

  it("is upper-cased", () => {
    const result = validatePricingProfileSettings({ ...VALID, currency: "usd" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currency).toBe("USD");
  });
});

describe("multiple problems are reported together", () => {
  it("does not stop at the first", () => {
    // An operator fixing one field at a time through four round trips is a
    // worse experience than one list.
    const problems = problemsFor({
      targetMarkupPercent: "-1",
      minGrossMarginPercent: "200",
      minDollarProfit: "-5",
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("display helpers round-trip", () => {
  it("renders a stored rate back as the percent the operator typed", () => {
    expect(rateToPercentDisplay("0.400000")).toBe("40");
    expect(rateToPercentDisplay("0.201")).toBe("20.1");
  });

  it("renders minor units as an amount", () => {
    expect(minorUnitsToDisplayAmount(10000n)).toBe("100.00");
    expect(minorUnitsToDisplayAmount(5n)).toBe("0.05");
    expect(minorUnitsToDisplayAmount(0n)).toBe("0.00");
  });

  it("survives a round trip through validation", () => {
    const result = validatePricingProfileSettings(VALID);
    if (!result.ok) throw new Error("expected valid");
    expect(rateToPercentDisplay(result.value.targetMarkupRate)).toBe("40");
    expect(minorUnitsToDisplayAmount(result.value.minDollarProfitMinorUnits)).toBe("100.00");
  });
});
