import { MoneyDecimal } from "~/domain/money/decimal";
import { Money, type MoneyJSON } from "~/domain/money/money";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";

import { deriveRegularCardPrice } from "./regularCardPrice";
import type { DecimalString, RegularCardPriceRuleId } from "./types";

/**
 * Vendor-mounting pricing (owner-locked 2026-11-01).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `engine.ts`
 * ---------------------------------------------------------------------------
 * `engine.ts` prices jewelry CaratForUs manufactures: it builds a landed cost
 * from metal weight x metal price per gram, labour per gram and resolved stone
 * costs, then applies a markup and the margin floors.
 *
 * A George's mounting is a FINISHED GOOD bought at a quoted price. There is no
 * weight build-up to compute — the cost is one number on an invoice — and the
 * owner's rules add their fees AFTER the markup, which `MARKUP_ON_COST_V1`
 * cannot express (it returns `cost x (1 + k)` and reads no additive term;
 * revenue-side components reach that model and are ignored by it).
 *
 * Forcing a vendor mounting through `engine.ts` would mean inventing a gram
 * weight, a metal price and a labour rate chosen so the computed cost happened
 * to equal George's invoice. That is fabricated supplier data in the catalogue,
 * so this is a separate, narrower rule instead.
 *
 * IT IS NOT A SECOND PRICING SYSTEM. The two prices mean exactly what they mean
 * everywhere else, and the Regular/Card Price is NOT derived here: it is handed
 * to `deriveRegularCardPrice`, the same locked tier-and-$5-ceiling rule the
 * engine uses. The tier table exists in one place only.
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 * ---------------------------------------------------------------------------
 *   Bank Payment Price = vendor cost x 1.75
 *                      + $70 per large stone CaratForUs must set
 *                      + ring-size adjustment
 *                      + $10 per CONFIRMED band pave diamond
 *                      + $100 if a hidden halo is present
 *
 * The ring-size adjustment is relative to the size stated in the VENDOR'S
 * product title, which is the base size and carries +$0 — even when that base
 * size is above 8. Below base is +$25 flat, not per half-size. Above base
 * through 8 is +$40 flat. Above 8 through 11 is +$100 flat and is NOT
 * cumulative with the +$40.
 *
 * ONE ROUNDING BOUNDARY. Every component is summed as an exact decimal and
 * rounded once, at the Bank Payment Price, under the named rule from the
 * versioned registry. Rounding a fee on the way in would make the total depend
 * on the order the fees were added.
 */

/**
 * The versioned id for this rule, recorded alongside any stored calculation.
 *
 * Same contract as the margin-model, rounding and card-price registries: the
 * behaviour behind an id may never change, because a stored price must keep
 * reproducing. New figures mean a new id, not an edit to this one.
 */
export const MOUNTING_PRICING_RULE_ID = "VENDOR_MOUNTING_MARKUP_175_V1" as const;

/** Markup ON COST. 0.75 produces cost x 1.75 — not a 75% gross margin. */
const MARKUP_RATE: DecimalString = "0.75";

const LARGE_STONE_SETTING_FEE_MINOR_UNITS = 7_000n;
const BAND_PAVE_FEE_PER_DIAMOND_MINOR_UNITS = 1_000n;
const HIDDEN_HALO_FEE_MINOR_UNITS = 10_000n;

const SIZE_BELOW_BASE_MINOR_UNITS = 2_500n;
const SIZE_ABOVE_BASE_THROUGH_8_MINOR_UNITS = 4_000n;
const SIZE_ABOVE_8_MINOR_UNITS = 10_000n;

/** Sizes above this are not offered through the standard mounting flow. */
export const MAX_SUPPORTED_RING_SIZE: DecimalString = "11";
/** The boundary between the +$40 and +$100 bands. */
const LARGE_SIZE_THRESHOLD: DecimalString = "8";

export class RingSizeNotSupportedError extends Error {
  constructor(readonly ringSize: string) {
    super(
      `Ring size ${ringSize} exceeds the maximum supported size of ${MAX_SUPPORTED_RING_SIZE} ` +
        `for the standard mounting flow.`
    );
    this.name = "RingSizeNotSupportedError";
  }
}

/**
 * Raised when a required vendor fact is missing rather than guessed.
 *
 * The owner's rule is explicit: if the band pave count cannot be established
 * from the vendor's specifications, flag it for review. A default of zero would
 * silently under-price every pave mounting, and the error would look exactly
 * like a correctly priced plain band.
 */
export class VendorSpecificationMissingError extends Error {
  constructor(readonly field: string) {
    super(
      `Vendor specification "${field}" is not established. Flag for review; ` +
        `do not price this mounting until the vendor confirms it.`
    );
    this.name = "VendorSpecificationMissingError";
  }
}

export interface MountingSpec {
  /** The vendor's quoted cost for this configuration. Not MSRP, not retail. */
  readonly vendorCost: MoneyJSON;
  /**
   * Large stones CaratForUs must set. Small pave/melee stones do NOT count —
   * they are charged per diamond by `bandPaveDiamondCount` instead.
   */
  readonly largeStoneCount: number;
  /**
   * Pave/melee diamonds set into the band or shank. `null` means the vendor
   * did not state it, which raises rather than defaulting to zero. Centre,
   * large side, halo and hidden-halo stones are excluded — they are covered by
   * the large-stone fee and the hidden-halo fee.
   */
  readonly bandPaveDiamondCount: number | null;
  readonly hasHiddenHalo: boolean;
  /**
   * The size stated in the VENDOR'S product title. Always the base size, at
   * +$0, whatever its number. Never inferred from variant ordering or from
   * which size happens to be cheapest.
   */
  readonly baseRingSize: DecimalString;
}

export interface MountingPriceResult {
  readonly ruleId: typeof MOUNTING_PRICING_RULE_ID;
  readonly currency: string;
  readonly ringSize: DecimalString;
  /** Audit trail: every component, in the order the rule states them. */
  readonly breakdown: {
    readonly vendorCostMinorUnits: bigint;
    readonly markupRate: DecimalString;
    /** cost x 1.75, exact and unrounded. */
    readonly markedUpExactMinorUnits: DecimalString;
    readonly largeStoneFeeMinorUnits: bigint;
    readonly ringSizeAdjustmentMinorUnits: bigint;
    readonly ringSizeAdjustmentReason: string;
    readonly bandPaveFeeMinorUnits: bigint;
    readonly hiddenHaloFeeMinorUnits: bigint;
  };
  readonly bankPaymentPrice: MoneyJSON;
  readonly regularCardPrice: MoneyJSON;
  readonly bankPaymentSavings: MoneyJSON;
  /** INTERNAL ONLY — never customer-facing. */
  readonly appliedCardUpliftRate: DecimalString;
  readonly appliedCardUpliftTierLabel: string;
  readonly regularCardPriceRuleId: RegularCardPriceRuleId;
}

interface RingSizeAdjustment {
  readonly minorUnits: bigint;
  readonly reason: string;
}

/**
 * The size adjustment, decided only by comparing this size with the vendor's
 * base size. Exported for admin surfaces that explain a price.
 */
export function ringSizeAdjustment(
  ringSize: DecimalString,
  baseRingSize: DecimalString
): RingSizeAdjustment {
  const size = new MoneyDecimal(ringSize);
  const base = new MoneyDecimal(baseRingSize);

  if (size.greaterThan(MAX_SUPPORTED_RING_SIZE)) {
    throw new RingSizeNotSupportedError(ringSize);
  }

  if (size.equals(base)) {
    return { minorUnits: 0n, reason: `base size ${baseRingSize} from the vendor title` };
  }
  if (size.lessThan(base)) {
    return { minorUnits: SIZE_BELOW_BASE_MINOR_UNITS, reason: `below base size ${baseRingSize}` };
  }
  // Above the base size. The two bands are alternatives, never cumulative.
  if (size.greaterThan(LARGE_SIZE_THRESHOLD)) {
    return {
      minorUnits: SIZE_ABOVE_8_MINOR_UNITS,
      reason: `above size ${LARGE_SIZE_THRESHOLD}`,
    };
  }
  return {
    minorUnits: SIZE_ABOVE_BASE_THROUGH_8_MINOR_UNITS,
    reason: `above base size ${baseRingSize}, through size ${LARGE_SIZE_THRESHOLD}`,
  };
}

/**
 * Price one ring size of one vendor mounting.
 *
 * @param spec      the mounting's vendor facts
 * @param ringSize  the size being priced
 * @param regularCardPriceRuleId  which locked rule derives the card price
 */
export function computeMountingPrice(
  spec: MountingSpec,
  ringSize: DecimalString,
  regularCardPriceRuleId: RegularCardPriceRuleId = "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1"
): MountingPriceResult {
  if (spec.bandPaveDiamondCount === null) {
    throw new VendorSpecificationMissingError("bandPaveDiamondCount");
  }
  if (!Number.isInteger(spec.largeStoneCount) || spec.largeStoneCount < 0) {
    throw new VendorSpecificationMissingError("largeStoneCount");
  }
  if (!Number.isInteger(spec.bandPaveDiamondCount) || spec.bandPaveDiamondCount < 0) {
    throw new VendorSpecificationMissingError("bandPaveDiamondCount");
  }

  const currency = spec.vendorCost.currency;
  const vendorCost = Money.fromJSON(spec.vendorCost);

  const markedUpExact = new MoneyDecimal(vendorCost.amountMinorUnits.toString()).times(
    new MoneyDecimal(1).plus(MARKUP_RATE)
  );

  const largeStoneFee = LARGE_STONE_SETTING_FEE_MINOR_UNITS * BigInt(spec.largeStoneCount);
  const size = ringSizeAdjustment(ringSize, spec.baseRingSize);
  const bandPaveFee = BAND_PAVE_FEE_PER_DIAMOND_MINOR_UNITS * BigInt(spec.bandPaveDiamondCount);
  const hiddenHaloFee = spec.hasHiddenHalo ? HIDDEN_HALO_FEE_MINOR_UNITS : 0n;

  // Summed exactly, then rounded ONCE. The fees are whole dollars so only the
  // markup can produce a fraction, but the single boundary is the rule rather
  // than a convenience — a future per-carat fee must not change this shape.
  const exactBankPayment = markedUpExact
    .plus(largeStoneFee.toString())
    .plus(size.minorUnits.toString())
    .plus(bandPaveFee.toString())
    .plus(hiddenHaloFee.toString());

  const bankPayment = Money.fromDecimalMinorUnits(
    exactBankPayment,
    currency,
    DEFAULT_ROUNDING_RULE_ID
  );

  // The card price is derived by the shared locked rule, from the FINAL bank
  // payment price. Nothing here re-rounds or re-derives it.
  const card = deriveRegularCardPrice(
    bankPayment.amountMinorUnits,
    new MoneyDecimal(0),
    regularCardPriceRuleId
  );

  return {
    ruleId: MOUNTING_PRICING_RULE_ID,
    currency,
    ringSize,
    breakdown: {
      vendorCostMinorUnits: vendorCost.amountMinorUnits,
      markupRate: MARKUP_RATE,
      markedUpExactMinorUnits: markedUpExact.toString(),
      largeStoneFeeMinorUnits: largeStoneFee,
      ringSizeAdjustmentMinorUnits: size.minorUnits,
      ringSizeAdjustmentReason: size.reason,
      bandPaveFeeMinorUnits: bandPaveFee,
      hiddenHaloFeeMinorUnits: hiddenHaloFee,
    },
    bankPaymentPrice: Money.fromMinorUnits(card.bankPaymentPriceMinorUnits, currency).toJSON(),
    regularCardPrice: Money.fromMinorUnits(card.regularCardPriceMinorUnits, currency).toJSON(),
    bankPaymentSavings: Money.fromMinorUnits(card.bankPaymentSavingsMinorUnits, currency).toJSON(),
    appliedCardUpliftRate: card.appliedUpliftRate,
    appliedCardUpliftTierLabel: card.appliedTierLabel,
    regularCardPriceRuleId,
  };
}
