import { Money } from "~/domain/money/money";

import {
  BEAT_QUOTE_FALLBACK_CURRENCY,
  BEAT_QUOTE_FALLBACK_PERCENT,
  type BeatQuoteRedemptionSurface,
  isFallbackEligibleSurface,
} from "./fallbackBenefit";

/**
 * What the fallback benefit is calculated against.
 *
 * ============================================================================
 * THE EXCLUSIONS ARE THE SUBSTANCE OF THIS MODULE
 * ============================================================================
 * "10% off one eligible purchase, maximum $100" sounds like one multiplication.
 * The work is deciding what "eligible" covers, and every exclusion below is a
 * locked rule rather than a preference:
 *
 *   tax, shipping, duties, tips    not merchandise. A percentage of a total
 *                                  including them is a bigger benefit than the
 *                                  one promised — the same reasoning CLAUDE.md
 *                                  rule 15 applies to Bank Payment savings.
 *   Group Buy lines                amendment §3 excludes Community Group Buys
 *   Luxury Steals lines            amendment §3 excludes them too
 *   another promotional discount    amendment §3: not stackable unless
 *                                  CaratForUs expressly authorizes it, so by
 *                                  default the benefit is not calculated on
 *                                  top of one
 *
 * A LINE IS INCLUDED ONLY IF IT SAYS IT IS. `eligible` is required on every
 * line rather than defaulted, so a caller that forgets to classify something
 * gets a type error instead of a silent discount on a Luxury Steal.
 */

/**
 * Why a line is not eligible. Carried so a refusal can be explained to a
 * customer and audited later, rather than lines simply vanishing from a
 * subtotal.
 */
export type IneligibleLineReason =
  | "group_buy"
  | "luxury_steal"
  | "non_merchandise"
  | "already_discounted";

export interface RedemptionLineInput {
  /** The Shopify variant this line charges for, or a custom-line identifier. */
  readonly reference: string;
  readonly quantity: number;
  /** The price of ONE unit. Integer minor units, never a float. */
  readonly unitPrice: Money;
  /**
   * Why this line is excluded, or `null` when it is eligible merchandise.
   * REQUIRED — not optional and not defaulted. A caller that has not decided
   * cannot compile, which is the point: the default would be "discount it".
   */
  readonly ineligibleBecause: IneligibleLineReason | null;
}

export interface EligibleSubtotal {
  readonly subtotal: Money;
  readonly includedLines: readonly RedemptionLineInput[];
  readonly excludedLines: readonly { readonly line: RedemptionLineInput; readonly reason: IneligibleLineReason }[];
}

export class RedemptionCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedemptionCalculationError";
  }
}

/**
 * The eligible merchandise subtotal: included lines only, quantity multiplied,
 * summed.
 *
 * QUANTITY MULTIPLIES THE UNIT PRICE AND NOTHING ELSE. It never changes a
 * line's eligibility, and the subtotal is a sum of per-line extensions rather
 * than anything derived from a cart total — the same discipline CLAUDE.md
 * rule 23 requires of Bank/Card pricing, and for the same reason: a total is a
 * number somebody else computed.
 */
export function computeEligibleSubtotal(lines: readonly RedemptionLineInput[]): EligibleSubtotal {
  if (lines.length === 0) {
    throw new RedemptionCalculationError("a redemption needs at least one line");
  }

  const included: RedemptionLineInput[] = [];
  const excluded: { line: RedemptionLineInput; reason: IneligibleLineReason }[] = [];
  let subtotalMinorUnits = 0n;

  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new RedemptionCalculationError(
        `line ${line.reference} has a quantity of ${line.quantity}; a line must be a whole number of units`
      );
    }
    if (line.unitPrice.currency !== BEAT_QUOTE_FALLBACK_CURRENCY) {
      throw new RedemptionCalculationError(
        `line ${line.reference} is priced in ${line.unitPrice.currency}; the benefit is denominated in ${BEAT_QUOTE_FALLBACK_CURRENCY}`
      );
    }
    if (line.unitPrice.amountMinorUnits < 0n) {
      throw new RedemptionCalculationError(`line ${line.reference} has a negative unit price`);
    }

    if (line.ineligibleBecause !== null) {
      excluded.push({ line, reason: line.ineligibleBecause });
      continue;
    }
    included.push(line);
    subtotalMinorUnits += line.unitPrice.amountMinorUnits * BigInt(line.quantity);
  }

  if (included.length === 0) {
    // Not an empty subtotal of zero — a cart with nothing eligible is not a
    // redeemable purchase, and returning 0 would hand the caller a discount of
    // 0 on a benefit it then marked reserved.
    throw new RedemptionCalculationError(
      `no eligible merchandise: every line was excluded (${excluded.map((e) => e.reason).join(", ")})`
    );
  }

  return {
    subtotal: Money.fromMinorUnits(subtotalMinorUnits, BEAT_QUOTE_FALLBACK_CURRENCY),
    includedLines: included,
    excludedLines: excluded,
  };
}

export interface RedemptionQuoteInput {
  readonly lines: readonly RedemptionLineInput[];
  readonly surface: BeatQuoteRedemptionSurface;
  /** The benefit's OWN frozen cap, not today's constant. */
  readonly benefitMaxDiscount: Money;
  /** True when another promotional discount is already applied to this purchase. */
  readonly otherPromotionApplied: boolean;
  /** Amendment §3's "unless CaratForUs expressly authorizes the combination". */
  readonly stackingExpresslyAuthorized: boolean;
}

export interface RedemptionQuote {
  readonly eligibleSubtotal: Money;
  readonly discount: Money;
  readonly includedLines: readonly RedemptionLineInput[];
  readonly excludedLines: readonly { readonly line: RedemptionLineInput; readonly reason: IneligibleLineReason }[];
}

/**
 * The full quote: eligible subtotal, then `min(10%, the benefit's cap)`.
 *
 * ROUNDED DOWN TO THE CENT. Integer division truncates, so $19.99 yields $1.99.
 * A discount is money leaving the business and rounding a cap upward is how
 * "maximum $100" quietly becomes $100.01; truncation cannot exceed either the
 * percentage or the cap.
 *
 * THE CAP COMES FROM THE BENEFIT, NOT FROM TODAY'S CONSTANT. If the policy ever
 * changes to $150, a benefit issued under the old terms must still be worth
 * exactly what its holder was promised.
 */
export function quoteRedemption(input: RedemptionQuoteInput): RedemptionQuote {
  if (!isFallbackEligibleSurface(input.surface)) {
    // Group Buy and Luxury Steals. Refused here as well as being absent from
    // the database's surface enum, so a caller gets a legible error rather
    // than a constraint violation.
    throw new RedemptionCalculationError(
      `the fallback benefit is not redeemable on ${input.surface}; it is eligible on regular Buy Now merchandise or Custom Jewelry only`
    );
  }
  if (input.otherPromotionApplied && !input.stackingExpresslyAuthorized) {
    // NOT "calculate it anyway and let someone else refuse". The benefit is
    // not stackable by default, so there is no correct amount to compute on
    // top of another discount.
    throw new RedemptionCalculationError(
      "another promotional discount is already applied and stacking has not been expressly authorized"
    );
  }
  if (input.benefitMaxDiscount.currency !== BEAT_QUOTE_FALLBACK_CURRENCY) {
    throw new RedemptionCalculationError(
      `the benefit's cap is in ${input.benefitMaxDiscount.currency}; expected ${BEAT_QUOTE_FALLBACK_CURRENCY}`
    );
  }

  const { subtotal, includedLines, excludedLines } = computeEligibleSubtotal(input.lines);

  const percentShare = subtotal.amountMinorUnits / BigInt(100 / BEAT_QUOTE_FALLBACK_PERCENT);
  const capped =
    percentShare > input.benefitMaxDiscount.amountMinorUnits
      ? input.benefitMaxDiscount.amountMinorUnits
      : percentShare;

  if (capped <= 0n) {
    // A subtotal small enough that 10% truncates to nothing. Refused rather
    // than reserving a benefit for a zero discount, which would spend the
    // customer's one use on nothing.
    throw new RedemptionCalculationError(
      `10% of ${subtotal.amountMinorUnits} minor units rounds down to zero; there is no discount to apply`
    );
  }

  return {
    eligibleSubtotal: subtotal,
    discount: Money.fromMinorUnits(capped, BEAT_QUOTE_FALLBACK_CURRENCY),
    includedLines,
    excludedLines,
  };
}
