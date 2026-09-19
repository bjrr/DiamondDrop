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
  /** Which of the two prices failed to fall. */
  basis: "bank_payment" | "regular_card";
  /**
   * BOTH prices on BOTH tiers, on every problem, whichever basis failed.
   *
   * An operator fixing a card-price failure needs the bank prices to see why —
   * the card price is derived from them, and a boundary crossing is only
   * visible in the pair. Reporting just the failing basis would send them to
   * look the other two up, which is the sort of omission that turns a two-minute
   * fix into a support thread.
   */
  priorBankPaymentPriceMinorUnits: bigint;
  bankPaymentPriceMinorUnits: bigint;
  priorRegularCardPriceMinorUnits: bigint;
  regularCardPriceMinorUnits: bigint;
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
 * BOTH MUST FALL STRICTLY (owner decision, 2026-09-19). The rule was `<=` on
 * the card price for one day; the owner tightened it to `<` on reading what
 * `<=` admits:
 *
 *   "A newly unlocked tier must produce a real decrease in the primary
 *    customer-facing Regular/Card Price."
 *
 * A tie is therefore rejected, not merely left undisplayed. Reaching a
 * threshold and seeing the advertised price not move is a promise the campaign
 * made and did not keep, and the $5 ceiling makes that reachable without anyone
 * configuring two identical tiers — a tier shallow enough gets absorbed whole.
 *
 * There is deliberately NO minimum percentage gap between tiers. A gap would be
 * a rule about multipliers standing in for a fact about prices, and it would be
 * both too strict (rejecting wide tiers that happen to be fine) and too loose
 * (passing narrow ones that are not). The resulting prices are what get
 * checked, per variant, because they are what a customer sees.
 *
 * The storefront ALSO gates its "the price drops to" line on a strictly
 * positive saving. That is now belt and braces rather than the primary defence
 * — publication can no longer produce a tie — but it is kept, because campaigns
 * opened before this decision were validated under the looser rule and their
 * tiers are frozen.
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

      // Both prices on both tiers go on every problem, whichever failed.
      const prices = {
        priorBankPaymentPriceMinorUnits: previous.groupBuyBankPaymentPriceMinorUnits,
        bankPaymentPriceMinorUnits: current.groupBuyBankPaymentPriceMinorUnits,
        priorRegularCardPriceMinorUnits: previous.groupBuyRegularCardPriceMinorUnits,
        regularCardPriceMinorUnits: current.groupBuyRegularCardPriceMinorUnits,
      };
      const where =
        `variant ${masterVariantId}, tier ${previous.tierNumber} -> tier ${current.tierNumber}: ` +
        `Bank Payment ${asMoney(prices.priorBankPaymentPriceMinorUnits)} -> ` +
        `${asMoney(prices.bankPaymentPriceMinorUnits)}, ` +
        `Regular/Card ${asMoney(prices.priorRegularCardPriceMinorUnits)} -> ` +
        `${asMoney(prices.regularCardPriceMinorUnits)}`;

      if (current.groupBuyBankPaymentPriceMinorUnits >= previous.groupBuyBankPaymentPriceMinorUnits) {
        problems.push({
          masterVariantId,
          priorTierNumber: previous.tierNumber,
          tierNumber: current.tierNumber,
          basis: "bank_payment",
          ...prices,
          detail: `${where} — the Bank Payment Price does not fall`,
        });
      }

      if (current.groupBuyRegularCardPriceMinorUnits >= previous.groupBuyRegularCardPriceMinorUnits) {
        // Equal counts as a failure, and the message says which of the two
        // shapes it is, because the fixes differ: a TIE is the $5 ceiling
        // swallowing a tier that is too shallow to survive it, and wants a
        // deeper multiplier; a RISE is the bank price crossing a Bank/Card band
        // boundary, and may need the tier moved to either side of it.
        const tied =
          current.groupBuyRegularCardPriceMinorUnits ===
          previous.groupBuyRegularCardPriceMinorUnits;

        problems.push({
          masterVariantId,
          priorTierNumber: previous.tierNumber,
          tierNumber: current.tierNumber,
          basis: "regular_card",
          ...prices,
          detail: tied
            ? `${where} — the Regular/Card Price does not fall: the $5 rounding absorbed ` +
              `this tier entirely, so a customer paying by card sees no change at all`
            : `${where} — the Regular/Card Price RISES: the Bank Payment Price crossed a ` +
              `Bank/Card pricing threshold into a lower uplift band`,
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
