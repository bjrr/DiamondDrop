import { MoneyDecimal } from "~/domain/money/decimal";

import { nextTier, selectTier, unitsToNextTier, type TierDefinition } from "./tiers";

/**
 * The storefront Group Buy progress view model (README "Live Savings /
 * Progress").
 *
 * WHAT THIS FILE IS FOR. It builds exactly the things the README says an active
 * campaign page shows, and — just as importantly — refuses to build the two it
 * forbids. Putting that in a pure function means the rules are testable and
 * cannot be quietly reinterpreted by whichever template renders them.
 *
 * TWO PRICES, AND WHICH IS THE HEADLINE (docs/BANK-CARD-PRICING.md §6,
 * owner-locked 2026-09-18). Every price is carried in BOTH forms, explicitly
 * named:
 *
 *   ...RegularCardPriceMinorUnits   the PRIMARY ADVERTISED price.
 *   ...BankPaymentPriceMinorUnits   the Bank Payment Price, shown alongside it
 *                                   (Zelle, bank transfer, designated ACH,
 *                                   wire, and approved bank/manual methods).
 *
 * So a $2,149 group bank price presents as "Group Buy Price $2,260 / Bank
 * Payment Price: $2,149 / Save $111 with Bank Payment". There is deliberately
 * no bare `price` field: an ambiguous name is how a storefront ends up
 * publishing the internal figure as the headline and undercharging every card
 * customer.
 *
 * TWO DIFFERENT SAVINGS, AND THEY MUST NOT BE CONFLATED:
 *
 *   groupBuyBankPaymentSavings  card − bank AT THE SAME TIER. This is the
 *                               "Save $Y with Bank Payment" figure, and policy
 *                               §9 requires it to be computed from the price
 *                               AFTER the $5 ceiling, never from the rate.
 *   groupSavingsCardBasis       Group Buy price vs BUY NOW price, card-to-card.
 *                               What the Group Buy itself is worth.
 *
 * Adding them together would double-count, and quoting either as the other
 * would misstate the offer. They are named so a template cannot pick the wrong
 * one by accident.
 *
 * THE BANK/CARD PERCENTAGE IS NEVER EXPOSED (policy §6). The tier rate is
 * internal; this type has no field for it and no field for a bank-payment
 * savings percentage. The percentages that DO appear are Group Buy savings
 * against Buy Now, which is a different and legitimate figure.
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
  /** Displayed price at this tier for the selected variant, whole minor units. */
  regularCardPriceMinorUnits: string;
  /** Bank Payment Price at this tier, whole minor units. */
  bankPaymentPriceMinorUnits: string;
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
  /**
   * The tier's share of base as a percentage OFF, e.g. "10.00" for 0.90.
   * This is the GROUP BUY tier discount — never the bank/card tier rate, which
   * policy §6 keeps internal.
   */
  currentTierDiscountPercent: string;

  /** README: "next threshold and units needed". Null at the final tier. */
  nextThresholdUnits: number | null;
  unitsToNextTier: number | null;

  /** README: "selected variant's current Group Buy price", both forms. */
  groupBuyRegularCardPriceMinorUnits: string;
  groupBuyBankPaymentPriceMinorUnits: string;

  /**
   * "Save $Y with Bank Payment" — the group card price minus the group bank
   * price, AT THE SAME TIER.
   *
   * Policy §9: computed after the $5 ceiling, so it always equals the exact
   * difference between the two prices displayed beside it. Derived from the
   * tier rate instead it would be off by the rounding on most items — and a
   * shopper can do this subtraction in their head, so being off is visible.
   *
   * DISTINCT FROM `groupSavingsCardBasis...` below, which measures the Group
   * Buy against Buy Now. Conflating the two double-counts.
   */
  groupBuyBankPaymentSavingsMinorUnits: string;

  /** README: "selected variant's current Buy Now comparison price", both forms. */
  buyNowRegularCardPriceMinorUnits: string;
  buyNowBankPaymentPriceMinorUnits: string;

  /**
   * README: "current dollar/percentage savings" against Buy Now.
   *
   * COMPARED LIKE WITH LIKE: card against card, bank against bank. Mixing them
   * would fold the bank/card spread into the advertised Group Buy saving and
   * overstate what the Group Buy itself is worth.
   */
  groupSavingsCardBasisMinorUnits: string;
  groupSavingsCardBasisPercent: string;
  bankBasisSavingsMinorUnits: string;
  bankBasisSavingsPercent: string;

  /** README: "next-tier price and additional savings". Null at the final tier. */
  nextTierRegularCardPriceMinorUnits: string | null;
  nextTierBankPaymentPriceMinorUnits: string | null;
  additionalRegularCardSavingsMinorUnits: string | null;
  additionalBankPaymentSavingsMinorUnits: string | null;

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

/** A price in both forms, as produced by the server and never recomputed downstream. */
export interface DualPrice {
  bankPaymentMinorUnits: bigint;
  regularCardMinorUnits: bigint;
}

export interface CampaignProgressInput {
  campaignCode: string;
  currency: string;
  tiers: readonly TierDefinition[];
  qualifyingUnitsSold: number;
  /** Current Buy Now price for the selected variant, both forms. */
  buyNowPrice: DualPrice;
  /**
   * Already-rounded tier prices, keyed by tier number, both forms.
   *
   * Supplied rather than computed here because rounding is the engine's single
   * boundary and the card derivation is its own versioned rule — a view model
   * that did either itself would be a second place where a customer-facing
   * price is decided, and the two could disagree.
   */
  tierPrices: Readonly<Record<number, DualPrice>>;
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

/** A saving never becomes a surcharge: a negative difference clamps to zero. */
function saving(comparison: bigint, groupPrice: bigint): bigint {
  const raw = comparison - groupPrice;
  return raw > 0n ? raw : 0n;
}

export function buildCampaignProgress(input: CampaignProgressInput): CampaignProgressView {
  const currentTier = selectTier(input.tiers, input.qualifyingUnitsSold);
  const upcoming = nextTier(input.tiers, input.qualifyingUnitsSold);

  const priceOf = (tierNumber: number): DualPrice => {
    const price = input.tierPrices[tierNumber];
    if (price === undefined) {
      // Silently substituting the base would show a customer a price the
      // campaign never offered.
      throw new Error(`No price supplied for tier ${tierNumber}`);
    }
    return price;
  };

  const groupBuy = priceOf(currentTier.tierNumber);
  const nextPrice = upcoming ? priceOf(upcoming.tierNumber) : null;

  // Savings are measured against the BUY NOW price, per the README's field
  // list, not against the campaign base. Those differ whenever Buy Now has
  // moved since the campaign froze, and the customer's actual alternative is
  // buying it now.
  const groupSavingsCardBasis = saving(input.buyNowPrice.regularCardMinorUnits, groupBuy.regularCardMinorUnits);
  const groupSavingsBankBasis = saving(input.buyNowPrice.bankPaymentMinorUnits, groupBuy.bankPaymentMinorUnits);

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
    .map((tier) => {
      const price = priceOf(tier.tierNumber);
      return {
        tierNumber: tier.tierNumber,
        minQualifyingUnits: tier.minQualifyingUnits,
        regularCardPriceMinorUnits: price.regularCardMinorUnits.toString(),
        bankPaymentPriceMinorUnits: price.bankPaymentMinorUnits.toString(),
        unlocked: input.qualifyingUnitsSold >= tier.minQualifyingUnits,
        current: tier.tierNumber === currentTier.tierNumber,
      };
    });

  return {
    campaignCode: input.campaignCode,
    currency: input.currency,
    qualifyingUnitsSold: input.qualifyingUnitsSold,
    currentTierNumber: currentTier.tierNumber,
    // Expressed as a DISCOUNT for display: the stored multiplier is 0.90 but a
    // shopper reads "10% off". Converting here keeps the storefront from doing
    // the subtraction and getting the direction wrong — a mistake this project
    // has already made once with the card uplift.
    currentTierDiscountPercent: new MoneyDecimal(1)
      .minus(currentTier.priceMultiplier)
      .times(100)
      .toDecimalPlaces(2)
      .toString(),
    nextThresholdUnits: upcoming?.minQualifyingUnits ?? null,
    unitsToNextTier: unitsToNextTier(input.tiers, input.qualifyingUnitsSold),
    groupBuyRegularCardPriceMinorUnits: groupBuy.regularCardMinorUnits.toString(),
    groupBuyBankPaymentPriceMinorUnits: groupBuy.bankPaymentMinorUnits.toString(),
    // Policy §9, and note what is NOT here: no rate, no percentage. The two
    // prices are already rounded, so this subtraction is exact and matches what
    // the shopper can work out from the two figures beside it.
    groupBuyBankPaymentSavingsMinorUnits: (
      groupBuy.regularCardMinorUnits - groupBuy.bankPaymentMinorUnits
    ).toString(),
    buyNowRegularCardPriceMinorUnits: input.buyNowPrice.regularCardMinorUnits.toString(),
    buyNowBankPaymentPriceMinorUnits: input.buyNowPrice.bankPaymentMinorUnits.toString(),
    groupSavingsCardBasisMinorUnits: groupSavingsCardBasis.toString(),
    groupSavingsCardBasisPercent: percentString(
      groupSavingsCardBasis,
      input.buyNowPrice.regularCardMinorUnits
    ),
    bankBasisSavingsMinorUnits: groupSavingsBankBasis.toString(),
    bankBasisSavingsPercent: percentString(groupSavingsBankBasis, input.buyNowPrice.bankPaymentMinorUnits),
    nextTierRegularCardPriceMinorUnits: nextPrice?.regularCardMinorUnits.toString() ?? null,
    nextTierBankPaymentPriceMinorUnits: nextPrice?.bankPaymentMinorUnits.toString() ?? null,
    additionalRegularCardSavingsMinorUnits:
      nextPrice === null
        ? null
        : (groupBuy.regularCardMinorUnits - nextPrice.regularCardMinorUnits).toString(),
    additionalBankPaymentSavingsMinorUnits:
      nextPrice === null ? null : (groupBuy.bankPaymentMinorUnits - nextPrice.bankPaymentMinorUnits).toString(),
    closesAt: input.scheduledCloseAt?.toISOString() ?? null,
    secondsRemaining,
    tierMarkers,
    // True only at the LAST configured tier — not merely "a good discount".
    bestPriceUnlocked: upcoming === null,
    coreMessage: CORE_MESSAGE,
  };
}
