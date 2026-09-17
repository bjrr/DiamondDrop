import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import {
  UnknownCreditCardPriceRuleError,
  deriveCreditCardPrice,
  getCreditCardPriceRule,
} from "./creditCardPrice";
import type { CreditCardPriceRuleId } from "./types";

/**
 * D9 — credit-card price derivation. The owner's constraint was that there is
 * ONE stored price (the cash-equivalent base) and the card price is derived.
 * These tests pin the formula and the versioning contract.
 */
describe("deriveCreditCardPrice", () => {
  const RATE = new MoneyDecimal("0.050000");

  it("applies the owner's base x 1.05", () => {
    const card = deriveCreditCardPrice(new MoneyDecimal("34900"), RATE, "MULTIPLY_BASE_V1");
    expect(card.toString()).toBe("36645");
  });

  it("is exact, not floating point, on a value where the two genuinely diverge", () => {
    // A $10.02 base x 1.05 is 1052.1 minor units exactly. IEEE-754 doubles give
    // 1052.1000000000001 for the same multiplication. This specific input was
    // chosen because most values agree between the two paths — a test using one
    // of those would pass whether or not the implementation used floats, and so
    // would prove nothing.
    const card = deriveCreditCardPrice(new MoneyDecimal("1002"), RATE, "MULTIPLY_BASE_V1");
    expect(card.toString()).toBe("1052.1");
    expect(card.toString()).not.toBe("1052.1000000000001");
  });

  it("returns the base unchanged at a zero uplift", () => {
    const card = deriveCreditCardPrice(
      new MoneyDecimal("34900"),
      new MoneyDecimal("0"),
      "MULTIPLY_BASE_V1"
    );
    expect(card.toString()).toBe("34900");
  });

  it("scales with the price rather than adding a flat fee", () => {
    // The reason the rule is multiplicative: card processing is a percentage,
    // so the uplift on a $2,195 ring must be ~44x the uplift on a $49 one.
    const cheap = deriveCreditCardPrice(new MoneyDecimal("4900"), RATE, "MULTIPLY_BASE_V1");
    const dear = deriveCreditCardPrice(new MoneyDecimal("219500"), RATE, "MULTIPLY_BASE_V1");
    expect(cheap.minus(new MoneyDecimal("4900")).toString()).toBe("245");
    expect(dear.minus(new MoneyDecimal("219500")).toString()).toBe("10975");
  });

  it("rejects an unregistered rule id rather than silently not applying uplift", () => {
    // Cast through the union deliberately: the point is what happens when an
    // id reaches this function that the type system said could not.
    const unregistered = "MULTIPLY_BASE_V2" as CreditCardPriceRuleId;
    expect(() => deriveCreditCardPrice(new MoneyDecimal("34900"), RATE, unregistered)).toThrow(
      UnknownCreditCardPriceRuleError
    );
  });

  it("keeps MULTIPLY_BASE_V1 behaviour frozen for stored calculations", () => {
    // The versioning contract: a stored calculation referencing this id must be
    // re-derivable forever. If this test is failing because someone changed the
    // formula, the change needs a NEW id, not an edit to this one.
    const rule = getCreditCardPriceRule("MULTIPLY_BASE_V1");
    expect(rule.derive(new MoneyDecimal("10000"), new MoneyDecimal("0.05")).toString()).toBe("10500");
  });
});
