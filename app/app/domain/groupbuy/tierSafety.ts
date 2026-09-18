import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { evaluateFloors } from "~/domain/pricing/solve";
import type { FloorEvaluation, PriceEndingRuleId, PricingProfileInputs } from "~/domain/pricing/types";
import type { RoundingRuleId } from "~/domain/money/rounding";

import { tierPriceExact, type TierDefinition } from "./tiers";

/**
 * Pre-publication tier safety — README, Group Buy Tier Model:
 *
 *   "Before publication, validate every allowed variant against configured
 *    minimum gross-margin percentage, minimum dollar profit, and any
 *    variant-specific floor. Unsafe tiers must be blocked or require an
 *    explicit authorized override."
 *
 * WHY EVERY VARIANT x EVERY TIER, rather than the cheapest tier alone. It is
 * tempting to assume the deepest tier is the only one that can breach a floor,
 * because it is the lowest price. That holds for the MARGIN floor but not for
 * the others: a variant-specific floor can sit above an intermediate tier, and
 * a fixed per-order cost makes the minimum-DOLLAR-profit floor bite at
 * different tiers for different variants. Checking only the last tier would
 * pass a campaign whose middle tier is the unsafe one.
 *
 * This REPORTS; it does not decide. Whether an unsafe tier is blocked outright
 * or proceeds under an authorized override is a campaign-publication decision,
 * and putting that choice here would bury it in arithmetic.
 *
 * Reuses `evaluateFloors` — the same predicate Buy Now pricing uses. A second
 * implementation would be free to drift, and the drift would show up as a
 * campaign that passed validation while selling below the floors the Buy Now
 * engine enforces on the identical variant.
 */

export interface TierSafetyVariantInput {
  masterVariantId: string;
  /** Frozen campaign base price for this variant, in whole minor units. */
  frozenBaseMinorUnits: bigint;
  /** Landed cost frozen with the campaign, exact decimal minor units. */
  landedCostMinorUnits: MoneyDecimalValue;
  /** Revenue-side rate and fixed fee, as used by the Buy Now floor check. */
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  /** Variant-specific price floor, if configured. */
  variantFloorMinorUnits?: MoneyDecimalValue;
}

export interface TierSafetyResult {
  masterVariantId: string;
  tierNumber: number;
  /** The rounded price a customer would actually pay at this tier. */
  priceMinorUnits: bigint;
  evaluation: FloorEvaluation;
  safe: boolean;
}

export interface TierSafetyReport {
  results: readonly TierSafetyResult[];
  /** Only the breaches, for the publication screen. */
  unsafe: readonly TierSafetyResult[];
  /** True when every variant clears every tier — the publishable case. */
  allSafe: boolean;
}

/**
 * Evaluates the price a customer would actually be charged at each tier, which
 * means rounding it exactly as the engine would.
 *
 * Checking the unrounded price would be subtly wrong in both directions: a
 * price rounded DOWN can fall under a floor the exact value cleared, and one
 * rounded UP can clear a floor the exact value breached. Either way the
 * validation would be answering a question about a price nobody pays.
 */
export function evaluateTierSafety(input: {
  variants: readonly TierSafetyVariantInput[];
  tiers: readonly TierDefinition[];
  profile: Pick<PricingProfileInputs, "minGrossMarginRate" | "minDollarProfit">;
  roundingRuleId: RoundingRuleId;
  priceEndingRuleId: PriceEndingRuleId;
  currency: string;
}): TierSafetyReport {
  const results: TierSafetyResult[] = [];

  for (const variant of input.variants) {
    for (const tier of input.tiers) {
      const exact = tierPriceExact(new MoneyDecimal(variant.frozenBaseMinorUnits.toString()), tier);

      // The same two-step the Buy Now engine uses: the single rounding
      // boundary, then the price-ending rule.
      const rounded = Money.fromDecimalMinorUnits(exact, input.currency, input.roundingRuleId);
      const priceMinorUnits = applyPriceEnding(rounded.amountMinorUnits, input.priceEndingRuleId);

      const evaluation = evaluateFloors({
        priceMinorUnits,
        landedCostMinorUnits: variant.landedCostMinorUnits,
        revenueRate: variant.revenueRate,
        revenueFixedMinorUnits: variant.revenueFixedMinorUnits,
        minGrossMarginRate: new MoneyDecimal(input.profile.minGrossMarginRate),
        minDollarProfitMinorUnits: new MoneyDecimal(input.profile.minDollarProfit.amountMinorUnits),
        variantFloorMinorUnits: new MoneyDecimal(variant.variantFloorMinorUnits ?? "0"),
      });

      results.push({
        masterVariantId: variant.masterVariantId,
        tierNumber: tier.tierNumber,
        priceMinorUnits,
        evaluation,
        safe: evaluation.satisfied,
      });
    }
  }

  const unsafe = results.filter((r) => !r.safe);
  return { results, unsafe, allSafe: unsafe.length === 0 };
}
