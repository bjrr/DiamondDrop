import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";

import {
  ApprovalPackageMoneyError,
  computeApprovalPackageMoney,
  computeFinalPurchaseAmounts,
} from "./finalApprovalMoney";

/**
 * The money on a Custom Jewelry final approval.
 *
 * ============================================================================
 * THE PROPERTY WORTH THE MOST HERE
 * ============================================================================
 * The gross approved price survives every reduction. Owner requirement: "Never
 * lose the gross approved price simply because only the balance is collected
 * at final checkout." Each test below asserts the gross figure alongside the
 * balance for exactly that reason — a test that only checked the balance would
 * pass against an implementation that had thrown the price away.
 */

const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

/** $5,000 bank / $5,175 card — a realistic 3.5% uplift at that tier. */
function money(overrides: { bank?: bigint; card?: bigint; deposit?: bigint } = {}) {
  return computeApprovalPackageMoney({
    bankPaymentPrice: usd(overrides.bank ?? 500_000n),
    regularCardPrice: usd(overrides.card ?? 517_500n),
    depositPaid: usd(overrides.deposit ?? 4_900n),
  });
}

describe("the package's frozen figures", () => {
  it("credits the deposit against BOTH bases, leaving each price intact", () => {
    const result = money();

    // The prices are untouched. The deposit is a credit, not a discount.
    expect(result.bankPaymentPrice.amountMinorUnits).toBe(500_000n);
    expect(result.regularCardPrice.amountMinorUnits).toBe(517_500n);
    expect(result.depositCredit.amountMinorUnits).toBe(4_900n);
    // $5,000 - $49 and $5,175 - $49.
    expect(result.bankPaymentBalanceDue.amountMinorUnits).toBe(495_100n);
    expect(result.regularCardBalanceDue.amountMinorUnits).toBe(512_600n);
  });

  it("the balance is EXACTLY price minus credit on each basis", () => {
    // Swept, because this is the arithmetic a CHECK constraint also enforces
    // and the two must agree.
    for (let bank = 10_000n; bank <= 2_000_000n; bank += 73_331n) {
      const card = (bank * 1035n) / 1000n;
      const result = computeApprovalPackageMoney({
        bankPaymentPrice: usd(bank),
        regularCardPrice: usd(card),
        depositPaid: usd(4_900n),
      });
      expect(result.bankPaymentBalanceDue.amountMinorUnits).toBe(bank - 4_900n);
      expect(result.regularCardBalanceDue.amountMinorUnits).toBe(card - 4_900n);
    }
  });

  it("handles a project with NO deposit paid", () => {
    // Legitimate: a project can reach final approval without a deposit ever
    // having been charged. The balance is then the whole price.
    const result = money({ deposit: 0n });
    expect(result.depositCredit.amountMinorUnits).toBe(0n);
    expect(result.bankPaymentBalanceDue.amountMinorUnits).toBe(500_000n);
    expect(result.regularCardBalanceDue.amountMinorUnits).toBe(517_500n);
  });

  it("CAPS the credit at the LOWER price, so neither basis goes negative", () => {
    // Capping per-basis would let a credit that fits the card price exceed the
    // bank price — and the customer would hit a negative balance the moment
    // they chose bank, after approving. The cap never binds at real prices;
    // it is enforced because "never" is a property of today's prices, not of
    // the code.
    const result = computeApprovalPackageMoney({
      bankPaymentPrice: usd(3_000n),
      regularCardPrice: usd(3_150n),
      depositPaid: usd(4_900n),
    });
    expect(result.depositCredit.amountMinorUnits).toBe(3_000n);
    expect(result.bankPaymentBalanceDue.amountMinorUnits).toBe(0n);
    // The card basis keeps the same credit rather than a larger one.
    expect(result.regularCardBalanceDue.amountMinorUnits).toBe(150n);
    // AND THE PRICES ARE STILL THERE.
    expect(result.bankPaymentPrice.amountMinorUnits).toBe(3_000n);
  });

  it("REFUSES a card price below the bank price", () => {
    // The uplift is at least 3%, so this means the two were transposed —
    // selling the piece for less to the customer paying more.
    expect(() => money({ bank: 500_000n, card: 490_000n })).toThrow(/transposed/i);
  });

  it("REFUSES a non-positive price", () => {
    expect(() => money({ bank: 0n })).toThrow(ApprovalPackageMoneyError);
    expect(() => money({ bank: -1n })).toThrow(ApprovalPackageMoneyError);
  });

  it("REFUSES a negative deposit", () => {
    expect(() => money({ deposit: -4_900n })).toThrow(/cannot be negative/i);
  });

  it("REFUSES mixed currencies", () => {
    expect(() =>
      computeApprovalPackageMoney({
        bankPaymentPrice: usd(500_000n),
        regularCardPrice: Money.fromMinorUnits(517_500n, "CAD"),
        depositPaid: usd(4_900n),
      })
    ).toThrow(/CAD/);
  });
});

describe("what is collected, on the basis chosen", () => {
  it("the CARD basis collects the card balance and records the card gross", () => {
    const result = computeFinalPurchaseAmounts({ money: money(), paymentBasis: "card" });
    expect(result.grossApprovedPrice.amountMinorUnits).toBe(517_500n);
    expect(result.depositCredit.amountMinorUnits).toBe(4_900n);
    expect(result.balanceDue.amountMinorUnits).toBe(512_600n);
  });

  it("the BANK basis collects the bank balance and records the bank gross", () => {
    const result = computeFinalPurchaseAmounts({ money: money(), paymentBasis: "bank_payment" });
    expect(result.grossApprovedPrice.amountMinorUnits).toBe(500_000n);
    expect(result.balanceDue.amountMinorUnits).toBe(495_100n);
  });

  it("the bank basis collects LESS, because the underlying price is lower", () => {
    const card = computeFinalPurchaseAmounts({ money: money(), paymentBasis: "card" });
    const bank = computeFinalPurchaseAmounts({ money: money(), paymentBasis: "bank_payment" });
    expect(bank.balanceDue.amountMinorUnits).toBeLessThan(card.balanceDue.amountMinorUnits);
    // And the gross differs too — which is the honest record of what each
    // customer actually agreed to pay for the piece.
    expect(bank.grossApprovedPrice.amountMinorUnits).toBeLessThan(card.grossApprovedPrice.amountMinorUnits);
  });
});

describe("the fallback benefit alongside the deposit credit", () => {
  it("subtracts BOTH from the gross price, keeping the gross intact", () => {
    // $5,175 card gross, $49 deposit credit, $100 benefit -> $5,026 collected.
    const result = computeFinalPurchaseAmounts({
      money: money(),
      paymentBasis: "card",
      benefitDiscount: usd(10_000n),
    });
    expect(result.grossApprovedPrice.amountMinorUnits).toBe(517_500n);
    expect(result.depositCredit.amountMinorUnits).toBe(4_900n);
    expect(result.benefitDiscount.amountMinorUnits).toBe(10_000n);
    expect(result.balanceDue.amountMinorUnits).toBe(502_600n);
  });

  it("keeps the two reductions SEPARATE in the result", () => {
    // One is a promotional benefit; the other is the customer's own money
    // returning to them. Conflating them would make the deposit look like a
    // discount, which the owner explicitly rejected — and would also make the
    // benefit's own $100 cap unauditable.
    const result = computeFinalPurchaseAmounts({
      money: money(),
      paymentBasis: "card",
      benefitDiscount: usd(10_000n),
    });
    expect(result.depositCredit.amountMinorUnits).not.toBe(result.benefitDiscount.amountMinorUnits);
    expect(
      result.grossApprovedPrice.amountMinorUnits -
        result.depositCredit.amountMinorUnits -
        result.benefitDiscount.amountMinorUnits
    ).toBe(result.balanceDue.amountMinorUnits);
  });

  it("the deposit credit does NOT shrink the benefit's base", () => {
    // The benefit is 10% of the eligible MERCHANDISE subtotal — the jewelry
    // price. The deposit is not a reduction in what the merchandise costs, so
    // a benefit computed from the post-credit balance would be 10% of $49 too
    // small, silently.
    //
    // This asserts the shape that makes that mistake impossible: the gross
    // price this function reports is the full price, so a caller computing 10%
    // of `grossApprovedPrice` gets the right figure.
    const withDeposit = computeFinalPurchaseAmounts({ money: money({ deposit: 4_900n }), paymentBasis: "card" });
    const without = computeFinalPurchaseAmounts({ money: money({ deposit: 0n }), paymentBasis: "card" });
    expect(withDeposit.grossApprovedPrice.amountMinorUnits).toBe(without.grossApprovedPrice.amountMinorUnits);
  });

  it("allows a balance of exactly zero", () => {
    // A legitimate outcome: a small piece, a $100 benefit and a $49 credit can
    // genuinely meet the price.
    const result = computeFinalPurchaseAmounts({
      money: computeApprovalPackageMoney({
        bankPaymentPrice: usd(14_900n),
        regularCardPrice: usd(15_645n),
        depositPaid: usd(4_900n),
      }),
      paymentBasis: "bank_payment",
      benefitDiscount: usd(10_000n),
    });
    expect(result.balanceDue.amountMinorUnits).toBe(0n);
    expect(result.grossApprovedPrice.amountMinorUnits).toBe(14_900n);
  });

  it("REFUSES reductions that exceed the price rather than flooring at zero", () => {
    // Flooring would hide a benefit computed against the wrong base while
    // handing over the goods. Zero is a legitimate balance; negative is a bug.
    expect(() =>
      computeFinalPurchaseAmounts({
        money: computeApprovalPackageMoney({
          bankPaymentPrice: usd(10_000n),
          regularCardPrice: usd(10_500n),
          depositPaid: usd(4_900n),
        }),
        paymentBasis: "bank_payment",
        benefitDiscount: usd(10_000n),
      })
    ).toThrow(/exceeds the approved price/i);
  });

  it("REFUSES a negative benefit", () => {
    expect(() =>
      computeFinalPurchaseAmounts({ money: money(), paymentBasis: "card", benefitDiscount: usd(-1n) })
    ).toThrow(/cannot be negative/i);
  });

  it("REFUSES a benefit in another currency", () => {
    expect(() =>
      computeFinalPurchaseAmounts({
        money: money(),
        paymentBasis: "card",
        benefitDiscount: Money.fromMinorUnits(10_000n, "CAD"),
      })
    ).toThrow(/CAD/);
  });
});
