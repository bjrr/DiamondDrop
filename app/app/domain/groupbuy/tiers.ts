import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type { DecimalString } from "~/domain/pricing/types";

/**
 * Group Buy tier model — README "Group Buy — Locked MVP1 Direction".
 *
 * NOTHING ABOUT THE BOUNDARY IS HARD-CODED, and that is the single most
 * important property of this file.
 *
 * A widely-repeated interpretation of this feature is "Tier 1 = 1–9 units,
 * Tier 2 = 10+, Tier 2 is 10% lower". That is ONE valid two-tier configuration,
 * not the model. The locked README says: default THREE tiers, configurable from
 * TWO to FIVE per campaign, with thresholds expressed in qualifying units sold.
 * Writing 9, 10 or 0.90 into this module would quietly convert a per-campaign
 * setting into a product-wide constant, and every future campaign would inherit
 * a number nobody chose.
 *
 * Thresholds and percentages are therefore DATA, supplied per campaign, frozen
 * when the campaign opens, and validated here.
 *
 * EVERY PRICE IN THIS MODULE IS A BANK PAYMENT PRICE. The frozen campaign base
 * is one, tier multipliers apply to it, and tier safety is judged on the
 * result. The Regular/Card Price is derived afterwards from whatever bank price
 * a tier produces, and is no part of Group Buy economics
 * (docs/BANK-CARD-PRICING.md §6, owner-locked 2026-09-18).
 *
 * "PERCENTAGE" IS A MULTIPLIER, NOT A DISCOUNT. The README's formula is
 *
 *     Variant Group Price = Frozen Campaign Base Price x Applicable Tier Percentage
 *
 * so 0.90 means "90% of base", i.e. 10% off. The field is named
 * `priceMultiplier` rather than `percentage` because this codebase has already
 * been bitten once by exactly this ambiguity — a 5% card uplift is not a 5%
 * bank-payment discount, and confusing the two costs real money. A name that
 * cannot be misread is worth more than a comment explaining the misreading.
 */

/** Per the README: 3 by default, configurable from 2 to 5. */
export const MIN_TIERS = 2;
export const MAX_TIERS = 5;
export const DEFAULT_TIER_COUNT = 3;

export interface TierDefinition {
  /** 1-based, contiguous, ascending. Tier 1 is the starting tier. */
  tierNumber: number;
  /**
   * Qualifying units at which this tier becomes applicable. Tier 1 must be 1:
   * the README states there is no mandatory minimum and one qualifying unit
   * proceeds at Tier 1.
   */
  minQualifyingUnits: number;
  /**
   * Fraction OF THE FROZEN BASE BANK PAYMENT PRICE, e.g. "0.900000" = 90% of
   * base = 10% off.
   * NOT a discount rate. See the header.
   */
  priceMultiplier: DecimalString;
}

export class InvalidTierSetError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid Group Buy tier set: ${problems.join("; ")}`);
    this.name = "InvalidTierSetError";
  }
}

/**
 * Validates a campaign's tier set before it can be frozen.
 *
 * Every rule here is a README constraint or an arithmetic consequence of one.
 * Collects ALL problems rather than throwing on the first: someone configuring
 * a campaign should see everything wrong with it in one pass, not discover the
 * faults one save at a time.
 */
export function validateTierSet(tiers: readonly TierDefinition[]): void {
  const problems: string[] = [];

  if (tiers.length < MIN_TIERS || tiers.length > MAX_TIERS) {
    problems.push(
      `a campaign must have between ${MIN_TIERS} and ${MAX_TIERS} tiers, got ${tiers.length}`
    );
  }

  const sorted = [...tiers].sort((a, b) => a.tierNumber - b.tierNumber);

  sorted.forEach((tier, index) => {
    const expected = index + 1;
    if (tier.tierNumber !== expected) {
      problems.push(`tier numbers must be contiguous from 1; expected ${expected}, got ${tier.tierNumber}`);
    }

    if (!Number.isInteger(tier.minQualifyingUnits) || tier.minQualifyingUnits < 1) {
      // Units are counted pieces. A fractional or zero threshold is not a
      // quantity of jewellery.
      problems.push(
        `tier ${tier.tierNumber}: minQualifyingUnits must be a positive integer, got ${tier.minQualifyingUnits}`
      );
    }

    const multiplier = new MoneyDecimal(tier.priceMultiplier);
    if (multiplier.lessThanOrEqualTo(0)) {
      problems.push(`tier ${tier.tierNumber}: priceMultiplier must be greater than 0`);
    }
    if (multiplier.greaterThan(1)) {
      // Above 1 would price a Group Buy ABOVE the campaign base — the opposite
      // of the feature. Exactly 1 is allowed: a first tier at full price is a
      // legitimate campaign shape.
      problems.push(
        `tier ${tier.tierNumber}: priceMultiplier ${tier.priceMultiplier} exceeds 1, which would price above the campaign base`
      );
    }
  });

  if (sorted.length > 0 && sorted[0]!.minQualifyingUnits !== 1) {
    // README: "There is no mandatory minimum buyer/unit count. One qualifying
    // unit can proceed at Tier 1."
    problems.push(
      `tier 1 must start at 1 qualifying unit (no mandatory minimum), got ${sorted[0]!.minQualifyingUnits}`
    );
  }

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;

    if (current.minQualifyingUnits <= previous.minQualifyingUnits) {
      problems.push(
        `tier ${current.tierNumber} threshold (${current.minQualifyingUnits}) must exceed tier ${previous.tierNumber} (${previous.minQualifyingUnits})`
      );
    }

    // Later tiers must be CHEAPER. A flat or rising multiplier would mean
    // selling more units made the price worse, and the storefront promises the
    // opposite ("next-tier price and additional savings").
    //
    // THIS CHECKS MULTIPLIERS, WHICH IS NOT THE WHOLE STORY. A strictly falling
    // multiplier guarantees a falling BANK PAYMENT price but NOT a falling
    // REGULAR/CARD price: the Bank/Card tier schedule is non-monotonic across
    // its band boundaries, so a lower bank price can derive a higher card
    // price. Whether that happens depends on each variant's actual frozen
    // price, which this module never sees — it validates a tier SET, not a
    // priced campaign. `evaluateTierSafety` checks the resulting prices
    // directly, per variant, before publication.
    if (!new MoneyDecimal(current.priceMultiplier).lessThan(previous.priceMultiplier)) {
      problems.push(
        `tier ${current.tierNumber} multiplier (${current.priceMultiplier}) must be lower than tier ${previous.tierNumber} (${previous.priceMultiplier}) — later tiers must be cheaper`
      );
    }
  }

  if (problems.length > 0) throw new InvalidTierSetError(problems);
}

/**
 * The tier applicable at a given number of qualifying units.
 *
 * The HIGHEST tier whose threshold has been reached — not the nearest, and not
 * the next one. Below tier 1's threshold is impossible for a valid set, since
 * tier 1 starts at 1; zero units resolves to tier 1 so a campaign with no sales
 * still has a quotable price.
 */
export function selectTier(
  tiers: readonly TierDefinition[],
  qualifyingUnits: number
): TierDefinition {
  validateTierSet(tiers);

  if (!Number.isInteger(qualifyingUnits) || qualifyingUnits < 0) {
    throw new InvalidTierSetError([
      `qualifyingUnits must be a non-negative integer, got ${qualifyingUnits}`,
    ]);
  }

  const sorted = [...tiers].sort((a, b) => a.minQualifyingUnits - b.minQualifyingUnits);

  let applicable = sorted[0]!;
  for (const tier of sorted) {
    if (qualifyingUnits >= tier.minQualifyingUnits) applicable = tier;
    else break;
  }
  return applicable;
}

/** The next tier up, or null at the final tier ("Best Price Unlocked"). */
export function nextTier(
  tiers: readonly TierDefinition[],
  qualifyingUnits: number
): TierDefinition | null {
  const current = selectTier(tiers, qualifyingUnits);
  const sorted = [...tiers].sort((a, b) => a.tierNumber - b.tierNumber);
  return sorted.find((t) => t.tierNumber === current.tierNumber + 1) ?? null;
}

/** Units still needed to reach the next tier, or null at the final tier. */
export function unitsToNextTier(
  tiers: readonly TierDefinition[],
  qualifyingUnits: number
): number | null {
  const next = nextTier(tiers, qualifyingUnits);
  if (!next) return null;
  // Never negative: selectTier guarantees we are below this threshold.
  return next.minQualifyingUnits - qualifyingUnits;
}

/**
 * The EXACT group-buy BANK PAYMENT price for a tier, unrounded.
 *
 * BANK IN, BANK OUT. The frozen base is a Bank Payment Price and the multiplier
 * applies to it, so a Group Buy discount is a discount off the bank price. The
 * Group Buy Regular/Card Price is derived from the ROUNDED result of this, by
 * the same tiered rule Buy Now uses — and the tier is selected from the group
 * price, not the campaign base, so a deep tier can legitimately fall into a
 * different uplift band from tier 1.
 *
 * Returns an exact decimal rather than whole minor units on purpose. Rounding
 * is the engine's single load-bearing boundary (§5.4) and must happen once,
 * through the versioned rounding and price-ending registries — not here, and
 * not twice.
 */
export function tierBankPaymentPriceExact(
  frozenBaseBankPaymentMinorUnits: MoneyDecimalValue,
  tier: TierDefinition
): MoneyDecimalValue {
  return new MoneyDecimal(frozenBaseBankPaymentMinorUnits).times(tier.priceMultiplier);
}
