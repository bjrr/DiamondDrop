import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { UnknownCardPriceRuleError, deriveCardPrice, getCardPriceRule } from "./cardPrice";
import type { CardPriceRuleId } from "./types";

/**
 * D9 in its final shape: the calculated price is the CASH price (internal, and
 * what the floors bind); the CARD price is derived from it and is what the
 * customer is shown.
 */
describe("deriveCardPrice", () => {
  const RATE = new MoneyDecimal("0.050000");
  const RULE: CardPriceRuleId = "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1";

  it("prices the card 5% above cash", () => {
    // $400 cash -> $420 card, exact, no rounding involved.
    expect(deriveCardPrice(40000n, RATE, RULE)).toBe(42000n);
  });

  it("ceils to a whole dollar rather than landing under the uplift", () => {
    // $349 x 1.05 = $366.45. Ceiling gives $367; rounding down to $366 would
    // put the card price below the 5% the configuration asked for.
    expect(deriveCardPrice(34900n, RATE, RULE)).toBe(36700n);
  });

  it("never prices card below the configured uplift, across a wide range", () => {
    // The property the ceiling exists to guarantee, checked rather than
    // asserted on one convenient example.
    for (let dollars = 100; dollars <= 5000; dollars += 7) {
      const cash = BigInt(dollars * 100);
      const card = deriveCardPrice(cash, RATE, RULE);
      const exact = new MoneyDecimal(cash.toString()).times("1.05");
      expect(new MoneyDecimal(card.toString()).greaterThanOrEqualTo(exact)).toBe(true);
      expect(card % 100n).toBe(0n);
      expect(card).toBeGreaterThan(cash);
    }
  });

  it("a 5% UPLIFT is not a 5% DISCOUNT — the reciprocal, and it matters", () => {
    // The arithmetic behind the advertising caveat. $400 cash -> $420 card, and
    // $400 is 4.76% off $420, not 5%. Advertising a flat "5% cash discount" on
    // a 5% uplift would overstate the saving on every item.
    const cash = 40000n;
    const card = deriveCardPrice(cash, RATE, RULE);
    const discountOffCard = new MoneyDecimal((card - cash).toString()).dividedBy(
      new MoneyDecimal(card.toString())
    );

    expect(discountOffCard.toDecimalPlaces(4).toString()).toBe("0.0476");
    expect(discountOffCard.lessThan("0.05")).toBe(true);
  });

  it("an uplift of 1/0.95 - 1 DOES yield exactly 5% off the displayed price", () => {
    // Recorded so the alternative is concrete if the owner wants the advertised
    // discount to be a clean 5%: it is a rate change, not a code change.
    const card = deriveCardPrice(40000n, new MoneyDecimal("0.052632"), RULE);
    const discountOffCard = new MoneyDecimal((card - 40000n).toString()).dividedBy(
      new MoneyDecimal(card.toString())
    );
    expect(discountOffCard.greaterThanOrEqualTo("0.05")).toBe(true);
  });

  it("returns the cash price unchanged at a zero uplift", () => {
    expect(deriveCardPrice(40000n, new MoneyDecimal("0"), RULE)).toBe(40000n);
  });

  it("is exact on a value where float arithmetic diverges", () => {
    // 1002 x 1.05 = 1052.1 exactly; the double path gives 1052.1000000000001.
    // Chosen because most values agree, so a test on one of those would pass
    // whether or not the implementation used floats.
    expect(deriveCardPrice(100200n, RATE, RULE)).toBe(105300n);
  });

  it("stays exact beyond what a double represents", () => {
    const huge = 9007199254740993n; // 2^53 + 1
    const expected = new MoneyDecimal(huge.toString())
      .times("1.05")
      .dividedBy(100)
      .ceil()
      .times(100);
    expect(deriveCardPrice(huge, RATE, RULE).toString()).toBe(expected.toString());
  });

  it("rejects an unregistered rule id rather than silently not applying uplift", () => {
    // Failing open here would charge every card customer the cash price.
    const unregistered = "CARD_UPLIFT_V2" as CardPriceRuleId;
    expect(() => deriveCardPrice(40000n, RATE, unregistered)).toThrow(UnknownCardPriceRuleError);
  });

  it("keeps CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1 frozen for stored calculations", () => {
    // The versioning contract. If this fails because someone changed the
    // formula, the change needs a NEW id — every stored calculation referencing
    // this one must stay re-derivable.
    const rule = getCardPriceRule("CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1");
    expect(rule.derive(10000n, new MoneyDecimal("0.05"))).toBe(10500n);
  });
});
