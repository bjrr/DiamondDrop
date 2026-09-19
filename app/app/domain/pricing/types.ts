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

/**
 * D9. Versions the FORMULA deriving the displayed credit-card price from the
 * cash price. THE ID STRING IS PERSISTED on every stored calculation, so it
 * keeps its original spelling even though the TypeScript name now says "credit
 * card" — renaming the value would orphan every historical row.
 */
export type CreditCardPriceRuleId = "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1";

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
  /**
   * D9. Formula id and rate for deriving the DISPLAYED credit-card price from
   * the finalised cash price. Configurable and versioned: the rate is data
   * (0.05 today), the id versions the formula.
   *
   * Neither value may appear in a cost, markup, margin-floor, minimum-profit,
   * Group Buy discount or tier-safety calculation. They are read at exactly one
   * point — creditCardPrice.ts, after everything else has finished.
   */
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
  /** Where this item is manufactured. Exactly one source per item. */
  laborSource?: string;
  /** Manufacturing labour rate per gram, MINOR units, for that source. */
  laborRatePerGramMinorUnits?: DecimalString;
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

/**
 * The result of testing a CASH price against the hard floors.
 *
 * Every figure here is measured on the cash price GROSS of payment-processing
 * expense — see PROFITABILITY_BASIS_ID in solve.ts, whose id is echoed in
 * `basisId` so that a stored evaluation states which rule produced it instead
 * of leaving a future reader to infer it from the date.
 */
export interface FloorEvaluation {
  satisfied: boolean;
  /** The profitability basis this evaluation was measured on. */
  basisId: string;
  /** Exact decimals as strings — display projections, never re-entered (§5.4). */
  cashContributionMinorUnits: DecimalString;
  cashGrossMarginRate: DecimalString;
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
  /**
   * The grams-based manufacturing rate alone, separate from per-stone setting
   * and the other labour components that make up `labourMinorUnits`.
   */
  manufacturingLabourMinorUnits: DecimalString;
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
  /** The exact unrounded CASH solve result, retained for audit (§5.6). */
  exactCashPriceMinorUnits: DecimalString;
  binding: BindingConstraint;
  /**
   * The AUTHORITATIVE CASH-EQUIVALENT price (D9) — ACH, wire, Zelle, check.
   *
   * THIS IS THE BASIS OF EVERY CALCULATION THAT PRODUCED IT: landed cost, the
   * 40% target markup, the 20% gross-margin floor, the $100 minimum profit and
   * any variant floor all bind this number. It is the one stored price.
   *
   * It is NOT the primary price shown to the customer. That is
   * `creditCardPrice` below; cash is offered alongside it as the discounted
   * payment option.
   */
  cashPrice: MoneyJSON;
  /**
   * The PRIMARY CUSTOMER-DISPLAYED CARD price, derived as cash x (1 + uplift)
   * and never stored independently. This is the regular price a shopper sees
   * and what the sync layer publishes to Shopify.
   *
   * Publishing `cashPrice` instead would undercharge every card customer by the
   * uplift, on every item, silently.
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
  /**
   * The band's CASH price: the maximum cash price across the band's sizes.
   * Selection is made on CASH, because that is what the floors bind. Selecting
   * on the card price would pick the same size in practice — the derivation is
   * monotonic — but would make the choice depend on a number no floor governs.
   */
  bandCashPrice: MoneyJSON;
  /** The band's displayed price, derived from `bandCashPrice`. */
  bandCreditCardPrice: MoneyJSON;
  /** The size whose cost set the band price (R18 evidence). */
  costBasisSize: DecimalString;
  perSize: readonly { size: DecimalString; cashPriceMinorUnits: string }[];
  winning: BuyNowPriceResult;
}
