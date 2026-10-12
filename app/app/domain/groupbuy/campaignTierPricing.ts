import type { DualPrice } from "./campaignProgress";
import { tierBankPaymentPriceExact, type TierDefinition } from "./tiers";
import { MoneyDecimal, type MoneyDecimalValue } from "../money/decimal";
import { Money } from "../money/money";
import type { RoundingRuleId } from "../money/rounding";
import { applyPriceEnding } from "../pricing/priceEnding";
import { deriveRegularCardPrice } from "../pricing/regularCardPrice";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "../pricing/types";

/**
 * WHAT A CAMPAIGN'S TIERS COST, derived from what it froze. One definition,
 * used by every surface that quotes a Group Buy price.
 *
 * ============================================================================
 * WHY THIS IS A MODULE AND NOT INLINE AT EACH CALL SITE
 * ============================================================================
 * It was inline, in the live progress route, and correct there. Then the
 * public Past Group Buys archive needed the same figures for closed
 * campaigns, and a second copy of a money derivation is the failure this
 * codebase keeps writing comments about: the copies agree until one is
 * updated, and the disagreement is invisible because every individual number
 * stays plausible.
 *
 * `tests/integration/groupbuy/frozenRuleVersioning.test.ts` exists precisely
 * because that already happened once with hardcoded rule ids.
 *
 * ============================================================================
 * EVERY RULE IS AN ARGUMENT. NONE IS READ FROM TODAY'S CONFIGURATION.
 * ============================================================================
 * The caller passes the rules from the campaign's FROZEN pricing profile. A
 * campaign records the profile it froze at open; consulting the current one
 * instead would let a later change of card, rounding or price-ending rule move
 * the advertised price of a campaign customers already joined — and would make
 * a settlement refund disagree with the price that was quoted.
 *
 * This module therefore has no database access and no defaults. A missing rule
 * is the caller's error to handle, not something to substitute for.
 *
 * ============================================================================
 * THE TIER IS SELECTED PER PRICE, NOT PER CAMPAIGN
 * ============================================================================
 * Each tier's bank payment price goes through the card rule separately, so a
 * campaign whose tiers straddle a card-tier boundary gets the correct rate at
 * each one. A $1,020 tier-1 price takes 4.0% while a $918 tier-2 price takes
 * 4.5%; deriving both from one rate chosen off the campaign base would
 * overcharge or undercharge the other.
 *
 * BANK PAYMENT PRICE FIRST, CARD DERIVED FROM IT (CLAUDE.md rules 11-12). The
 * order is not stylistic: the bank payment price is the authoritative selling
 * price, and only the card price is rounded up to the next $5.
 */

export interface FrozenCampaignPricingRules {
  readonly currency: string;
  /** From the campaign's frozen pricing profile — never today's. */
  readonly fixedCardUpliftRate: MoneyDecimalValue;
  readonly regularCardPriceRuleId: RegularCardPriceRuleId;
  readonly roundingRuleId: RoundingRuleId;
  readonly priceEndingRuleId: PriceEndingRuleId;
}

/**
 * The Regular/Card Price for a bank payment price, under the supplied frozen
 * rule. Exported because callers also need it for prices that are not tier
 * prices (a Buy Now comparison figure, for instance).
 */
export function dualPriceFrom(
  bankPaymentMinorUnits: bigint,
  fixedCardUpliftRate: MoneyDecimalValue,
  regularCardPriceRuleId: RegularCardPriceRuleId
): DualPrice {
  return {
    bankPaymentMinorUnits,
    regularCardMinorUnits: deriveRegularCardPrice(
      bankPaymentMinorUnits,
      fixedCardUpliftRate,
      regularCardPriceRuleId
    ).regularCardPriceMinorUnits,
  };
}

/**
 * Every tier's price for ONE variant, keyed by tier number.
 *
 * `frozenBaseBankPaymentPriceMinorUnits` is the variant's price as frozen at
 * open — read from the row, never recomputed from current costs (CLAUDE.md
 * rule 7).
 */
export function campaignTierDualPrices(
  frozenBaseBankPaymentPriceMinorUnits: bigint,
  tiers: readonly TierDefinition[],
  rules: FrozenCampaignPricingRules
): Record<number, DualPrice> {
  const prices: Record<number, DualPrice> = {};
  for (const tier of tiers) {
    const exactBankPayment = tierBankPaymentPriceExact(
      new MoneyDecimal(frozenBaseBankPaymentPriceMinorUnits.toString()),
      tier
    );
    // Rounded through the same registries the engine uses, so a customer is
    // quoted what they would actually be charged.
    const rounded = Money.fromDecimalMinorUnits(exactBankPayment, rules.currency, rules.roundingRuleId);
    prices[tier.tierNumber] = dualPriceFrom(
      applyPriceEnding(rounded.amountMinorUnits, rules.priceEndingRuleId),
      rules.fixedCardUpliftRate,
      rules.regularCardPriceRuleId
    );
  }
  return prices;
}
