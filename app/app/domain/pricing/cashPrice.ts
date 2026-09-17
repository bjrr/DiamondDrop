import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type { CashPriceRuleId } from "./types";

/**
 * L5 — cash-price derivation (D9, owner-REVISED 2026-09-17).
 *
 * THE MODEL, AND WHICH WAY ROUND IT GOES. The calculated price is the LIST
 * price, and the list price is the CARD price: it carries card processing and
 * it is what gets published. Cash-equivalent customers — ACH, wire, Zelle,
 * cheque — pay `list x (1 - cashDiscountRate)`, because they do not cost us
 * that fee. The owner's stated purpose is to encourage cash payment.
 *
 * This inverts the first implementation (cash base, card = base x 1.05) and the
 * two are NOT equivalent. 5% off list is a 5.26% card-to-cash spread. Getting
 * the direction wrong silently changes every price by a quarter of a percent,
 * which is exactly the sort of error that survives review because the numbers
 * still look reasonable.
 *
 * THE DISCOUNT OVERRIDES THE PROFIT MINIMUMS. Owner instruction, verbatim:
 * "5% should override any profit minimums." So the floors bind the LIST price
 * only, and the cash price is permitted to fall below the minimum dollar
 * profit. With the MVP1 numbers that happens on anything under $303.03 of
 * landed cost. It is deliberate, it is recorded on every calculation, and it
 * must not be "fixed" by clamping the cash price up to the floor — that would
 * quietly cancel the discount on exactly the items it was meant for.
 *
 * What the override does NOT extend to is producing a non-price: the rate is
 * constrained to [0, 1) at the database, so cash can never reach zero.
 *
 * Only ONE price is ever stored. The cash price is a pure function of the list
 * price and the rate, both recorded on the calculation, so it is re-derivable
 * forever. The owner's original constraint still holds: there is no second,
 * independently editable price anywhere in the system.
 */

export interface CashPriceRule {
  readonly id: CashPriceRuleId;
  /**
   * Returns the cash price in WHOLE MINOR UNITS, already rounded. Unlike the
   * other registries this rule owns its own rounding, because the direction is
   * part of the rule's meaning rather than a separate policy — see below.
   */
  readonly derive: (
    listMinorUnits: bigint,
    discountRate: MoneyDecimalValue
  ) => bigint;
}

const REGISTRY: Record<CashPriceRuleId, CashPriceRule> = {
  /**
   * cash = floor_to_whole_dollar(list x (1 - rate)).
   *
   * FLOORED, NOT ROUNDED, AND THAT IS THE POINT. The rounding direction is
   * baked into the rule id rather than taken from the profile's price-ending
   * rule, because for a discount the direction is a truth-in-advertising
   * question, not a presentation one.
   *
   * A $349 list at 5% is $331.55. Rounding UP to $332 delivers a 4.87%
   * discount while the site advertises 5% — understating a published discount
   * on every affected item. Flooring to $331 delivers 5.16%: the customer
   * always receives at LEAST the advertised rate. The few cents per order are
   * worth not having an advertised number the system quietly fails to honour.
   *
   * Note this is the opposite direction from WHOLE_DOLLAR_UP_V1, which the list
   * price uses. Both choices are made for the same underlying reason — never
   * land on the wrong side of a commitment — and they point opposite ways
   * because one is a price and the other is a discount off it.
   */
  CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1: {
    id: "CASH_DISCOUNT_FLOOR_WHOLE_DOLLAR_V1",
    derive: (listMinorUnits, discountRate) => {
      const exact = new MoneyDecimal(listMinorUnits.toString()).times(
        new MoneyDecimal(1).minus(discountRate)
      );
      // Exact decimal throughout, then a single floor to whole dollars. Using
      // decimal.js's own floor rather than any JS numeric path: the value can
      // exceed what a double represents exactly on high-value pieces.
      const wholeDollars = exact.dividedBy(100).floor();
      return BigInt(wholeDollars.times(100).toString());
    },
  },
};

export class UnknownCashPriceRuleError extends Error {
  constructor(readonly id: string) {
    super(`Unknown cash price rule id "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownCashPriceRuleError";
  }
}

export function getCashPriceRule(id: CashPriceRuleId): CashPriceRule {
  const rule = REGISTRY[id];
  if (!rule) throw new UnknownCashPriceRuleError(id);
  return rule;
}

export function deriveCashPrice(
  listMinorUnits: bigint,
  discountRate: MoneyDecimalValue,
  ruleId: CashPriceRuleId
): bigint {
  return getCashPriceRule(ruleId).derive(listMinorUnits, discountRate);
}
