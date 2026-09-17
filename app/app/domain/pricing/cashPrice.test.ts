import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { UnknownCashPriceRuleError, deriveCashPrice, getCashPriceRule } from "./cashPrice";
import type { CashPriceRuleId } from "./types";

/**
 * D9 as revised by the owner: the calculated price is the LIST price (which is
 * the card price), and cash-equivalent customers pay a percentage less.
 */
describe("deriveCashPrice", () => {
  const RATE = new MoneyDecimal("0.050000");
  const RULE: CashPriceRuleId = "CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1";

  it("takes 5% off the list price", () => {
    // $400 list -> $380 exactly, no rounding involved.
    expect(deriveCashPrice(40000n, RATE, RULE)).toBe(38000n);
  });

  it("FLOORS to a whole dollar so the discount is never less than advertised", () => {
    // $349 x 0.95 = $331.55. Flooring gives $331 (5.16% off); rounding up would
    // give $332, which is 4.87% off while the site says 5%.
    expect(deriveCashPrice(34900n, RATE, RULE)).toBe(33100n);

    const realised = new MoneyDecimal(34900 - 33100).dividedBy(34900);
    expect(realised.greaterThanOrEqualTo("0.05")).toBe(true);
  });

  it("never delivers less than the advertised rate, across a wide range", () => {
    // The property the flooring exists to guarantee, checked rather than
    // asserted on one convenient example.
    for (let dollars = 100; dollars <= 5000; dollars += 7) {
      const list = BigInt(dollars * 100);
      const cash = deriveCashPrice(list, RATE, RULE);
      const realised = new MoneyDecimal((list - cash).toString()).dividedBy(
        new MoneyDecimal(list.toString())
      );
      expect(realised.greaterThanOrEqualTo("0.05")).toBe(true);
      expect(cash % 100n).toBe(0n);
    }
  });

  it("is the INVERSE of an uplift, not the same number", () => {
    // The distinction that makes this a revision rather than a sign flip. 5%
    // off $400 is $380; the card-to-cash spread is 400/380 = 5.26%, not 5%.
    // A prior implementation that added 5% to a $380 base would have listed
    // $399, a dollar adrift.
    const cash = deriveCashPrice(40000n, RATE, RULE);
    const upliftedBack = new MoneyDecimal(cash.toString()).times("1.05");
    expect(upliftedBack.toString()).toBe("39900");
    expect(upliftedBack.equals(new MoneyDecimal("40000"))).toBe(false);
  });

  it("returns the list price unchanged at a zero discount", () => {
    expect(deriveCashPrice(40000n, new MoneyDecimal("0"), RULE)).toBe(40000n);
  });

  it("is exact on a value where float arithmetic diverges", () => {
    // 1002 x 0.95 = 951.9 exactly; the double path gives 951.9000000000001.
    // Chosen because most values agree, so a test using one of those would pass
    // whether or not the implementation used floats.
    const cash = deriveCashPrice(100200n, RATE, RULE);
    expect(cash).toBe(95100n);
  });

  it("stays exact on a value beyond what a double represents", () => {
    // A deliberately absurd list price, to prove the decimal path holds where
    // Number would silently lose the low digits.
    const huge = 9007199254740993n; // 2^53 + 1
    const cash = deriveCashPrice(huge, RATE, RULE);
    const exact = new MoneyDecimal(huge.toString())
      .times("0.95")
      .dividedBy(100)
      .floor()
      .times(100);
    expect(cash.toString()).toBe(exact.toString());
  });

  it("rejects an unregistered rule id rather than silently not discounting", () => {
    // Failing open here would charge every cash customer the full list price.
    const unregistered = "CASH_DISCOUNT_V2" as CashPriceRuleId;
    expect(() => deriveCashPrice(40000n, RATE, unregistered)).toThrow(UnknownCashPriceRuleError);
  });

  it("keeps CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1 frozen for stored calculations", () => {
    // The versioning contract. If this fails because someone changed the
    // formula, the change needs a NEW id — every stored calculation referencing
    // this one must stay re-derivable.
    const rule = getCashPriceRule("CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1");
    expect(rule.derive(10000n, new MoneyDecimal("0.05"))).toBe(9500n);
  });
});
