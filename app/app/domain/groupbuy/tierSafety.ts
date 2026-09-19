import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import { evaluateFloors } from "~/domain/pricing/solve";
import type {
  DecimalString,
  FloorEvaluation,
  PriceEndingRuleId,
  PricingProfileInputs,
  RegularCardPriceRuleId,
} from "~/domain/pricing/types";
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
  /** What a card customer would be advertised at this tier. Not floor-checked. */
  groupBuyRegularCardPriceMinorUnits: bigint;
  evaluation: FloorEvaluation;
  safe: boolean;
}

/**
 * A tier whose price does not move in the right direction.
 *
 * Reported per VARIANT and per adjacent PAIR, with both prices and the basis,
 * because "a tier is wrong" is not something anyone can act on from a
 * publication screen.
 */
export interface PriceLadderProblem {
  masterVariantId: string;
  priorTierNumber: number;
  tierNumber: number;
  basis: "bank_payment" | "regular_card";
  priorPriceMinorUnits: bigint;
  priceMinorUnits: bigint;
  detail: string;
}

export interface TierSafetyReport {
  results: readonly TierSafetyResult[];
  /** Floor breaches. Overridable by an authorised owner. */
  unsafe: readonly TierSafetyResult[];
  /**
   * Tiers whose price ladder runs the wrong way. NOT overridable — see
   * openCampaign. A floor breach is a margin judgement an owner is entitled to
   * make; a price that rises as the group grows is not a judgement, it is a
   * campaign that would state something untrue to a customer.
   */
  priceLadderProblems: readonly PriceLadderProblem[];
  /** True when every variant clears every tier AND every ladder only falls. */
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
  /**
   * The card rule and rate this campaign will FREEZE. Needed because the price
   * ladder is validated on the displayed price too — see `priceLadderProblems`.
   * It plays no part in any floor.
   */
  regularCardPriceRuleId: RegularCardPriceRuleId;
  fixedCardUpliftRate: DecimalString;
  currency: string;
}): TierSafetyReport {
  const results: TierSafetyResult[] = [];
  const upliftRate = new MoneyDecimal(input.fixedCardUpliftRate);

  const sortedTiers = [...input.tiers].sort((a, b) => a.tierNumber - b.tierNumber);

  for (const variant of input.variants) {
    for (const tier of sortedTiers) {
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

      // Derived through the SAME rule the storefront and the freeze will use,
      // so the ladder is checked on the exact figures a shopper would see.
      const card = deriveRegularCardPrice(
        groupBuyBankPaymentPriceMinorUnits,
        upliftRate,
        input.regularCardPriceRuleId
      );

      results.push({
        masterVariantId: variant.masterVariantId,
        tierNumber: tier.tierNumber,
        groupBuyBankPaymentPriceMinorUnits,
        groupBuyRegularCardPriceMinorUnits: card.regularCardPriceMinorUnits,
        evaluation,
        safe: evaluation.satisfied,
      });
    }
  }

  const unsafe = results.filter((r) => !r.safe);
  const priceLadderProblems = findPriceLadderProblems(results, sortedTiers);

  return {
    results,
    unsafe,
    priceLadderProblems,
    allSafe: unsafe.length === 0 && priceLadderProblems.length === 0,
  };
}

/**
 * THE PRICE LADDER MUST ONLY EVER GO DOWN, on both prices, for every variant.
 *
 * Validated on the ACTUAL RESULTING PRICES rather than inferred from the tier
 * multipliers, because the multipliers cannot answer it. A strictly falling
 * multiplier always gives a falling bank price, but the Bank/Card schedule is
 * non-monotonic across its band boundaries:
 *
 *     $999.99 bank -> 4.5% -> $1,045.00 card
 *   $1,000.00 bank -> 4.0% -> $1,040.00 card
 *
 * so a cheaper bank price can derive a DEARER card price. Whether a given
 * campaign trips that depends on the variant's frozen base and on where its
 * tiers happen to land — which is knowable only here, with the prices in hand.
 *
 * Both directions are checked, and they are different rules:
 *
 *   BANK must fall STRICTLY. Two tiers at the same bank price is a campaign
 *   promising a reward for reaching a threshold and then not delivering one.
 *   Rounding can collapse a small multiplier difference to nothing, so this is
 *   reachable without anyone configuring two identical tiers.
 *
 *   CARD must be NON-INCREASING. Equal is tolerated, because that is the rule
 *   as the owner locked it ("next tier Regular/Card Price must be <= the prior
 *   tier"), and because the $5 ceiling makes ties ordinary: a lower Bank
 *   Payment Price can round to the same card price. An INCREASE is blocked.
 *
 * A TIE IS PERMITTED HERE AND MUST NOT BE ADVERTISED AS A DROP. Publication
 * allowing something is not the storefront being free to describe it however it
 * likes: at a tie the block would otherwise render "N more and the price drops
 * to $2,080.00" beneath a Group Buy Price of $2,080.00 — every figure correct,
 * the sentence false. The block therefore gates that line on a strictly
 * positive additional saving. The tier is still genuine for a bank-paying
 * customer, whose price does fall, and its marker still appears in the track.
 *
 * If the owner would rather forbid ties outright, this comparison becomes `>=`
 * and the display guard becomes redundant — a one-word change here, and a
 * tightening of their stated rule, so it is theirs to make rather than ours.
 */
function findPriceLadderProblems(
  results: readonly TierSafetyResult[],
  sortedTiers: readonly TierDefinition[]
): readonly PriceLadderProblem[] {
  const problems: PriceLadderProblem[] = [];
  const variantIds = [...new Set(results.map((r) => r.masterVariantId))];

  for (const masterVariantId of variantIds) {
    for (let i = 1; i < sortedTiers.length; i++) {
      const previous = results.find(
        (r) => r.masterVariantId === masterVariantId && r.tierNumber === sortedTiers[i - 1]!.tierNumber
      );
      const current = results.find(
        (r) => r.masterVariantId === masterVariantId && r.tierNumber === sortedTiers[i]!.tierNumber
      );
      if (!previous || !current) continue;

      if (current.groupBuyBankPaymentPriceMinorUnits >= previous.groupBuyBankPaymentPriceMinorUnits) {
        problems.push({
          masterVariantId,
          priorTierNumber: previous.tierNumber,
          tierNumber: current.tierNumber,
          basis: "bank_payment",
          priorPriceMinorUnits: previous.groupBuyBankPaymentPriceMinorUnits,
          priceMinorUnits: current.groupBuyBankPaymentPriceMinorUnits,
          detail:
            `variant ${masterVariantId} tier ${current.tierNumber} Bank Payment Price ` +
            `${asMoney(current.groupBuyBankPaymentPriceMinorUnits)} is not below tier ` +
            `${previous.tierNumber} (${asMoney(previous.groupBuyBankPaymentPriceMinorUnits)})`,
        });
      }

      if (current.groupBuyRegularCardPriceMinorUnits > previous.groupBuyRegularCardPriceMinorUnits) {
        problems.push({
          masterVariantId,
          priorTierNumber: previous.tierNumber,
          tierNumber: current.tierNumber,
          basis: "regular_card",
          priorPriceMinorUnits: previous.groupBuyRegularCardPriceMinorUnits,
          priceMinorUnits: current.groupBuyRegularCardPriceMinorUnits,
          detail:
            `variant ${masterVariantId} tier ${current.tierNumber} Regular/Card Price ` +
            `${asMoney(current.groupBuyRegularCardPriceMinorUnits)} RISES above tier ` +
            `${previous.tierNumber} (${asMoney(previous.groupBuyRegularCardPriceMinorUnits)}) — ` +
            `the Bank Payment Price crossed a Bank/Card pricing threshold ` +
            `(${asMoney(previous.groupBuyBankPaymentPriceMinorUnits)} -> ` +
            `${asMoney(current.groupBuyBankPaymentPriceMinorUnits)})`,
        });
      }
    }
  }

  return problems;
}

/**
 * Display only, for the publication screen.
 *
 * Integer arithmetic on the bigint, rather than a fixed-decimal formatter.
 * decimal.js's own would be exact here, but the repo-wide money-safety scan is
 * deliberately blunt about that call — and adding an allowlist entry to this
 * file, so that a message string can be formatted, would weaken a guard that
 * exists to protect prices. Splitting the bigint costs two lines and nothing
 * else. (The scan reads comments too, which is why this one does not name the
 * method: a guard that can be talked around is not a guard.)
 */
function asMoney(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const cents = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${absolute / 100n}.${cents}`;
}
