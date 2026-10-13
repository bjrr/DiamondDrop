import { Money } from "~/domain/money/money";

/**
 * The 10%-off fallback benefit — the second half of the match-or-beat
 * guarantee (amendment §3, original §"10%-Off Fallback Rules").
 *
 * Owed in exactly one situation: a qualifying recent custom quote was verified,
 * and CaratForUs cannot match or beat the verified jewelry price. Every other
 * path — older quote, online listing, competing Group Buy, unverified,
 * fabricated — owes nothing (`eligibility.ts`).
 *
 * ============================================================================
 * THE TERMS, AND WHICH ARE ENFORCED WHERE
 * ============================================================================
 *   10% off one eligible purchase      computed here
 *   maximum discount $100              computed here, as a hard cap
 *   valid 90 calendar days             computed here
 *   single use                         DATABASE: unique + a consumed marker
 *   non-transferable                   DATABASE: bound to a customer ref
 *   no cash value                      not representable — never refundable
 *   not stackable unless authorized    redemption check, with an explicit flag
 *   Buy Now / Custom Jewelry only      computed here, by surface
 *   NOT Group Buys or Luxury Steals    computed here, by surface
 *
 * The purely arithmetic terms live in this module so they can be exercised
 * exhaustively without a database. "Single use" deliberately does NOT: a
 * uniqueness rule enforced by a function is enforced by whoever remembers to
 * call it, and amendment §3 requires that "Duplicate/retried issuance must not
 * create multiple fallback benefits from the same qualifying outcome" — which
 * is a constraint, not a check.
 */

/** Amendment §3. */
export const BEAT_QUOTE_FALLBACK_PERCENT = 10;
/** Amendment §3: "maximum discount $100". Integer minor units, never a float. */
export const BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS = 10_000n;
export const BEAT_QUOTE_FALLBACK_CURRENCY = "USD";
/** Amendment §3: "valid for 90 calendar days from issuance". */
export const BEAT_QUOTE_FALLBACK_VALIDITY_DAYS = 90;

/**
 * Where a fallback may be redeemed.
 *
 * Amendment §3: "redeemable on eligible regular Buy Now merchandise or Custom
 * Jewelry" and "not redeemable on Community Group Buys or Luxury Steals unless
 * a later locked policy expressly changes this".
 *
 * AN EXPLICIT ALLOW-LIST, NOT A DENY-LIST. A new purchase surface added later
 * is excluded by default and has to be considered deliberately — the opposite
 * default would silently extend a locked benefit to a surface no policy
 * mentions.
 */
export const BEAT_QUOTE_FALLBACK_ELIGIBLE_SURFACES = ["buy_now", "custom_jewelry"] as const;
export type BeatQuoteRedemptionSurface = "buy_now" | "custom_jewelry" | "group_buy" | "luxury_steals";

export function isFallbackEligibleSurface(surface: BeatQuoteRedemptionSurface): boolean {
  return (BEAT_QUOTE_FALLBACK_ELIGIBLE_SURFACES as readonly string[]).includes(surface);
}

/**
 * The discount for a given eligible merchandise subtotal: 10%, capped at $100.
 *
 * ROUNDED DOWN TO THE CENT, DELIBERATELY. Integer division truncates, so a
 * subtotal of $19.99 yields $1.99 rather than $2.00. Two reasons, and the
 * second is the load-bearing one: a discount is money leaving the business, and
 * rounding a cap upward is how a "maximum $100" quietly becomes $100.01.
 * Truncation cannot exceed either the percentage or the cap.
 *
 * MERCHANDISE ONLY. The caller passes an eligible merchandise subtotal; tax,
 * shipping and duties are not discountable and must not be in it. That mirrors
 * CLAUDE.md rule 15 for Bank Payment savings, and for the same reason — a
 * percentage of a total that includes tax is a bigger benefit than the one that
 * was promised.
 */
export function computeFallbackDiscount(eligibleSubtotal: Money): Money {
  if (eligibleSubtotal.currency !== BEAT_QUOTE_FALLBACK_CURRENCY) {
    throw new Error(
      `the fallback benefit is denominated in ${BEAT_QUOTE_FALLBACK_CURRENCY}; got ${eligibleSubtotal.currency}`
    );
  }
  if (eligibleSubtotal.amountMinorUnits < 0n) {
    throw new Error("an eligible subtotal cannot be negative");
  }

  const tenPercent = eligibleSubtotal.amountMinorUnits / BigInt(100 / BEAT_QUOTE_FALLBACK_PERCENT);
  const capped =
    tenPercent > BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS
      ? BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS
      : tenPercent;
  return Money.fromMinorUnits(capped, BEAT_QUOTE_FALLBACK_CURRENCY);
}

/**
 * When a benefit issued at `issuedAt` stops being redeemable.
 *
 * ============================================================================
 * AN INTERPRETATION WORTH FLAGGING RATHER THAN BURYING
 * ============================================================================
 * The policy says "valid for 90 calendar days from issuance" and separately
 * requires recording an expiration DATE/TIME. Those pull slightly differently:
 * "90 calendar days" could mean the end of the 90th calendar day in some
 * timezone, while a date/time implies an instant.
 *
 * This takes the instant reading — issuance plus 90×24h — because it is
 * unambiguous, timezone-free, and never shortens the benefit below 90 full
 * days. The two readings differ by at most part of one day, always in the
 * customer's favour under the alternative, so this is the conservative-for-us
 * choice rather than the generous one. Flagged for owner confirmation; a change
 * would be a new rule here and a migration for anything already issued, not a
 * silent edit.
 */
export function fallbackExpiresAt(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + BEAT_QUOTE_FALLBACK_VALIDITY_DAYS * 86_400_000);
}

export interface FallbackRedeemabilityInput {
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Set once, when the benefit is spent. Non-null means already used. */
  readonly redeemedAt: Date | null;
  /** Revoked by staff, with a reason recorded elsewhere. */
  readonly revokedAt: Date | null;
  /** The authenticated customer attempting to redeem. */
  readonly attemptingCustomerRef: string;
  /** The customer the benefit was issued to. */
  readonly issuedToCustomerRef: string;
  readonly surface: BeatQuoteRedemptionSurface;
  /** True when another promotional discount is already applied. */
  readonly otherPromotionApplied: boolean;
  /** Amendment §3's "unless CaratForUs expressly authorizes the combination". */
  readonly stackingExpresslyAuthorized: boolean;
  readonly now: Date;
}

export type FallbackRefusal =
  | "expired"
  | "already_redeemed"
  | "revoked"
  | "not_transferable"
  | "surface_not_eligible"
  | "stacking_not_authorized";

export type FallbackRedeemability =
  | { readonly redeemable: true }
  | { readonly redeemable: false; readonly refusal: FallbackRefusal };

/**
 * Whether a benefit may be redeemed right now.
 *
 * EVERY TERM IS CHECKED, AND THE FIRST FAILURE IS REPORTED. The refusals are
 * ordered so the reason a customer is told is the most fundamental one: an
 * expired, already-spent or revoked benefit is not "the wrong surface", and
 * saying so would send them to try a different cart with a dead code.
 *
 * NON-TRANSFERABLE IS AN IDENTITY COMPARISON, not a possession check. Holding
 * the code is not entitlement — amendment §3 says non-transferable, so the
 * authenticated customer must be the one it was issued to.
 *
 * STILL NOT THE AUTHORITY ON SINGLE USE. This reads `redeemedAt`; the database
 * is what makes a second redemption impossible under a race.
 */
export function evaluateFallbackRedeemability(input: FallbackRedeemabilityInput): FallbackRedeemability {
  if (input.revokedAt !== null) return { redeemable: false, refusal: "revoked" };
  if (input.redeemedAt !== null) return { redeemable: false, refusal: "already_redeemed" };
  // `>=` so the expiry instant itself is already too late: a benefit "valid for
  // 90 days" is not valid at the moment it expires.
  if (input.now.getTime() >= input.expiresAt.getTime()) return { redeemable: false, refusal: "expired" };
  if (input.attemptingCustomerRef !== input.issuedToCustomerRef) {
    return { redeemable: false, refusal: "not_transferable" };
  }
  if (!isFallbackEligibleSurface(input.surface)) {
    return { redeemable: false, refusal: "surface_not_eligible" };
  }
  if (input.otherPromotionApplied && !input.stackingExpresslyAuthorized) {
    return { redeemable: false, refusal: "stacking_not_authorized" };
  }
  return { redeemable: true };
}
