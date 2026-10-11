import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";

import { BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS } from "./fallbackBenefit";
import {
  computeEligibleSubtotal,
  quoteRedemption,
  RedemptionCalculationError,
  type RedemptionLineInput,
} from "./redemptionCalculation";

const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");
const CAP = usd(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS);

function line(overrides: Partial<RedemptionLineInput> = {}): RedemptionLineInput {
  return {
    reference: "gid://shopify/ProductVariant/1",
    quantity: 1,
    unitPrice: usd(50_000n),
    ineligibleBecause: null,
    ...overrides,
  };
}

function quote(lines: readonly RedemptionLineInput[], overrides: Record<string, unknown> = {}) {
  return quoteRedemption({
    lines,
    surface: "buy_now",
    paymentBasis: "card",
    benefitMaxDiscount: CAP,
    otherPromotionApplied: false,
    stackingExpresslyAuthorized: false,
    ...overrides,
  });
}

describe("the owner's worked examples", () => {
  it("$500 eligible purchase -> $50", () => {
    expect(quote([line({ unitPrice: usd(50_000n) })]).discount.amountMinorUnits).toBe(5_000n);
  });

  it("$1,000 eligible purchase -> $100 (the cap binds exactly here)", () => {
    expect(quote([line({ unitPrice: usd(100_000n) })]).discount.amountMinorUnits).toBe(10_000n);
  });

  it("$5,000 eligible purchase -> still $100", () => {
    expect(quote([line({ unitPrice: usd(500_000n) })]).discount.amountMinorUnits).toBe(10_000n);
  });

  it("NEVER exceeds $100, swept across a wide range", () => {
    for (let dollars = 1; dollars <= 25_000; dollars += 173) {
      const result = quote([line({ unitPrice: usd(BigInt(dollars) * 100n) })]);
      expect(result.discount.amountMinorUnits, `$${dollars}`).toBeLessThanOrEqual(
        BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS
      );
      expect(result.discount.amountMinorUnits).toBeLessThanOrEqual(result.eligibleSubtotal.amountMinorUnits / 10n);
    }
  });

  it("rounds DOWN to the cent", () => {
    // $19.99 -> $1.99, not $2.00. Rounding a cap upward is how "maximum $100"
    // becomes $100.01.
    expect(quote([line({ unitPrice: usd(1_999n) })]).discount.amountMinorUnits).toBe(199n);
  });
});

describe("quantity multiplies the unit price and nothing else", () => {
  it("sums per-line extensions rather than reading a cart total", () => {
    const result = quote([
      line({ reference: "a", quantity: 3, unitPrice: usd(10_000n) }),
      line({ reference: "b", quantity: 2, unitPrice: usd(25_000n) }),
    ]);
    // 3x$100 + 2x$250 = $800
    expect(result.eligibleSubtotal.amountMinorUnits).toBe(80_000n);
    expect(result.discount.amountMinorUnits).toBe(8_000n);
  });

  it("quantity never changes eligibility", () => {
    const one = quote([line({ quantity: 1, unitPrice: usd(100_000n) })]);
    const ten = quote([line({ quantity: 10, unitPrice: usd(10_000n) })]);
    expect(one.eligibleSubtotal.amountMinorUnits).toBe(ten.eligibleSubtotal.amountMinorUnits);
    expect(one.discount.amountMinorUnits).toBe(ten.discount.amountMinorUnits);
  });

  it("refuses a fractional or zero quantity", () => {
    expect(() => quote([line({ quantity: 0 })])).toThrow(RedemptionCalculationError);
    expect(() => quote([line({ quantity: 1.5 })])).toThrow(RedemptionCalculationError);
  });
});

describe("the exclusions — each one a locked rule", () => {
  it.each(["group_buy", "luxury_steal", "non_merchandise", "already_discounted"] as const)(
    "a %s line contributes nothing to the subtotal",
    (reason) => {
      const result = quote([
        line({ reference: "eligible", unitPrice: usd(50_000n) }),
        line({ reference: "excluded", unitPrice: usd(500_000n), ineligibleBecause: reason }),
      ]);
      // The $5,000 excluded line would have capped the discount at $100; only
      // the eligible $500 counts.
      expect(result.eligibleSubtotal.amountMinorUnits).toBe(50_000n);
      expect(result.discount.amountMinorUnits).toBe(5_000n);
      expect(result.excludedLines).toHaveLength(1);
      expect(result.excludedLines[0]!.reason).toBe(reason);
    }
  );

  it("a Group Buy line never receives the benefit even as the majority of the cart", () => {
    const result = quote([
      line({ reference: "gb", unitPrice: usd(900_000n), ineligibleBecause: "group_buy" }),
      line({ reference: "ok", unitPrice: usd(20_000n) }),
    ]);
    expect(result.eligibleSubtotal.amountMinorUnits).toBe(20_000n);
    expect(result.discount.amountMinorUnits).toBe(2_000n);
    expect(result.includedLines.map((l) => l.reference)).toEqual(["ok"]);
  });

  it("tax, shipping, duties and tips are excluded as non-merchandise", () => {
    // A percentage of a total including them is a bigger benefit than the one
    // promised.
    const result = quote([
      line({ reference: "ring", unitPrice: usd(100_000n) }),
      line({ reference: "tax", unitPrice: usd(8_250n), ineligibleBecause: "non_merchandise" }),
      line({ reference: "shipping", unitPrice: usd(2_500n), ineligibleBecause: "non_merchandise" }),
      line({ reference: "duty", unitPrice: usd(4_000n), ineligibleBecause: "non_merchandise" }),
      line({ reference: "tip", unitPrice: usd(1_000n), ineligibleBecause: "non_merchandise" }),
    ]);
    expect(result.eligibleSubtotal.amountMinorUnits).toBe(100_000n);
    // The cap binds at exactly $1,000 of merchandise, so including the
    // non-merchandise would not even change the figure here — which is why
    // the SUBTOTAL is asserted and not only the discount.
    expect(result.discount.amountMinorUnits).toBe(10_000n);
  });

  it("REFUSES a cart with nothing eligible rather than quoting zero", () => {
    // Returning a $0 discount would spend the customer's one use on nothing.
    expect(() =>
      quote([
        line({ ineligibleBecause: "group_buy" }),
        line({ reference: "b", ineligibleBecause: "luxury_steal" }),
      ])
    ).toThrow(/no eligible merchandise/i);
  });

  it("REFUSES a subtotal so small that 10% truncates to nothing", () => {
    expect(() => quote([line({ unitPrice: usd(9n) })])).toThrow(/rounds down to zero/i);
  });
});

describe("surfaces", () => {
  it("accepts regular Buy Now and Custom Jewelry", () => {
    expect(quote([line()], { surface: "buy_now" }).discount.amountMinorUnits).toBe(5_000n);
    expect(quote([line()], { surface: "custom_jewelry" }).discount.amountMinorUnits).toBe(5_000n);
  });

  it.each(["group_buy", "luxury_steals"] as const)("REFUSES %s outright", (surface) => {
    expect(() => quote([line()], { surface })).toThrow(/not redeemable on/i);
  });
});

describe("stacking is refused by default", () => {
  it("REFUSES when another promotion is applied", () => {
    // Not "calculate it anyway and let someone else refuse" — the benefit is
    // not stackable, so there is no correct amount on top of another discount.
    expect(() => quote([line()], { otherPromotionApplied: true })).toThrow(/stacking has not been expressly authorized/i);
  });

  it("ALLOWS it when expressly authorized", () => {
    const result = quote([line()], { otherPromotionApplied: true, stackingExpresslyAuthorized: true });
    expect(result.discount.amountMinorUnits).toBe(5_000n);
  });

  it("authorization alone changes nothing when no other promotion is applied", () => {
    expect(quote([line()], { stackingExpresslyAuthorized: true }).discount.amountMinorUnits).toBe(5_000n);
  });
});

describe("the cap comes from the BENEFIT, not from today's constant", () => {
  it("honours a smaller cap frozen on an older benefit", () => {
    // If the policy ever changed, an already-issued benefit must still be
    // worth exactly what its holder was promised.
    const result = quote([line({ unitPrice: usd(500_000n) })], { benefitMaxDiscount: usd(5_000n) });
    expect(result.discount.amountMinorUnits).toBe(5_000n);
  });

  it("honours a larger cap too, so the direction is not assumed", () => {
    const result = quote([line({ unitPrice: usd(500_000n) })], { benefitMaxDiscount: usd(15_000n) });
    // 10% of $5,000 is $500, so a $150 cap binds.
    expect(result.discount.amountMinorUnits).toBe(15_000n);
  });

  it("refuses a cap in another currency", () => {
    expect(() => quote([line()], { benefitMaxDiscount: Money.fromMinorUnits(10_000n, "CAD") })).toThrow(/CAD/);
  });
});

describe("computeEligibleSubtotal on its own", () => {
  it("refuses an empty line list", () => {
    expect(() => computeEligibleSubtotal([])).toThrow(/at least one line/i);
  });

  it("refuses a line priced in another currency", () => {
    expect(() => computeEligibleSubtotal([line({ unitPrice: Money.fromMinorUnits(100n, "CAD") })])).toThrow(
      /CAD/
    );
  });

  it("refuses a negative unit price", () => {
    expect(() => computeEligibleSubtotal([line({ unitPrice: usd(-1n) })])).toThrow(/negative/i);
  });

  it("reports both halves, so a refusal can be explained", () => {
    const result = computeEligibleSubtotal([
      line({ reference: "a" }),
      line({ reference: "b", ineligibleBecause: "luxury_steal" }),
    ]);
    expect(result.includedLines.map((l) => l.reference)).toEqual(["a"]);
    expect(result.excludedLines.map((e) => e.line.reference)).toEqual(["b"]);
  });
});

describe("the payment basis — owner decision 2026-10-11", () => {
  it("calculates the BANK benefit from the bank subtotal", () => {
    // $476.20 of bank-priced merchandise -> $47.62.
    const result = quote([line({ unitPrice: usd(47_620n) })], { paymentBasis: "bank_payment" });
    expect(result.discount.amountMinorUnits).toBe(4_762n);
    expect(result.eligibleSubtotal.amountMinorUnits).toBe(47_620n);
    // Echoed back so a caller stores the figures and the basis as one fact.
    expect(result.paymentBasis).toBe("bank_payment");
  });

  it("calculates the CARD benefit from the card subtotal", () => {
    // The same product's card price is higher — the card price is derived
    // upward from the bank price — so the same cart yields a bigger benefit on
    // card. That is the arithmetic working, not a loophole: the customer is
    // paying more to begin with.
    const result = quote([line({ unitPrice: usd(50_000n) })], { paymentBasis: "card" });
    expect(result.discount.amountMinorUnits).toBe(5_000n);
    expect(result.paymentBasis).toBe("card");
  });

  it("gives a SMALLER benefit on the bank basis for the same goods", () => {
    // Worth pinning as a property rather than two separate numbers: 10% of a
    // lower base is less. A customer choosing bank gets the lower underlying
    // price AND a smaller benefit, which is why the owner forbade us from
    // picking for them — the better deal depends on the cart.
    const bank = quote([line({ unitPrice: usd(47_620n) })], { paymentBasis: "bank_payment" });
    const card = quote([line({ unitPrice: usd(50_000n) })], { paymentBasis: "card" });
    expect(bank.discount.amountMinorUnits).toBeLessThan(card.discount.amountMinorUnits);
  });

  it("CAPS BOTH BASES at the benefit's maximum", () => {
    // $100 is $100 whichever basis got you there.
    const bank = quote([line({ unitPrice: usd(500_000n) })], { paymentBasis: "bank_payment" });
    const card = quote([line({ unitPrice: usd(525_000n) })], { paymentBasis: "card" });
    expect(bank.discount.amountMinorUnits).toBe(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS);
    expect(card.discount.amountMinorUnits).toBe(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS);
  });

  it("sweeps the cap across both bases", () => {
    for (const paymentBasis of ["card", "bank_payment"] as const) {
      for (let dollars = 1; dollars <= 20_000; dollars += 311) {
        const result = quote([line({ unitPrice: usd(BigInt(dollars) * 100n) })], { paymentBasis });
        expect(result.discount.amountMinorUnits, `${paymentBasis} $${dollars}`).toBeLessThanOrEqual(
          BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS
        );
      }
    }
  });

  it("the BANK BASIS IS NOT A PROMOTION — it does not trip the stacking refusal", () => {
    // The distinction the owner stated: Bank Payment Price is the underlying
    // payment-basis price, not a promotional discount, so a bank redemption is
    // not the prohibited stacking of amendment §3.
    //
    // This is the test that would fail if somebody ever "fixed" the bank path
    // by setting otherPromotionApplied, or marked bank-priced lines
    // `already_discounted`.
    const result = quote([line({ unitPrice: usd(47_620n) })], {
      paymentBasis: "bank_payment",
      otherPromotionApplied: false,
    });
    expect(result.discount.amountMinorUnits).toBe(4_762n);
  });

  it("still refuses a REAL promotion on the bank basis", () => {
    // The other direction, so the rule above is not read as "bank disables
    // stacking checks". An actual promotional discount still blocks.
    expect(() =>
      quote([line()], { paymentBasis: "bank_payment", otherPromotionApplied: true })
    ).toThrow(/stacking has not been expressly authorized/i);
  });

  it("rounds DOWN on the bank basis too", () => {
    // $19.99 of bank-priced merchandise -> $1.99, not $2.00.
    expect(
      quote([line({ unitPrice: usd(1_999n) })], { paymentBasis: "bank_payment" }).discount.amountMinorUnits
    ).toBe(199n);
  });

  it("applies the exclusions identically on both bases", () => {
    // A Luxury Steal is excluded whether the customer is paying by card or by
    // bank. The basis changes the price, never the eligibility.
    for (const paymentBasis of ["card", "bank_payment"] as const) {
      const result = quote(
        [
          line({ reference: "ok", unitPrice: usd(20_000n) }),
          line({ reference: "steal", unitPrice: usd(400_000n), ineligibleBecause: "luxury_steal" }),
        ],
        { paymentBasis }
      );
      expect(result.eligibleSubtotal.amountMinorUnits, paymentBasis).toBe(20_000n);
      expect(result.discount.amountMinorUnits, paymentBasis).toBe(2_000n);
    }
  });
});
