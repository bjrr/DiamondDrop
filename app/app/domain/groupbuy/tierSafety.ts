import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { evaluateFloors } from "~/domain/pricing/solve";
import type { FloorEvaluation, PriceEndingRuleId, PricingProfileInputs } from "~/domain/pricing/types";
import type { RoundingRuleId } from "~/domain/money/rounding";

import { tierBankPaymentPriceExact, type TierDefinition } from "./tiers";

/**
 * Pre-publication tier safety — README, Group Buy Tier Model:
 *
 *   "Before publication, validate every allowed variant against configured
 *    minimum gross-margin percentage, minimum dollar profit, and any
 *    variant-specific floor. Unsafe tiers must be blocked or require an
 *    explicit authorized override."
 *
 * EVERYTHING HERE IS THE BANK PAYMENT PRICE (docs/BANK-CARD-PRICING.md,
 * owner-locked 2026-09-18). The frozen base is one, the tier multiplier applies
 * to it, and the floors are tested on the result gross of payment-processing
 * expense. The card uplift plays no part in tier safety at all — it is not
 * margin and it is not Group Buy discount headroom. A campaign is settled
 * entirely in bank-price terms before a card price exists.
 *
 * WHAT THAT CORRECTION IS WORTH, concretely. Deducting the 2.9% + $0.30
 * processing component here made a 10% second tier measure 17.8% and fail the
 * 20% floor, so the campaign could not open. On this basis the same tier is
 *
 *     bank base  = cost x 1.40
 *     tier price = cost x 1.40 x 0.90 = cost x 1.26
 *     margin     = 0.26 / 1.26 = 20.63%
 *
 * which clears it. The gate was refusing campaigns the owner's rules allow. The
 * $100 minimum-profit floor still binds separately, and on a light enough piece
 * it is the one that bites first — see the report this returns.
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
  /** Frozen campaign base BANK PAYMENT price for this variant, whole minor units. */
  frozenBaseBankPaymentMinorUnits: bigint;
  /** Landed cost frozen with the campaign, exact decimal minor units. */
  landedCostMinorUnits: MoneyDecimalValue;
  /** Variant-specific BANK PAYMENT price floor, if configured. */
  variantFloorMinorUnits?: MoneyDecimalValue;
}

export interface TierSafetyResult {
  masterVariantId: string;
  tierNumber: number;
  /**
   * The rounded BANK PAYMENT price a customer using Zelle, bank transfer,
   * designated ACH or wire would actually pay at this tier. Safety is judged on
   * this and nothing else.
   */
  groupBuyBankPaymentPriceMinorUnits: bigint;
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
 * Evaluates the BANK PAYMENT price a customer would be charged at each tier,
 * which means rounding it exactly as the engine would.
 *
 * Checking the unrounded price would be subtly wrong in both directions: a
 * price rounded DOWN can fall under a floor the exact value cleared, and one
 * rounded UP can clear a floor the exact value breached. Either way the
 * validation would be answering a question about a price nobody pays.
 *
 * NOTE WHAT IS ABSENT FROM THE SIGNATURE: no uplift rate, no card price rule,
 * no revenue-side rate. This function could not consult them if it wanted to.
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
      const exactBankPayment = tierBankPaymentPriceExact(
        new MoneyDecimal(variant.frozenBaseBankPaymentMinorUnits.toString()),
        tier
      );

      // The same two-step the Buy Now engine uses: the single rounding
      // boundary, then the price-ending rule.
      const rounded = Money.fromDecimalMinorUnits(exactBankPayment, input.currency, input.roundingRuleId);
      const groupBuyBankPaymentPriceMinorUnits = applyPriceEnding(
        rounded.amountMinorUnits,
        input.priceEndingRuleId
      );

      const evaluation = evaluateFloors({
        bankPaymentPriceMinorUnits: groupBuyBankPaymentPriceMinorUnits,
        landedCostMinorUnits: variant.landedCostMinorUnits,
        minGrossMarginRate: new MoneyDecimal(input.profile.minGrossMarginRate),
        minDollarProfitMinorUnits: new MoneyDecimal(input.profile.minDollarProfit.amountMinorUnits),
        variantFloorMinorUnits: new MoneyDecimal(variant.variantFloorMinorUnits ?? "0"),
      });

      results.push({
        masterVariantId: variant.masterVariantId,
        tierNumber: tier.tierNumber,
        groupBuyBankPaymentPriceMinorUnits,
        evaluation,
        safe: evaluation.satisfied,
      });
    }
  }

  const unsafe = results.filter((r) => !r.safe);
  return { results, unsafe, allSafe: unsafe.length === 0 };
}
