import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type { DecimalString, RegularCardPriceRuleId } from "./types";

/**
 * L5 — Regular/Card price derivation (docs/BANK-CARD-PRICING.md, owner-locked
 * 2026-09-18).
 *
 * THE LAST STEP, AND THE ONLY STEP THAT KNOWS ABOUT CARDS:
 *
 *   BANK PAYMENT PRICE  everything upstream. Landed cost, the 40% target
 *                       markup, the 20% gross-margin floor, the $100 minimum
 *                       profit, every variant floor, Group Buy tier prices and
 *                       Group Buy tier safety are ALL computed on it. Eligible
 *                       methods: Zelle, bank transfer, designated ACH, wire,
 *                       and future explicitly approved bank/manual methods.
 *   REGULAR/CARD PRICE  derived here, and here only. The primary advertised
 *                       price and the one published to Shopify.
 *
 * THE BANK PAYMENT PRICE IS RETURNED UNCHANGED. Not re-rounded, not nudged, not
 * re-derived. §2 of the policy states it three times, and the reason is that
 * every floor, freeze and refund in the system is already pinned to that exact
 * number — a rounding applied "harmlessly" here would silently disagree with
 * all of them. This module's functions take it as an already-finalised bigint
 * and hand the same bigint back.
 *
 * THE UPLIFT IS NOT PART OF PRODUCT ECONOMICS. It is not margin, it is not
 * Group Buy discount headroom, and it must never appear in a profitability
 * calculation. Everything that governs profit finishes before this is called,
 * and none of it takes the result as an input. That ordering is the rule; this
 * module being the last link in the chain is how the rule is kept.
 *
 * THE PERCENTAGE IS INTERNAL. Policy §6: no percentage, no "cash discount", no
 * "card fee", no "surcharge" reaches a customer. Only two absolute prices and
 * one absolute saving. `appliedUpliftRate` is returned for audit and admin, and
 * the storefront DTO deliberately has no field to carry it.
 */

/** Minor units in one dollar, and in the $5 card-price increment. */
const ONE_DOLLAR_MINOR_UNITS = 100n;
const CARD_PRICE_INCREMENT_MINOR_UNITS = 5n * ONE_DOLLAR_MINOR_UNITS;

/**
 * The locked tier table (policy §3), in MINOR UNITS so the boundaries are
 * exact integers rather than decimal comparisons that could go either way at
 * $499.995.
 *
 * `minBankPaymentMinorUnits` is INCLUSIVE and the table is searched from the
 * top down, so each row means "at least this much". Expressed that way the
 * upper bounds ($499.99, $999.99, …) never have to be written at all — and an
 * upper bound written as 49999 is exactly how a price of $499.995 would fall
 * through every row and match nothing.
 *
 * THE TABLE LIVES IN THE RULE, NOT IN THE PROFILE. Policy §12: the rule owns
 * tier selection and the applicable percentage. Changing a threshold or a rate
 * is therefore a NEW RULE ID, reviewed, with every historical calculation still
 * reproducing under the old one — not a data edit that silently re-prices the
 * past.
 */
export interface CardUpliftTier {
  readonly minBankPaymentMinorUnits: bigint;
  readonly rate: DecimalString;
  /** Human label for admin/audit surfaces. Never customer-facing. */
  readonly label: string;
}

export const BANK_TIERED_UPLIFT_TIERS_V1: readonly CardUpliftTier[] = [
  { minBankPaymentMinorUnits: 500_000n, rate: "0.030000", label: "$5,000 and above" },
  { minBankPaymentMinorUnits: 250_000n, rate: "0.035000", label: "$2,500–$4,999.99" },
  { minBankPaymentMinorUnits: 100_000n, rate: "0.040000", label: "$1,000–$2,499.99" },
  { minBankPaymentMinorUnits: 50_000n, rate: "0.045000", label: "$500–$999.99" },
  { minBankPaymentMinorUnits: 0n, rate: "0.050000", label: "Under $500" },
];

/**
 * Policy §3: "The card-price increase must never be less than 3%." Asserted at
 * module load rather than trusted, because the table is the one place a typo
 * would under-price every item in a band without failing anything else.
 */
for (const tier of BANK_TIERED_UPLIFT_TIERS_V1) {
  if (new MoneyDecimal(tier.rate).lessThan("0.03")) {
    throw new Error(
      `Card uplift tier "${tier.label}" is ${tier.rate}, below the 3% floor in docs/BANK-CARD-PRICING.md §3.`
    );
  }
}

export interface RegularCardPriceResult {
  /** Unchanged, byte for byte, from the input. */
  readonly bankPaymentPriceMinorUnits: bigint;
  /** Preliminary price ceilinged to the next $5. The primary advertised price. */
  readonly regularCardPriceMinorUnits: bigint;
  /** Final rounded card price − bank payment price (policy §9). */
  readonly bankPaymentSavingsMinorUnits: bigint;
  /** INTERNAL ONLY — audit and admin. Never sent to a storefront. */
  readonly appliedUpliftRate: DecimalString;
  /** INTERNAL ONLY — which tier row matched, for admin explanation. */
  readonly appliedTierLabel: string;
}

export interface RegularCardPriceRule {
  readonly id: RegularCardPriceRuleId;
  /**
   * `configuredRate` is the profile's fixed rate. Only the legacy fixed rule
   * reads it; the tiered rule selects its own rate and ignores the argument
   * entirely. Kept in the signature so the engine can call either rule without
   * branching on which one it got — the registry pattern this file shares with
   * rounding, price-ending and margin models.
   */
  readonly derive: (
    bankPaymentPriceMinorUnits: bigint,
    configuredRate: MoneyDecimalValue
  ) => RegularCardPriceResult;
}

/** Policy §3. Exported so admin surfaces can explain a price without re-deriving it. */
export function selectCardUpliftTier(bankPaymentPriceMinorUnits: bigint): CardUpliftTier {
  const tier = BANK_TIERED_UPLIFT_TIERS_V1.find(
    (t) => bankPaymentPriceMinorUnits >= t.minBankPaymentMinorUnits
  );
  // The last row starts at 0 and prices are non-negative, so this cannot miss.
  // Throwing rather than defaulting anyway: a silent 0% would be the one
  // failure mode that loses money on every item and looks like a clean price.
  if (!tier) {
    throw new Error(
      `No card uplift tier matched bank payment price ${bankPaymentPriceMinorUnits} minor units.`
    );
  }
  return tier;
}

/** Policy §4: CEILING(preliminary, $5). Already a multiple of $5 stays unchanged. */
function ceilToNextFiveDollars(exactMinorUnits: MoneyDecimalValue): bigint {
  // Integer arithmetic on the exact decimal, via decimal.js's own ceil — never
  // a JS numeric path, which cannot represent a high-value piece exactly.
  return BigInt(
    exactMinorUnits
      .dividedBy(CARD_PRICE_INCREMENT_MINOR_UNITS.toString())
      .ceil()
      .times(CARD_PRICE_INCREMENT_MINOR_UNITS.toString())
      .toString()
  );
}

const REGISTRY: Record<RegularCardPriceRuleId, RegularCardPriceRule> = {
  /**
   * SUPERSEDED, AND DELIBERATELY UNTOUCHED.
   *
   * card = ceil_to_whole_dollar(bank x (1 + configuredRate)), a single fixed
   * rate from the pricing profile. Replaced for new pricing by
   * BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1 below.
   *
   * It stays because calculations stored under this id must keep reproducing
   * exactly. Changing what a versioned id means is the one edit that turns an
   * append-only audit trail into a set of numbers nobody can defend — so this
   * body is frozen, including its whole-dollar ceiling and its use of the
   * profile rate.
   */
  CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1: {
    id: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
    derive: (bankPaymentPriceMinorUnits, configuredRate) => {
      const exact = new MoneyDecimal(bankPaymentPriceMinorUnits.toString()).times(
        new MoneyDecimal(1).plus(configuredRate)
      );
      const regularCardPriceMinorUnits = BigInt(
        exact.dividedBy(ONE_DOLLAR_MINOR_UNITS.toString()).ceil().times(ONE_DOLLAR_MINOR_UNITS.toString()).toString()
      );
      return {
        bankPaymentPriceMinorUnits,
        regularCardPriceMinorUnits,
        bankPaymentSavingsMinorUnits: regularCardPriceMinorUnits - bankPaymentPriceMinorUnits,
        appliedUpliftRate: configuredRate.toString(),
        appliedTierLabel: "fixed rate (superseded rule)",
      };
    },
  },

  /**
   * THE CURRENT RULE (docs/BANK-CARD-PRICING.md §11).
   *
   *   1. select the tier from the BANK PAYMENT PRICE — never from the inflated
   *      card price, which is why policy §3 says so explicitly and why example
   *      C exists: a $990 item stays in the 4.5% band even though its card
   *      price is $1,035, which would otherwise pull it into the 4.0% band and
   *      make the calculation depend on its own output;
   *   2. preliminary = bank x (1 + rate), exact decimal;
   *   3. final = ceiling of that to the next $5;
   *   4. savings = final − bank, computed AFTER the rounding (policy §9), so
   *      the figure shown always matches the two prices shown. Deriving it from
   *      the percentage instead would be off by the rounding on most items.
   *
   * IGNORES `configuredRate`. The profile's fixed rate belongs to the
   * superseded rule; consulting it here would make the tier table advisory.
   */
  BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1: {
    id: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
    derive: (bankPaymentPriceMinorUnits) => {
      const tier = selectCardUpliftTier(bankPaymentPriceMinorUnits);

      const preliminary = new MoneyDecimal(bankPaymentPriceMinorUnits.toString()).times(
        new MoneyDecimal(1).plus(tier.rate)
      );
      const regularCardPriceMinorUnits = ceilToNextFiveDollars(preliminary);

      return {
        bankPaymentPriceMinorUnits,
        regularCardPriceMinorUnits,
        bankPaymentSavingsMinorUnits: regularCardPriceMinorUnits - bankPaymentPriceMinorUnits,
        appliedUpliftRate: tier.rate,
        appliedTierLabel: tier.label,
      };
    },
  },
};

export class UnknownRegularCardPriceRuleError extends Error {
  constructor(readonly id: string) {
    super(`Unknown regular card price rule id "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownRegularCardPriceRuleError";
  }
}

export function getRegularCardPriceRule(id: RegularCardPriceRuleId): RegularCardPriceRule {
  const rule = REGISTRY[id];
  if (!rule) throw new UnknownRegularCardPriceRuleError(id);
  return rule;
}

/**
 * The ONLY way a Regular/Card price is produced anywhere in the codebase.
 *
 * Takes a FINALISED bank payment price — after rounding, price ending and every
 * floor bump. Deriving from an unfinished value would let the two prices
 * disagree: a bank price nudged up a dollar to clear a floor would keep a card
 * price computed from the pre-bump figure.
 */
export function deriveRegularCardPrice(
  bankPaymentPriceMinorUnits: bigint,
  configuredRate: MoneyDecimalValue,
  ruleId: RegularCardPriceRuleId
): RegularCardPriceResult {
  return getRegularCardPriceRule(ruleId).derive(bankPaymentPriceMinorUnits, configuredRate);
}
