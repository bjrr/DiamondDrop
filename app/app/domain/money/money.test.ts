import { describe, expect, it } from "vitest";

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
