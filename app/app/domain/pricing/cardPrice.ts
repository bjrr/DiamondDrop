import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type { CardPriceRuleId } from "./types";

/**
 * L5 — card-price derivation (D9, owner-clarified 2026-09-17, final shape).
 *
 * TWO PRICES, ONE CALCULATION, AND IT MATTERS WHICH IS WHICH:
 *
 *   INTERNAL   the calculated price is the CASH-EQUIVALENT price (ACH, wire,
 *              Zelle, check). It is the authoritative business price, it is what the margin
 *              floors bind, and it is what profit is measured on.
 *   DISPLAYED  the CARD price, cash x (1 + upliftRate), is what the customer
 *              sees and what is published to Shopify. Cash is presented to the
 *              customer as a discount off it.
 *
 * THE PUBLISHED PRICE IS THE CARD PRICE. `price_calculation` stores the CASH
 * price, so a sync layer that publishes the stored price undercharges every
 * card customer by the uplift — quietly, and on every item. Slice 2 must
 * publish `BuyNowPriceResult.cardPrice`, not `price`.
 *
 * WHY THE FLOORS BIND THE LOWER PRICE. Binding them to the displayed card
 * price would leave cash sales — potentially most of them — unprotected, and
 * an earlier revision of this decision did exactly that, putting four of seven
 * fixture prices under the $100 minimum. Binding the cash price means both
 * prices clear every floor by construction, and the
 * discount-overrides-the-minimums carve-out that revision needed is gone.
 *
 * WHY CARD IS THE HEADLINE. Owner decision 2026-09-18: the card price is the
 * primary customer-facing/Shopify price and the cash-equivalent price is shown
 * as the discounted price for ACH, wire, Zelle, or check. Checkout/legal/network
 * constraints are verified separately; they do not change the pricing-domain
 * rule. Payment-processing expense does not feed back into the cash floors.
 *
 * ONE PRICE IS STORED. The card price is a pure function of the cash price and
 * the rate, both recorded on every calculation, so it is re-derivable forever
 * and there is no second independently editable price anywhere.
 */

export interface CardPriceRule {
  readonly id: CardPriceRuleId;
  /**
   * Returns the card price in WHOLE MINOR UNITS, already rounded. This rule
   * owns its rounding rather than deferring to the profile's price-ending rule,
   * because the direction is part of the rule's meaning — see below.
   */
  readonly derive: (cashMinorUnits: bigint, upliftRate: MoneyDecimalValue) => bigint;
}

const REGISTRY: Record<CardPriceRuleId, CardPriceRule> = {
  /**
   * card = ceil_to_whole_dollar(cash x (1 + rate)).
   *
   * CEILING, for the same reason the list price rounds up: rounding a derived
   * price DOWN would put the card price below the uplift the configuration
   * asked for, and on a thin item could erode the very processing cost the
   * uplift exists to cover. Rounding up can only ever widen the gap.
   *
   * NO DISCOUNT PERCENTAGE MAY EVER BE ADVERTISED. Owner decision,
   * 2026-09-17: the storefront shows the card price and the cash price, and
   * states no percentage.
   *
   * That decision closes a real trap rather than merely picking a wording. A
   * 5% UPLIFT is not a 5% DISCOUNT — it is the reciprocal. $400 cash gives a
   * $420 card price, and $400 is 4.76% off $420. With whole-dollar rounding the
   * realised saving lands between roughly 4.76% and 4.95% and varies per item,
   * so ANY fixed percentage claim would be wrong on most of the catalogue.
   *
   * Two absolute prices are always exactly right, need no caveat, and cannot
   * drift out of step with the rate. Nothing in this module or in
   * BuyNowPriceResult exposes a percentage, and nothing should start to: if a
   * storefront needs a saving to display, use the dollar difference between the
   * two prices, which is exact by construction.
   *
   * (Were a clean 5%-off-displayed ever wanted instead, the uplift would be
   * 1/0.95 - 1 = 0.052632 rather than 0.05. Recorded because the rate is
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

export class UnknownCardPriceRuleError extends Error {
  constructor(readonly id: string) {
    super(`Unknown card price rule id "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownCardPriceRuleError";
  }
}

export function getCardPriceRule(id: CardPriceRuleId): CardPriceRule {
  const rule = REGISTRY[id];
  if (!rule) throw new UnknownCardPriceRuleError(id);
  return rule;
}

export function deriveCardPrice(
  cashMinorUnits: bigint,
  upliftRate: MoneyDecimalValue,
  ruleId: CardPriceRuleId
): bigint {
  return getCardPriceRule(ruleId).derive(cashMinorUnits, upliftRate);
}
