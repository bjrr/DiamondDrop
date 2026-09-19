import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type { CreditCardPriceRuleId } from "./types";

/**
 * L5 — credit-card price derivation (D9, owner-locked 2026-09-18).
 *
 * THE LAST STEP, AND THE ONLY STEP THAT KNOWS ABOUT CARDS:
 *
 *   CASH PRICE        everything upstream. Landed cost, the 40% target markup,
 *                     the 20% gross-margin floor, the $100 minimum profit, every
 *                     variant floor, Group Buy tier prices and Group Buy tier
 *                     safety are ALL computed on the cash price. Cash-equivalent
 *                     methods: ACH, wire, Zelle, check.
 *   CREDIT CARD PRICE derived here, and here only, as
 *                     cash x (1 + upliftRate) with upliftRate = 0.05.
 *
 * THE UPLIFT IS NOT PART OF PRODUCT ECONOMICS. It is not margin, it is not
 * Group Buy discount headroom, and it must never appear in a profitability
 * calculation. Cost, markup, margin floors, minimum profit, tier discounts and
 * tier safety are all finished before this function is called, and none of them
 * takes its result as an input. That ordering is the rule; this module being
 * the last link in the chain is how the rule is kept.
 *
 * CUSTOMER-FACING PRESENTATION. The credit-card price is the primary displayed
 * price; the cash price is shown alongside it as the discounted payment option.
 * A $2,000 cash price displays as $2,100 with $2,000 available cash-equivalent.
 * Group Buy is the same shape: a $1,800 group cash price displays as a $1,890
 * Group Buy price with $1,800 cash-equivalent.
 *
 * WHY CARD IS THE HEADLINE. Owner decision, docs/CASH-CARD-PRICING.md §5: the
 * card price is the primary customer-facing and Shopify price, and the
 * cash-equivalent price is shown as the discounted price for ACH, wire, Zelle
 * or check. Checkout, network and legal constraints are verified separately and
 * do not change this pricing-domain rule.
 *
 * ONE PRICE IS STORED. The card price is a pure function of the cash price and
 * the rate, both recorded on every calculation, so it is re-derivable forever
 * and there is no second independently editable price anywhere.
 */

export interface CreditCardPriceRule {
  readonly id: CreditCardPriceRuleId;
  /**
   * Returns the credit-card price in WHOLE MINOR UNITS, already rounded. This
   * rule owns its rounding rather than deferring to the profile's price-ending
   * rule, because the direction is part of the rule's meaning — see below.
   */
  readonly derive: (cashMinorUnits: bigint, upliftRate: MoneyDecimalValue) => bigint;
}

const REGISTRY: Record<CreditCardPriceRuleId, CreditCardPriceRule> = {
  /**
   * creditCard = ceil_to_whole_dollar(cash x (1 + rate)).
   *
   * CEILING, for the same reason the list price rounds up: rounding a derived
   * price DOWN would put the card price below the uplift the configuration
   * asked for. Rounding up can only ever widen the gap.
   *
   * NO DISCOUNT PERCENTAGE MAY EVER BE ADVERTISED. Owner decision: the
   * storefront shows the credit-card price and the cash price, and states no
   * percentage.
   *
   * That closes a real trap rather than merely picking a wording. A 5% UPLIFT
   * is not a 5% DISCOUNT — it is the reciprocal. $2,000 cash gives a $2,100
   * card price, and $2,000 is 4.76% off $2,100. With whole-dollar rounding the
   * realised saving lands between roughly 4.76% and 4.95% and varies per item,
   * so ANY fixed percentage claim would be wrong on most of the catalogue.
   *
   * Two absolute prices are always exactly right, need no caveat, and cannot
   * drift out of step with the rate. Nothing in this module or in
   * BuyNowPriceResult exposes such a percentage, and nothing should start to.
   *
   * (Were a clean 5%-off-displayed ever wanted instead, the uplift would be
   * 1/0.95 − 1 = 0.052632 rather than 0.05. Recorded because the rate is
   * configurable, so it is a data change — not because it is planned.)
   */
  CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1: {
    id: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
    derive: (cashMinorUnits, upliftRate) => {
      const exact = new MoneyDecimal(cashMinorUnits.toString()).times(
        new MoneyDecimal(1).plus(upliftRate)
      );
      // Exact decimal throughout, then a single ceiling to whole dollars.
      // decimal.js's own ceil, never a JS numeric path: the value can exceed
      // what a double represents exactly on high-value pieces.
      return BigInt(exact.dividedBy(100).ceil().times(100).toString());
    },
  },
};

export class UnknownCreditCardPriceRuleError extends Error {
  constructor(readonly id: string) {
    super(`Unknown credit card price rule id "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownCreditCardPriceRuleError";
  }
}

export function getCreditCardPriceRule(id: CreditCardPriceRuleId): CreditCardPriceRule {
  const rule = REGISTRY[id];
  if (!rule) throw new UnknownCreditCardPriceRuleError(id);
  return rule;
}

/**
 * The ONLY way a credit-card price is produced anywhere in the codebase.
 *
 * Takes a finalised cash price — after rounding, price ending and every floor
 * bump. Deriving from an unfinished value would let the two prices disagree.
 */
export function deriveCreditCardPrice(
  cashMinorUnits: bigint,
  upliftRate: MoneyDecimalValue,
  ruleId: CreditCardPriceRuleId
): bigint {
  return getCreditCardPriceRule(ruleId).derive(cashMinorUnits, upliftRate);
}
