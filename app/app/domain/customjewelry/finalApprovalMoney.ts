import { Money } from "~/domain/money/money";

/**
 * The money on a Custom Jewelry final approval package.
 *
 * ============================================================================
 * THE DEPOSIT IS A CREDIT, NOT A DISCOUNT — and the difference is the point
 * ============================================================================
 * Owner requirement, stated plainly: "Treat the $49 already paid as a deposit
 * credit, not as a promotional discount."
 *
 * A discount reduces the PRICE. A credit reduces what is COLLECTED while the
 * price stands. That is not bookkeeping pedantry:
 *
 *   - the gross approved price is what the piece sold for, and margin,
 *     warranty reserve and refund economics all reason about it;
 *   - a refund after a covered defect returns the price, not the balance;
 *   - the Let Us Beat Your Quote benefit is 10% of the eligible MERCHANDISE
 *     subtotal, and if the deposit were a discount the benefit would be
 *     calculated on a reduced base — quietly shrinking a benefit the customer
 *     was promised;
 *   - "the deposit is not promotional stacking" (the owner's words) is only
 *     coherent if the deposit was never a promotion to begin with.
 *
 * So `grossPrice` survives in its own field everywhere, and the balance is
 * derived from it rather than replacing it.
 *
 * ============================================================================
 * BOTH BASES ARE COMPUTED, BECAUSE THE CUSTOMER HAS NOT CHOSEN YET
 * ============================================================================
 * The owner allows either basis at final checkout. The customer approves "the
 * final price shown" before picking a path, so both figures are frozen into
 * the package — deriving one at purchase time would mean the approved price
 * and the charged price came from different moments.
 *
 * NOTHING HERE DERIVES THE CARD PRICE. `deriveRegularCardPrice` in
 * `~/domain/pricing/regularCardPrice` owns that, under the locked tiered rule,
 * and this module takes the result. A second derivation would be a second
 * pricing engine.
 */

export class ApprovalPackageMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalPackageMoneyError";
  }
}

export interface ApprovalPackageMoneyInput {
  /** The authoritative underlying figure for the finished piece. */
  readonly bankPaymentPrice: Money;
  /**
   * Derived from it by `deriveRegularCardPrice`, passed in rather than
   * computed here — see the module header.
   */
  readonly regularCardPrice: Money;
  /**
   * What the customer ACTUALLY paid as a Design Deposit, read from the
   * recorded payment. Zero is legitimate: a project can reach final approval
   * without a deposit having been charged.
   */
  readonly depositPaid: Money;
}

export interface ApprovalPackageMoney {
  readonly bankPaymentPrice: Money;
  readonly regularCardPrice: Money;
  readonly depositPaid: Money;
  /** What the deposit actually offsets. See `computeApprovalPackageMoney`. */
  readonly depositCredit: Money;
  readonly bankPaymentBalanceDue: Money;
  readonly regularCardBalanceDue: Money;
}

/**
 * The frozen figures for a package.
 *
 * THE CREDIT IS CAPPED AT THE LOWER PRICE, NOT AT EACH SEPARATELY. A credit
 * sized to the card price could exceed the bank price, and the customer would
 * hit a negative balance the moment they chose the bank path — after
 * approving. Capping once, at the smaller figure, means the same credit is
 * honoured whichever path they take, which is also the only way the customer
 * can compare the two honestly.
 *
 * In practice the cap never binds: a $49 deposit against a jewelry price is
 * not a close-run thing. It is enforced because "never" is a property of
 * today's prices, not of the code.
 */
export function computeApprovalPackageMoney(input: ApprovalPackageMoneyInput): ApprovalPackageMoney {
  const currency = input.bankPaymentPrice.currency;
  for (const [label, money] of [
    ["regular/card price", input.regularCardPrice],
    ["deposit paid", input.depositPaid],
  ] as const) {
    if (money.currency !== currency) {
      throw new ApprovalPackageMoneyError(
        `the ${label} is in ${money.currency} but the bank payment price is in ${currency}`
      );
    }
  }

  if (input.bankPaymentPrice.amountMinorUnits <= 0n) {
    throw new ApprovalPackageMoneyError("a final approval package needs a positive bank payment price");
  }
  if (input.depositPaid.amountMinorUnits < 0n) {
    throw new ApprovalPackageMoneyError("the deposit paid cannot be negative");
  }
  // THE CARD PRICE IS NEVER BELOW THE BANK PRICE. The uplift is at least 3%
  // (CLAUDE.md rule 12), so a lower card price means the two were transposed —
  // which would sell the piece for less to the customer paying more. Refused
  // here and again by a CHECK, because a transposition is silent otherwise.
  if (input.regularCardPrice.amountMinorUnits < input.bankPaymentPrice.amountMinorUnits) {
    throw new ApprovalPackageMoneyError(
      `the card price ${input.regularCardPrice.amountMinorUnits} is below the bank payment price ` +
        `${input.bankPaymentPrice.amountMinorUnits}; the card price is derived upward from it, so these look transposed`
    );
  }

  const credit =
    input.depositPaid.amountMinorUnits > input.bankPaymentPrice.amountMinorUnits
      ? input.bankPaymentPrice.amountMinorUnits
      : input.depositPaid.amountMinorUnits;

  return {
    bankPaymentPrice: input.bankPaymentPrice,
    regularCardPrice: input.regularCardPrice,
    depositPaid: input.depositPaid,
    depositCredit: Money.fromMinorUnits(credit, currency),
    bankPaymentBalanceDue: Money.fromMinorUnits(
      input.bankPaymentPrice.amountMinorUnits - credit,
      currency
    ),
    regularCardBalanceDue: Money.fromMinorUnits(
      input.regularCardPrice.amountMinorUnits - credit,
      currency
    ),
  };
}

export type CustomJewelryPaymentBasis = "card" | "bank_payment";

export interface FinalPurchaseAmountsInput {
  readonly money: ApprovalPackageMoney;
  readonly paymentBasis: CustomJewelryPaymentBasis;
  /**
   * The Let Us Beat Your Quote benefit, if one was redeemed. SEPARATE from the
   * deposit credit, because one is a promotional benefit and the other is the
   * customer's own money returning to them.
   */
  readonly benefitDiscount?: Money;
}

export interface FinalPurchaseAmounts {
  /** What the piece sold for. Never reduced by either credit. */
  readonly grossApprovedPrice: Money;
  readonly depositCredit: Money;
  readonly benefitDiscount: Money;
  readonly balanceDue: Money;
}

/**
 * What is actually collected, on the basis the customer chose.
 *
 * ============================================================================
 * THE BENEFIT COMES OFF THE GROSS PRICE, NOT OFF THE BALANCE
 * ============================================================================
 * The Let Us Beat Your Quote benefit is 10% of the eligible MERCHANDISE
 * subtotal, capped at $100. The merchandise subtotal is the jewelry price —
 * the deposit credit is not a reduction in what the merchandise costs, it is
 * money the customer already handed over against it.
 *
 * Calculating the benefit on the post-credit balance would shrink it by 10% of
 * the deposit, which is both wrong and invisible. So the caller computes the
 * benefit from the gross price, and both reductions are subtracted from that
 * same gross figure here.
 *
 * THE ORDER OF SUBTRACTION DOES NOT MATTER ARITHMETICALLY, and that is the
 * point: because both are fixed amounts against one base rather than
 * percentages applied in sequence, there is no "which applies first" question
 * to get wrong.
 */
export function computeFinalPurchaseAmounts(input: FinalPurchaseAmountsInput): FinalPurchaseAmounts {
  const grossApprovedPrice =
    input.paymentBasis === "bank_payment" ? input.money.bankPaymentPrice : input.money.regularCardPrice;
  const currency = grossApprovedPrice.currency;
  const benefitDiscount = input.benefitDiscount ?? Money.fromMinorUnits(0n, currency);

  if (benefitDiscount.currency !== currency) {
    throw new ApprovalPackageMoneyError(
      `the benefit discount is in ${benefitDiscount.currency} but the price is in ${currency}`
    );
  }
  if (benefitDiscount.amountMinorUnits < 0n) {
    throw new ApprovalPackageMoneyError("a benefit discount cannot be negative");
  }

  const reductions = input.money.depositCredit.amountMinorUnits + benefitDiscount.amountMinorUnits;
  if (reductions > grossApprovedPrice.amountMinorUnits) {
    // REFUSED, NOT CLAMPED TO ZERO. A balance of zero would be a legitimate
    // outcome of a large benefit; reductions EXCEEDING the price means
    // somebody computed the benefit against the wrong base, and silently
    // flooring it would hide that while handing over the goods.
    throw new ApprovalPackageMoneyError(
      `the deposit credit (${input.money.depositCredit.amountMinorUnits}) plus the benefit ` +
        `(${benefitDiscount.amountMinorUnits}) exceeds the approved price ` +
        `(${grossApprovedPrice.amountMinorUnits}) on the ${input.paymentBasis} basis`
    );
  }

  return {
    grossApprovedPrice,
    depositCredit: input.money.depositCredit,
    benefitDiscount,
    balanceDue: Money.fromMinorUnits(grossApprovedPrice.amountMinorUnits - reductions, currency),
  };
}
