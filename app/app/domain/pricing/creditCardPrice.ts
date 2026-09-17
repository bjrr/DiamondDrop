import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type { CreditCardPriceRuleId } from "./types";

/**
 * L5 — credit-card price derivation (D9, owner-resolved 2026-09-17).
 *
 * THE OWNER'S CONSTRAINT, AND WHY THIS FILE IS SHAPED THIS WAY. The instruction
 * was: "Do not independently maintain a manually editable credit-card price and
 * cash price." So there is exactly one stored price — the cash-equivalent base
 * (ACH, wire, Zelle, cheque) — and the card price is a pure function of it.
 * Nothing in the system may write a card price directly; if you find yourself
 * wanting a `credit_card_price` column, that is the bug this file prevents.
 *
 * The RULE ID versions the formula. The RATE, held on the pricing profile,
 * makes the number configurable without a deploy. Both are recorded on every
 * calculation, so a historical card price can be re-derived exactly.
 *
 * Same immutability contract as the rounding and price-ending registries: an id
 * referenced by a stored calculation may never change behaviour. Add a new id.
 */

export interface CreditCardPriceRule {
  readonly id: CreditCardPriceRuleId;
  /**
   * Returns the EXACT card price in minor units, unrounded. Rounding is the
   * caller's job, and deliberately so: the cash and card prices must pass
   * through the one rounding boundary (§5.4) rather than each inventing their
   * own, or the two prices could disagree about what a cent is.
   */
  readonly derive: (
    baseMinorUnits: MoneyDecimalValue,
    upliftRate: MoneyDecimalValue
  ) => MoneyDecimalValue;
}

const REGISTRY: Record<CreditCardPriceRuleId, CreditCardPriceRule> = {
  /**
   * card = cash x (1 + upliftRate). With the MVP1 rate of 0.05 this is the
   * owner's `credit_card_price = base x 1.05`.
   *
   * Multiplicative rather than additive on purpose: card processing is charged
   * as a percentage of the transaction, so a flat surcharge would under-recover
   * on expensive pieces and over-recover on cheap ones.
   */
  MULTIPLY_BASE_V1: {
    id: "MULTIPLY_BASE_V1",
    derive: (base, upliftRate) => base.times(new MoneyDecimal(1).plus(upliftRate)),
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

export function deriveCreditCardPrice(
  baseMinorUnits: MoneyDecimalValue,
  upliftRate: MoneyDecimalValue,
  ruleId: CreditCardPriceRuleId
): MoneyDecimalValue {
  return getCreditCardPriceRule(ruleId).derive(baseMinorUnits, upliftRate);
}
