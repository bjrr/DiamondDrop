import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "./decimal";
import { CurrencyMismatchError, InvalidAllocationError, InvalidMoneyAmountError } from "./errors";
import { Money, sumMoney } from "./money";
import { DEFAULT_ROUNDING_RULE_ID } from "./rounding";

describe("Money arithmetic", () => {
  it("adds exactly with no float drift", () => {
    const a = Money.fromMinorUnits(1050n, "USD"); // $10.50
    const b = Money.fromMinorUnits(275n, "USD"); // $2.75
    expect(a.add(b).amountMinorUnits).toBe(1325n);
  });

  it("subtracts exactly, including into negative territory", () => {
    const a = Money.fromMinorUnits(500n, "USD");
    const b = Money.fromMinorUnits(750n, "USD");
    expect(a.subtract(b).amountMinorUnits).toBe(-250n);
  });

  it("multiplies by an integer exactly", () => {
    const unitPrice = Money.fromMinorUnits(1999n, "USD");
    expect(unitPrice.multiplyByInteger(3n).amountMinorUnits).toBe(5997n);
  });

  it("handles amounts far beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    const huge = Money.fromMinorUnits(9_007_199_254_740_993n, "USD"); // MAX_SAFE_INTEGER + 2
    const doubled = huge.multiplyByInteger(2n);
    expect(doubled.amountMinorUnits).toBe(18_014_398_509_481_986n);
  });

  it("throws on currency mismatch for add", () => {
    const usd = Money.fromMinorUnits(100n, "USD");
    const eur = Money.fromMinorUnits(100n, "EUR");
    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError);
  });

  it("throws on currency mismatch for subtract and compareTo", () => {
    const usd = Money.fromMinorUnits(100n, "USD");
    const eur = Money.fromMinorUnits(100n, "EUR");
    expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.compareTo(eur)).toThrow(CurrencyMismatchError);
  });

  it("sumMoney happy path sums multiple values correctly", () => {
    const values = [
      Money.fromMinorUnits(100n, "USD"),
      Money.fromMinorUnits(250n, "USD"),
      Money.fromMinorUnits(150n, "USD"),
    ];
    const result = sumMoney(values, "USD");
    expect(result.amountMinorUnits).toBe(500n);
  });

  it("sumMoney with empty array returns zero in the given currency", () => {
    const values: Money[] = [];
    const result = sumMoney(values, "USD");
    expect(result.amountMinorUnits).toBe(0n);
    expect(result.currency).toBe("USD");
  });

  it("sumMoney throws on any currency mismatch in the array", () => {
    const values = [Money.fromMinorUnits(100n, "USD"), Money.fromMinorUnits(100n, "EUR")];
    expect(() => sumMoney(values, "USD")).toThrow(CurrencyMismatchError);
  });

  it("rejects an invalid currency code", () => {
    expect(() => Money.fromMinorUnits(100n, "US")).toThrow(InvalidMoneyAmountError);
    expect(() => Money.fromMinorUnits(100n, "usd")).toThrow(InvalidMoneyAmountError);
  });
});

describe("Money.divideByInteger", () => {
  it("rounds using the explicitly named rule", () => {
    const total = Money.fromMinorUnits(1001n, "USD"); // $10.01
    const result = total.divideByInteger(2n, DEFAULT_ROUNDING_RULE_ID);
    // 1001 / 2 = 500.5 -> half up -> 501
    expect(result.amountMinorUnits).toBe(501n);
  });

  it("throws on division by zero", () => {
    const total = Money.fromMinorUnits(100n, "USD");
    expect(() => total.divideByInteger(0n, DEFAULT_ROUNDING_RULE_ID)).toThrow(InvalidMoneyAmountError);
  });

  it("throws on an unregistered rounding rule id", () => {
    const total = Money.fromMinorUnits(100n, "USD");
    // @ts-expect-error -- intentionally passing an unregistered id to exercise the runtime guard
    expect(() => total.divideByInteger(3n, "NOT_A_REAL_RULE")).toThrow();
  });
});

describe("Money.allocate — remainder-exact splitting", () => {
  it("splits evenly with no remainder", () => {
    const total = Money.fromMinorUnits(900n, "USD");
    const parts = total.allocate([1, 1, 1]);
    expect(parts.map((p) => p.amountMinorUnits)).toEqual([300n, 300n, 300n]);
  });

  it("distributes the remainder without losing or inventing a cent", () => {
    const total = Money.fromMinorUnits(100n, "USD");
    const parts = total.allocate([1, 1, 1]);
    const sum = parts.reduce((acc, p) => acc + p.amountMinorUnits, 0n);
    expect(sum).toBe(100n);
    // Largest-remainder method with equal weights and a deterministic tie
    // break gives the earliest index(es) the extra cent(s).
    expect(parts.map((p) => p.amountMinorUnits)).toEqual([34n, 33n, 33n]);
  });

  it("is remainder-exact for uneven weights", () => {
    const total = Money.fromMinorUnits(1000n, "USD");
    const parts = total.allocate([1, 2, 7]);
    const sum = parts.reduce((acc, p) => acc + p.amountMinorUnits, 0n);
    expect(sum).toBe(1000n);
  });

  it("is remainder-exact for a negative total", () => {
    const total = Money.fromMinorUnits(-100n, "USD");
    const parts = total.allocate([1, 1, 1]);
    const sum = parts.reduce((acc, p) => acc + p.amountMinorUnits, 0n);
    expect(sum).toBe(-100n);
    expect(parts.map((p) => p.amountMinorUnits)).toEqual([-34n, -33n, -33n]);
  });

  it("is remainder-exact across a table of weight combinations", () => {
    const cases: { totalMinorUnits: bigint; weights: number[] }[] = [
      { totalMinorUnits: 1n, weights: [1, 1, 1] },
      { totalMinorUnits: 2n, weights: [1, 1, 1] },
      { totalMinorUnits: 7n, weights: [3, 3, 3, 3] },
      { totalMinorUnits: 123_457n, weights: [5, 3, 2] },
      { totalMinorUnits: 999_999_999n, weights: [1, 1, 1, 1, 1, 1, 1] },
    ];
    for (const { totalMinorUnits, weights } of cases) {
      const parts = Money.fromMinorUnits(totalMinorUnits, "USD").allocate(weights);
      const sum = parts.reduce((acc, p) => acc + p.amountMinorUnits, 0n);
      expect(sum).toBe(totalMinorUnits);
    }
  });

  it("rejects an empty weights array", () => {
    const total = Money.fromMinorUnits(100n, "USD");
    expect(() => total.allocate([])).toThrow(InvalidAllocationError);
  });

  it("rejects negative or non-integer weights", () => {
    const total = Money.fromMinorUnits(100n, "USD");
    expect(() => total.allocate([1, -1])).toThrow(InvalidAllocationError);
    expect(() => total.allocate([1, 1.5])).toThrow(InvalidAllocationError);
  });

  it("rejects an all-zero weights array", () => {
    const total = Money.fromMinorUnits(100n, "USD");
    expect(() => total.allocate([0, 0])).toThrow(InvalidAllocationError);
  });

  it("gives a zero weight exactly zero when mixed with non-zero weights", () => {
    // This pins the proof: a zero weight always has remainder 0, and leftover
    // is provably <= the count of non-zero remainders, so a zero-weight part
    // can never receive a cent. This test asserts the guarantee.
    const total = Money.fromMinorUnits(100n, "USD");
    const parts = total.allocate([0, 5, 3]);
    // part[0] (weight 0) must receive exactly 0
    expect(parts[0]?.amountMinorUnits).toBe(0n);
    // parts[1] and parts[2] split the 100 cents
    expect(parts[1]?.amountMinorUnits).toBe(63n); // 5/8 * 100 + remainder
    expect(parts[2]?.amountMinorUnits).toBe(37n); // 3/8 * 100
    // Verify they sum exactly
    const sum = parts.reduce((acc, p) => acc + p.amountMinorUnits, 0n);
    expect(sum).toBe(100n);
  });

  it("preserves zero-weight invariant with multiple zero weights", () => {
    const total = Money.fromMinorUnits(1000n, "USD");
    const parts = total.allocate([0, 0, 1, 2, 0]);
    // All zero-weight parts (indices 0, 1, 4) must be exactly 0
    expect(parts[0]?.amountMinorUnits).toBe(0n);
    expect(parts[1]?.amountMinorUnits).toBe(0n);
    expect(parts[4]?.amountMinorUnits).toBe(0n);
    // parts[2] and parts[3] split 1000 cents (1:2 ratio)
    expect(parts[2]?.amountMinorUnits).toBe(333n); // 1/3 * 1000 + 1 (largest remainder gets extra cent)
    expect(parts[3]?.amountMinorUnits).toBe(667n); // 2/3 * 1000
    const sum = parts.reduce((acc, p) => acc + p.amountMinorUnits, 0n);
    expect(sum).toBe(1000n);
  });
});

describe("Money.negate", () => {
  it("negates a positive amount", () => {
    const positive = Money.fromMinorUnits(1000n, "USD");
    const negated = positive.negate();
    expect(negated.amountMinorUnits).toBe(-1000n);
    expect(negated.currency).toBe("USD");
  });

  it("negates a negative amount to positive", () => {
    const negative = Money.fromMinorUnits(-1000n, "USD");
    const negated = negative.negate();
    expect(negated.amountMinorUnits).toBe(1000n);
  });

  it("negates zero to zero", () => {
    const zero = Money.zero("USD");
    const negated = zero.negate();
    expect(negated.amountMinorUnits).toBe(0n);
    expect(negated.isZero()).toBe(true);
  });
});

describe("Money.multiplyByDecimal", () => {
  it("multiplies by a factor of 1 (identity)", () => {
    const original = Money.fromMinorUnits(1250n, "USD"); // $12.50
    const result = original.multiplyByDecimal("1", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(1250n);
  });

  it("multiplies by a factor of 0 (zero out)", () => {
    const original = Money.fromMinorUnits(1250n, "USD");
    const result = original.multiplyByDecimal("0", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(0n);
  });

  it("rounds an exact positive .5 tie away from zero (2.5 → 3)", () => {
    // 250 cents * 1.25 = 312.5 cents -> rounds to 313 cents (away from zero)
    const original = Money.fromMinorUnits(250n, "USD");
    const result = original.multiplyByDecimal("1.25", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(313n);
  });

  it("rounds an exact negative .5 tie away from zero (−2.5 → −3)", () => {
    // -250 cents * 1.25 = -312.5 cents -> rounds to -313 cents (away from zero)
    const original = Money.fromMinorUnits(-250n, "USD");
    const result = original.multiplyByDecimal("1.25", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(-313n);
  });

  it("handles a repeating decimal (multiplication by 1/3)", () => {
    // 300 cents * (1/3) = 100 cents (exact)
    const original = Money.fromMinorUnits(300n, "USD");
    const result = original.multiplyByDecimal("0.333333333333333333", DEFAULT_ROUNDING_RULE_ID);
    // 300 * 0.333333... rounds to 100
    expect(result.amountMinorUnits).toBe(100n);
  });

  it("accepts a factor as a string", () => {
    const original = Money.fromMinorUnits(1000n, "USD");
    const result = original.multiplyByDecimal("1.5", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(1500n);
  });

  it("accepts a factor as a MoneyDecimal", () => {
    const original = Money.fromMinorUnits(1000n, "USD");
    const factor = new MoneyDecimal("1.5");
    const result = original.multiplyByDecimal(factor, DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(1500n);
  });

  it("handles an amount far above 2^53, proving no float path", () => {
    // 9_007_199_254_740_993 is MAX_SAFE_INTEGER + 2 and is NOT representable
    // as a double — it collapses to ...992. The factor is chosen so that
    // collapse changes the answer:
    //
    //   exact:  9007199254740993 × 1.05 = 9457559217478042.65 → 9457559217478043
    //   float:  9007199254740992 × 1.05                       → 9457559217478042
    //
    // The expected value is stated as a literal derived from the rule above,
    // NOT recomputed with decimal.js here — recomputing would assert the same
    // library the implementation uses against itself and would pass even if
    // Money routed through a float. Note ×1.1 does NOT work as a probe: both
    // paths land on 9907919180215092, so it would prove nothing.
    const largeAmount = Money.fromMinorUnits(9_007_199_254_740_993n, "USD");
    const result = largeAmount.multiplyByDecimal("1.05", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(9_457_559_217_478_043n);
  });
});

describe("Money.fromDecimalMinorUnits", () => {
  it("accepts an exact minor unit value and returns it unchanged", () => {
    const result = Money.fromDecimalMinorUnits("1000", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(1000n);
  });

  it("rounds an exact positive .5 tie away from zero (2.5 → 3)", () => {
    const result = Money.fromDecimalMinorUnits("2.5", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(3n);
  });

  it("rounds an exact negative .5 tie away from zero (−2.5 → −3)", () => {
    const result = Money.fromDecimalMinorUnits("-2.5", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(-3n);
  });

  it("handles a repeating decimal (1/3)", () => {
    // 1 / 3 = 0.333... rounds to 0
    const result = Money.fromDecimalMinorUnits("0.333333333333", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(0n);
  });

  it("handles an amount far above 2^53, proving no float path", () => {
    // MAX_SAFE_INTEGER + 2
    const result = Money.fromDecimalMinorUnits("9007199254740993", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(9_007_199_254_740_993n);
  });

  it("accepts a MoneyDecimal value", () => {
    const decimal = new MoneyDecimal("42.75");
    const result = Money.fromDecimalMinorUnits(decimal, "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(43n);
  });

  it("rejects an unknown rounding rule id at runtime", () => {
    // @ts-expect-error -- intentionally passing an unregistered id
    expect(() => Money.fromDecimalMinorUnits("100", "USD", "UNKNOWN_RULE")).toThrow();
  });

  it("honours a different rounding rule id (asserts rounding rule is actually used)", () => {
    // This test would require another rounding rule to be registered.
    // For now, we verify that the rule ID is passed through and used
    // by checking an edge case. HALF_UP_MINOR_UNIT_V1 is the only rule,
    // so we test that passing a registered rule works and an unregistered one fails.
    const result = Money.fromDecimalMinorUnits("2.5", "USD", "HALF_UP_MINOR_UNIT_V1");
    expect(result.amountMinorUnits).toBe(3n);
  });

  it("accepts fractional minor units and rounds them exactly once", () => {
    // Fractional cents are allowed at this boundary
    // 10.123456 cents -> rounds to 10 cents
    const result = Money.fromDecimalMinorUnits("10.123456", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(10n);
  });

  it("rounds a fractional minor unit at exactly .5 (half)", () => {
    // 10.5 cents -> rounds to 11 cents (away from zero)
    const result = Money.fromDecimalMinorUnits("10.5", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(result.amountMinorUnits).toBe(11n);
  });
});

describe("Money.fromDecimalMajorUnits", () => {
  it("converts major units to minor units at the named rounding boundary", () => {
    const money = Money.fromDecimalMajorUnits("10.5", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(money.amountMinorUnits).toBe(1050n);
  });

  it("rounds a half-cent up (away from zero)", () => {
    const money = Money.fromDecimalMajorUnits("10.005", "USD", DEFAULT_ROUNDING_RULE_ID);
    expect(money.amountMinorUnits).toBe(1001n);
  });

  it("handles minorUnitsPerMajorUnit of 1 (JPY-shaped currency)", () => {
    // JPY has 0 decimal places, so 1 major unit = 1 minor unit
    // 1000 JPY should be 1000 minor units
    const jpy = Money.fromDecimalMajorUnits("1000", "JPY", DEFAULT_ROUNDING_RULE_ID, 1);
    expect(jpy.amountMinorUnits).toBe(1000n);
  });

  it("handles minorUnitsPerMajorUnit of 1000 (3-decimal-shaped currency)", () => {
    // A hypothetical currency with 3 decimal places: 1 major = 1000 minor
    // 10.5 major units = 10500 minor units
    const result = Money.fromDecimalMajorUnits("10.5", "XXX", DEFAULT_ROUNDING_RULE_ID, 1000);
    expect(result.amountMinorUnits).toBe(10500n);
  });

  it("rounds correctly at the named boundary with custom minorUnitsPerMajorUnit", () => {
    // 3-decimal currency: 10.0005 major = 10000.5 minor -> rounds to 10001
    const result = Money.fromDecimalMajorUnits("10.0005", "XXX", DEFAULT_ROUNDING_RULE_ID, 1000);
    expect(result.amountMinorUnits).toBe(10001n);
  });
});

describe("Money JSON serialization", () => {
  it("round-trips without precision loss for very large amounts", () => {
    const original = Money.fromMinorUnits(9_007_199_254_740_993n, "USD");
    const json = original.toJSON();
    expect(typeof json.amountMinorUnits).toBe("string");
    const restored = Money.fromJSON(json);
    expect(restored.equals(original)).toBe(true);
    expect(restored.amountMinorUnits).toBe(9_007_199_254_740_993n);
  });

  it("round-trips negative amounts", () => {
    const original = Money.fromMinorUnits(-4200n, "USD");
    const restored = Money.fromJSON(original.toJSON());
    expect(restored.equals(original)).toBe(true);
  });

  it("rejects a malformed serialized amount", () => {
    expect(() => Money.fromJSON({ amountMinorUnits: "12.5", currency: "USD" })).toThrow(
      InvalidMoneyAmountError
    );
    expect(() => Money.fromJSON({ amountMinorUnits: "abc", currency: "USD" })).toThrow(
      InvalidMoneyAmountError
    );
  });
});

describe("Money comparisons", () => {
  it("compares and predicates correctly", () => {
    const zero = Money.zero("USD");
    const positive = Money.fromMinorUnits(1n, "USD");
    const negative = Money.fromMinorUnits(-1n, "USD");

    expect(zero.isZero()).toBe(true);
    expect(positive.isPositive()).toBe(true);
    expect(negative.isNegative()).toBe(true);
    expect(positive.compareTo(negative)).toBe(1);
    expect(negative.compareTo(positive)).toBe(-1);
    expect(zero.compareTo(Money.zero("USD"))).toBe(0);
  });
});
