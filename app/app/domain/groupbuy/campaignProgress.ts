import { MoneyDecimal } from "~/domain/money/decimal";

import { nextTier, selectTier, unitsToNextTier, type TierDefinition } from "./tiers";

/**
 * The storefront Group Buy progress view model (README "Live Savings /
 * Progress").
 *
 * WHAT THIS FILE IS FOR. It builds exactly the nine things the README says an
 * active campaign page shows, and — just as importantly — refuses to build the
 * two it forbids. Putting that in a pure function means the rules are testable
 * and cannot be quietly reinterpreted by whichever template renders them.
 *
 * THE TWO PROHIBITIONS, verbatim: "Do not use crowdfunding-funded percentages
 * or imply a minimum is required."
 *
 *   - No "73% funded" figure is produced, and there is deliberately no field
 *     for one. A percentage-of-goal reads as money raised towards a target that
 *     must be met, which is what a crowdfunder is and what this is not.
 *   - `minimumRequired` is not a concept here. The README is explicit that one
 *     qualifying unit proceeds at Tier 1, so progress is expressed as "units so
 *     far" and "units to the next price", never as a shortfall.
 *
 * NOTHING COST-RELATED CROSSES THIS BOUNDARY. The output carries prices and
 * savings — which a customer is entitled to — and no landed cost, margin,
 * floor, or profile data. That is a standing rule (CLAUDE.md: never expose
 * supplier-private cost data or admin-only margins to storefront clients), and
 * this type is the place it either holds or does not.
 */

export interface TierMarker {
  tierNumber: number;
  minQualifyingUnits: number;
  /** Price at this tier for the selected variant, whole minor units. */
  priceMinorUnits: string;
  /** Already reached at the current unit count. */
  unlocked: boolean;
  /** The tier currently in force. */
  current: boolean;
}

export interface CampaignProgressView {
  campaignCode: string;
  currency: string;

  /** README: "qualifying units sold". Units, never buyers, never a percentage. */
  qualifyingUnitsSold: number;

  /** README: "current tier/percentage". */
  currentTierNumber: number;
  /** The tier's share of base as a percentage OFF, e.g. "10.00" for 0.90. */
  currentDiscountPercent: string;

  /** README: "next threshold and units needed". Null at the final tier. */
  nextThresholdUnits: number | null;
  unitsToNextTier: number | null;

  /** README: "selected variant's current Group Buy price". */
  groupBuyPriceMinorUnits: string;
  /** README: "selected variant's current Buy Now comparison price". */
  buyNowComparisonPriceMinorUnits: string;

  /** README: "current dollar/percentage savings" against Buy Now. */
  savingsMinorUnits: string;
  savingsPercent: string;

  /** README: "next-tier price and additional savings". Null at the final tier. */
  nextTierPriceMinorUnits: string | null;
  additionalSavingsMinorUnits: string | null;

  /** README: "countdown/time remaining". Null for an open-ended campaign. */
  closesAt: string | null;
  secondsRemaining: number | null;

  /** README: "configured tier markers". */
  tierMarkers: readonly TierMarker[];

  /** README: at the final tier show "Best Price Unlocked". */
  bestPriceUnlocked: boolean;

  /** README's stated core message, returned so the copy lives in one place. */
  coreMessage: string;
}

export const CORE_MESSAGE =
  "Join now. If the group unlocks a lower price later, your final price drops too.";

export interface CampaignProgressInput {
  campaignCode: string;
  currency: string;
  tiers: readonly TierDefinition[];
  qualifyingUnitsSold: number;
  /** Frozen campaign base for the selected variant, whole minor units. */
  frozenBaseMinorUnits: bigint;
  /** Current Buy Now price for the same variant, whole minor units. */
  buyNowPriceMinorUnits: bigint;
  /**
   * Already-rounded tier prices, keyed by tier number. Supplied rather than
   * computed here because rounding is the engine's single boundary — a view
   * model that rounded prices itself would be a second place where a customer-
   * facing price is decided, and the two could disagree.
   */
  tierPricesMinorUnits: Readonly<Record<number, bigint>>;
  scheduledCloseAt: Date | null;
  /** An input, never a clock read, so the view is reproducible in tests. */
  asOf: Date;
}

/**
 * An exact decimal string, trailing zeros trimmed — "10" rather than "10.00".
 * PRESENTATION is the storefront's job; padding here would mean the domain had
 * an opinion about display, and a currency-aware formatter is better placed to
 * decide than this function is.
 */
function percentString(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return "0.00";
  return new MoneyDecimal(numerator.toString())
    .dividedBy(new MoneyDecimal(denominator.toString()))
    .times(100)
    .toDecimalPlaces(2)
    .toString();
}

export function buildCampaignProgress(input: CampaignProgressInput): CampaignProgressView {
  const currentTier = selectTier(input.tiers, input.qualifyingUnitsSold);
  const upcoming = nextTier(input.tiers, input.qualifyingUnitsSold);

  const priceOf = (tierNumber: number): bigint => {
    const price = input.tierPricesMinorUnits[tierNumber];
    if (price === undefined) {
      // Silently substituting the base would show a customer a price the
      // campaign never offered.
      throw new Error(`No price supplied for tier ${tierNumber}`);
    }
    return price;
  };

  const groupBuyPrice = priceOf(currentTier.tierNumber);
  const nextPrice = upcoming ? priceOf(upcoming.tierNumber) : null;

  // Savings are measured against the BUY NOW price, per the README's field
  // list, not against the campaign base. Those differ whenever Buy Now has
  // moved since the campaign froze, and the customer's actual alternative is
  // buying it now.
  const rawSavings = input.buyNowPriceMinorUnits - groupBuyPrice;
  const savings = rawSavings > 0n ? rawSavings : 0n;

  const additionalSavings = nextPrice !== null ? groupBuyPrice - nextPrice : null;

  // Integer arithmetic rather than Math.floor/Math.max, and not because this
  // is money — a countdown plainly is not. The repo-wide guard against ad-hoc
  // rounding is deliberately blunt, and adding an allowlist exception to it
  // would weaken a rule that exists to protect prices, for the sake of one
  // duration. Subtracting the millisecond remainder floors exactly, and a
  // campaign already past its close clamps to zero rather than counting
  // downwards past it.
  const remainingMs = input.scheduledCloseAt
    ? input.scheduledCloseAt.getTime() - input.asOf.getTime()
    : null;
  const secondsRemaining =
    remainingMs === null ? null : remainingMs <= 0 ? 0 : (remainingMs - (remainingMs % 1000)) / 1000;

  const tierMarkers: TierMarker[] = [...input.tiers]
    .sort((a, b) => a.tierNumber - b.tierNumber)
    .map((tier) => ({
      tierNumber: tier.tierNumber,
      minQualifyingUnits: tier.minQualifyingUnits,
      priceMinorUnits: priceOf(tier.tierNumber).toString(),
      unlocked: input.qualifyingUnitsSold >= tier.minQualifyingUnits,
      current: tier.tierNumber === currentTier.tierNumber,
    }));

  return {
    campaignCode: input.campaignCode,
    currency: input.currency,
    qualifyingUnitsSold: input.qualifyingUnitsSold,
    currentTierNumber: currentTier.tierNumber,
    // Expressed as a DISCOUNT for display: the stored multiplier is 0.90 but a
    // shopper reads "10% off". Converting here keeps the storefront from doing
    // the subtraction and getting the direction wrong — a mistake this project
    // has already made once with the card uplift.
    currentDiscountPercent: new MoneyDecimal(1)
      .minus(currentTier.priceMultiplier)
      .times(100)
      .toDecimalPlaces(2)
      .toString(),
    nextThresholdUnits: upcoming?.minQualifyingUnits ?? null,
    unitsToNextTier: unitsToNextTier(input.tiers, input.qualifyingUnitsSold),
    groupBuyPriceMinorUnits: groupBuyPrice.toString(),
    buyNowComparisonPriceMinorUnits: input.buyNowPriceMinorUnits.toString(),
    savingsMinorUnits: savings.toString(),
    savingsPercent: percentString(savings, input.buyNowPriceMinorUnits),
    nextTierPriceMinorUnits: nextPrice?.toString() ?? null,
    additionalSavingsMinorUnits: additionalSavings?.toString() ?? null,
    closesAt: input.scheduledCloseAt?.toISOString() ?? null,
    secondsRemaining,
    tierMarkers,
    // True only at the LAST configured tier — not merely "a good discount".
    bestPriceUnlocked: upcoming === null,
    coreMessage: CORE_MESSAGE,
  };
}
