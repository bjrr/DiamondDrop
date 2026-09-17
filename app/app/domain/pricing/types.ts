import type { MoneyJSON } from "~/domain/money/money";
import type { RoundingRuleId } from "~/domain/money/rounding";

/**
 * Pricing domain types (spec §4.1, §5.6).
 *
 * `BuyNowPricingInputs` is JSON-SAFE BY TYPE, and that is not a convenience —
 * it is what discharges F-10 and makes §5.6's reproducibility contract
 * possible. Every decimal is a `string`, every amount is a `MoneyJSON`, every
 * timestamp is an ISO-8601 `string`, and the only `number`s are counts and
 * indices. A gram weight or price-per-gram typed as `number` would reintroduce
 * binary float into an append-only evidence payload where neither the
 * money-safety scan nor the Money type boundary can see it.
 */

/** A decimal quantity as an exact string, e.g. "3.5000". Never a JS number. */
export type DecimalString = string;

/** Where a resolved input came from, so a calculation can be reproduced (§5.6). */
export interface InputProvenance {
  sourceTable: string;
  sourceId: string;
  /** ISO-8601. A string, not a Date — the engine has no clock. */
  effectiveFrom: string;
}

export type PriceEndingRuleId = "NONE_V1" | "WHOLE_DOLLAR_UP_V1";

/**
 * Versions the margin model. An id referenced by a stored calculation may never
 * change behaviour; a new pricing formula is a new id (see solve.ts).
 */
export type MarginModelId = "MARKUP_ON_COST_V1" | "TARGET_GROSS_MARGIN_V1";

/** D9. Versions the FORMULA deriving the card price from the cash base. */
export type CreditCardPriceRuleId = "MULTIPLY_BASE_V1";

export type ComponentBasis = "cost_side" | "revenue_side";
export type ComponentValueKind = "fixed" | "per_stone" | "percentage";

export interface ResolvedCostComponent {
  componentType: string;
  basis: ComponentBasis;
  valueKind: ComponentValueKind;
  /** Set when valueKind is `fixed` or `per_stone`. */
  amount?: MoneyJSON;
  /** Decimal string when valueKind is `percentage`, e.g. "0.029000". */
  rate?: DecimalString;
  provenance?: InputProvenance;
}

export interface ResolvedStonePosition {
  position: number;
  /** Count of identical stones at this position. A genuine integer. */
  quantity: number;
  /** Per-stone cost, already resolved. Exactly one of these two is set. */
  unitCost?: MoneyJSON;
  perCaratCost?: DecimalString;
  carat?: DecimalString;
  provenance?: InputProvenance;
}

export interface SizeSpec {
  sizeAxis: "ring_size_us" | "length_inches" | "none";
  allowedSizeMin: DecimalString;
  allowedSizeMax: DecimalString;
  sizeIncrement: DecimalString;
  baseSize: DecimalString;
}

export interface WeightSpec extends SizeSpec {
  baseWeightGrams: DecimalString;
  weightPerFullSizeGrams: DecimalString;
  /** Exact finished-weight overrides keyed by size string (R8). */
  overrides?: Readonly<Record<string, DecimalString>>;
}

export interface BandSpec {
  label: string;
  sizeMin: DecimalString;
  sizeMax: DecimalString;
}

export interface PricingProfileInputs {
  code: string;
  version: number;
  marginModel: MarginModelId;
  /** Fraction OF PRICE. Present for TARGET_GROSS_MARGIN_V1. */
  targetGrossMarginRate?: DecimalString;
  /** Fraction OF COST. Present for MARKUP_ON_COST_V1 (D14 default 0.40). */
  targetMarkupRate?: DecimalString;
  minGrossMarginRate: DecimalString;
  minDollarProfit: MoneyJSON;
  roundingRuleId: RoundingRuleId;
  priceEndingRuleId: PriceEndingRuleId;
  /**
   * NULL while D14 s tolerance is unresolved, which DISABLES automatic
   * publication: every change requires manual approval. Zero is a different,
   * legitimate answer meaning any change at all needs approval.
   */
  autoApplyToleranceBps: number | null;
  /** D9. Formula id and rate for deriving the card price from the cash base. */
  creditCardPriceRuleId: CreditCardPriceRuleId;
  creditCardUpliftRate: DecimalString;
  isPlaceholder: boolean;
}

export interface BuyNowPricingInputs {
  /** ISO-8601. The engine never reads a clock; this is an input (§5.6). */
  asOf: string;
  currency: string;
  size: DecimalString;
  weight: WeightSpec;
  /** Metal price per gram in MINOR units, as a decimal string (§4.1 rule 2). */
  metalPricePerGramMinorUnits: DecimalString;
  stones: readonly ResolvedStonePosition[];
  components: readonly ResolvedCostComponent[];
  profile: PricingProfileInputs;
  /** Variant price floor, if configured (R11). */
  variantFloor?: MoneyJSON;
  provenance?: readonly InputProvenance[];
}

/** Which constraint determined the price (§5.3). */
export type BindingConstraint = "margin" | "min_profit" | "variant_floor";

export type FloorId = "min_gross_margin" | "min_dollar_profit" | "variant_floor";

export interface FloorEvaluation {
  satisfied: boolean;
  /** Exact decimals as strings — display projections, never re-entered (§5.4). */
  contribution: DecimalString;
  grossMargin: DecimalString;
  failing: readonly FloorId[];
}

/**
 * Every money-shaped value on the breakdown is a ROUNDED DISPLAY PROJECTION
 * (§4.1 rule 3). None of them may be fed back into a later step of a
 * calculation — the single load-bearing rounding boundary is the final price.
 */
export interface CostBreakdown {
  metalMinorUnits: DecimalString;
  stonesMinorUnits: DecimalString;
  labourMinorUnits: DecimalString;
  overheadMinorUnits: DecimalString;
  landedCostMinorUnits: DecimalString;
  perComponent: readonly { componentType: string; amountMinorUnits: DecimalString }[];
}

export interface BuyNowPriceResult {
  engineVersion: string;
  currency: string;
  size: DecimalString;
  weightGrams: DecimalString;
  breakdown: CostBreakdown;
  /** The exact unrounded solve result, retained for audit (§5.6). */
  exactPriceMinorUnits: DecimalString;
  binding: BindingConstraint;
  /**
   * The CASH-EQUIVALENT price (D9): ACH, wire, Zelle, cheque. This is the one
   * stored price and the basis for everything below.
   */
  price: MoneyJSON;
  /**
   * DERIVED from the cash price, never stored independently (D9). It is
   * recomputable at any time from price + rate + rule id, all three of which
   * are recorded on this result.
   */
  creditCardPrice: MoneyJSON;
  creditCardPriceRuleId: CreditCardPriceRuleId;
  creditCardUpliftRate: DecimalString;
  floors: FloorEvaluation;
  bumps: number;
  roundingRuleId: RoundingRuleId;
  priceEndingRuleId: PriceEndingRuleId;
  profileVersion: number;
}

export interface BuyNowBandPricingInputs extends Omit<BuyNowPricingInputs, "size"> {
  band: BandSpec;
}

export interface BuyNowBandPriceResult {
  band: BandSpec;
  bandPrice: MoneyJSON;
  /** The size whose cost set the band price (R18 evidence). */
  costBasisSize: DecimalString;
  perSize: readonly { size: DecimalString; priceMinorUnits: string }[];
  winning: BuyNowPriceResult;
}
