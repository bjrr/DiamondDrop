/**
 * The price-affecting column classifier — criterion 58
 * (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md), created directly by
 * the caveat T5's R5 audit raised: `PricingInputChangeKind` triggers at
 * TABLE granularity, but several covered tables mix genuinely price-
 * affecting columns with columns that must never trigger a recalculation.
 *
 * ============================================================================
 * THE STAKES, RESTATED, BECAUSE THIS IS NOT A COSMETIC CLASSIFICATION.
 * ============================================================================
 * The sync path stamps `MasterVariant.lastSyncedPriceCalculationId` on
 * EVERY SUCCESSFUL PUBLISH. If that column were classified as
 * price-affecting, publishing a price would trigger the next recalculation,
 * which would publish a price, across the whole catalogue, forever. This is
 * not a stale-price risk like an under-classified column elsewhere might be
 * — it is a live, catalogue-wide, resource-consuming loop. Every table below
 * is classified with that asymmetry in mind: the cost of under-triggering
 * (a genuinely price-affecting column missed) is a price that goes stale
 * until the next scheduled run (D15) catches it; the cost of
 * over-triggering a WRITE-PATH column is unbounded self-sustaining churn.
 * That is why this is an ALLOW-LIST, never a deny-list: an unclassified
 * column defaults to "does not trigger", and a genuine miss is caught by
 * the fence test (`priceAffectingColumnsFence.test.ts`) and the daily
 * safety net, not discovered as a production incident.
 *
 * ============================================================================
 * PURE. No database access. `isPriceAffectingChange` takes the model name
 * and the set of columns a write actually touched, as plain strings — the
 * caller (a job, deliberately left as a documented seam per the pattern
 * `overrideExpiry.ts`/`syncFailure.ts` established) is responsible for
 * knowing which columns a given write changed.
 * ============================================================================
 */

/** Every Prisma model this classifier covers, by its exact DMMF model name. */
export const COVERED_MODELS = [
  "MetalReferencePrice",
  "StoneCost",
  "CostComponent",
  "PricingProfile",
  "LaborRate",
  "RingSizeBand",
  "VariantWeightOverride",
  "MasterVariantStone",
  "MasterVariant",
  "MasterProduct",
] as const;

export type CoveredModel = (typeof COVERED_MODELS)[number];

/**
 * Every covered model maps to exactly one `PricingInputChangeKind` (the
 * enum `pricing_input_change.kind` is stored as — see
 * `pricingInputChangeRepository.server.ts`). Kept as a single lookup table
 * rather than a second parameter a caller could mismatch (e.g. passing
 * `model: "MasterVariant"` alongside `kind: "master_product"`), so the two
 * can never disagree.
 *
 * `PricingInputChangeKind.manual` has no entry here — it is the
 * staff-initiated catch-all with no single covered model behind it.
 */
export const MODEL_TO_PRICING_INPUT_CHANGE_KIND = {
  MetalReferencePrice: "metal_reference_price",
  StoneCost: "stone_cost",
  CostComponent: "cost_component",
  PricingProfile: "pricing_profile",
  LaborRate: "labor_rate",
  RingSizeBand: "ring_size_band",
  VariantWeightOverride: "variant_weight_override",
  MasterVariantStone: "master_variant_stone",
  MasterVariant: "master_variant",
  MasterProduct: "master_product",
} as const satisfies Record<CoveredModel, string>;

/**
 * ALLOW-LIST. A column here means: a write that touches it, and only it,
 * DOES warrant a `pricing_input_change` row.
 */
export const PRICE_AFFECTING_COLUMNS: Readonly<Record<CoveredModel, readonly string[]>> = {
  // L1 raw inputs (Slice 1 §4.0/§4.2) — append-only, so in practice only
  // ever seen as a brand-new row (every field "changes" at once on
  // INSERT). Classified per-column anyway so the fence has something to
  // check them against, and so a future UPDATE path (there should never be
  // one — see the append-only triggers) inherits a real answer rather than
  // an assumed one.
  MetalReferencePrice: ["metal", "pricePerGram", "currency", "effectiveFrom"],
  StoneCost: [
    "stoneType",
    "shape",
    "caratMin",
    "caratMax",
    "color",
    "clarity",
    "cutGrade",
    "labStatus",
    "supplierRef",
    "costKind",
    "costMinorUnits",
    "costPerCarat",
    "currency",
    "effectiveFrom",
  ],
  CostComponent: ["componentType", "basis", "valueKind", "amountMinorUnits", "currency", "rate", "effectiveFrom"],
  PricingProfile: [
    "code",
    "version",
    "marginModel",
    "targetGrossMarginRate",
    "targetMarkupRate",
    "minGrossMarginRate",
    "minDollarProfitMinorUnits",
    "currency",
    "roundingRuleId",
    "priceEndingRuleId",
    "autoApplyToleranceBps",
    "regularCardPriceRuleId",
    "fixedCardUpliftRate",
    "effectiveFrom",
    "isPlaceholder",
  ],
  LaborRate: ["source", "ratePerGram", "currency", "effectiveFrom"],

  // Design-definition tables (Slice 1 §7.2) — genuinely MUTABLE, edited as
  // ordinary product configuration rather than versioned as history. Every
  // column here is one §5.1/§5.7 actually reads.
  RingSizeBand: ["masterProductId", "sizeMin", "sizeMax"],
  VariantWeightOverride: ["masterVariantId", "size", "weightGrams"],
  MasterVariantStone: ["masterVariantId", "stoneType", "shape", "carat", "color", "clarity", "cutGrade", "labStatus", "quantity"],

  // THE TWO TABLES THIS CLASSIFIER EXISTS FOR. Every non-price-affecting
  // column below carries its own stated reason in
  // NOT_PRICE_AFFECTING_COLUMNS — read those before extending either list.
  MasterVariant: [
    "masterProductId",
    "metal",
    "purity",
    "bandId",
    "baseWeightGrams",
    "weightPerFullSizeGrams",
    "laborSource",
    "minBankPaymentPriceMinorUnits",
    "minBankPaymentPriceCurrency",
  ],
  MasterProduct: ["sizeAxis", "allowedSizeMin", "allowedSizeMax", "sizeIncrement", "baseSize", "isLuxurySteal"],
};

/**
 * EXPLICIT DENY-LIST, WITH A REASON. Not consulted by the classifier's
 * decision (only the allow-list is) — it exists so the fence test can
 * confirm every column was a DELIBERATE exclusion, never an omission.
 */
export const NOT_PRICE_AFFECTING_COLUMNS: Readonly<Record<CoveredModel, Readonly<Record<string, string>>>> = {
  MetalReferencePrice: {
    id: "identity, not a value",
    source: "provenance only (Slice 1 §4.7 Seam A) — recorded and displayed, never selected on",
    enteredBy: "attribution, not a value; also nullable for feed-sourced rows",
    note: "free-text commentary, not read by resolution",
    createdAt: "bookkeeping timestamp, distinct from effectiveFrom",
  },
  StoneCost: {
    id: "identity, not a value",
    createdAt: "bookkeeping timestamp, distinct from effectiveFrom",
  },
  CostComponent: {
    id: "identity, not a value",
    enteredBy: "attribution, not a value",
    note: "free-text commentary, not read by resolution",
    createdAt: "bookkeeping timestamp, distinct from effectiveFrom",
  },
  PricingProfile: {
    id: "identity, not a value",
    createdBy: "attribution, not a value",
    createdAt: "bookkeeping timestamp, distinct from effectiveFrom",
  },
  LaborRate: {
    id: "identity, not a value",
    enteredBy: "attribution, not a value",
    note: "free-text commentary, not read by resolution",
    createdAt: "bookkeeping timestamp, distinct from effectiveFrom",
  },
  RingSizeBand: {
    id: "identity, not a value",
    label: "display string; §5.7 enumerates by sizeMin/sizeMax, never by label",
    sortOrder: "display ordering only; band evaluation is order-independent",
    createdAt: "bookkeeping timestamp",
  },
  VariantWeightOverride: {
    id: "identity, not a value",
    reason: "human-readable justification text, not read by §5.1 rule 1",
    createdAt: "bookkeeping timestamp",
  },
  MasterVariantStone: {
    id: "identity, not a value",
    position: "distinguishes rows for uniqueness only; §5.2 step 3's sum is order-independent",
    createdAt: "bookkeeping timestamp",
  },
  MasterVariant: {
    id: "identity, not a value",
    shopifyVariantGid: "Shopify linkage, not a pricing input",
    bankPaymentDiscountEligible:
      "Slice 2 checkout/payment-mode eligibility flag — governs which price a bank-mode cart line is CHARGED, never what the engine COMPUTES",
    status: "lifecycle state (draft/active/archived); does not change the computed price value itself",
    lastSyncedPriceCalculationId:
      "THE LOOP CASE. Stamped by the sync path on every successful publish (spec §6, R2/R3 context). " +
      "Classifying this as price-affecting would make publishing a price trigger the next " +
      "recalculation, which publishes a price, across the whole catalogue, forever.",
    createdAt: "bookkeeping timestamp",
    updatedAt: "bookkeeping timestamp",
  },
  MasterProduct: {
    id: "identity, not a value",
    name: "display string, not read by the engine",
    category: "catalogue categorisation; per-variant `metal`/`purity` already drive the cost formula",
    description: "display text, not read by the engine",
    offeredMetals: "which metals MAY be offered/selected in the catalogue UI, not which metal a priced variant uses",
    shopifyProductGid: "Shopify linkage, not a pricing input",
    status: "lifecycle state (draft/active/archived); does not change the computed price value itself",
    createdAt: "bookkeeping timestamp",
    updatedAt: "bookkeeping timestamp",
  },
};

export class UnclassifiedColumnError extends Error {
  constructor(
    readonly model: CoveredModel,
    readonly column: string
  ) {
    super(
      `Column "${column}" on ${model} is not classified as price-affecting or explicitly not — ` +
        `every persisted column on a covered model must be classified before a write touching it ` +
        `can be safely diffed for recalculation triggers (criterion 58). Add it to ` +
        `PRICE_AFFECTING_COLUMNS if it feeds the pricing engine, or to NOT_PRICE_AFFECTING_COLUMNS ` +
        `with a reason if it does not.`
    );
    this.name = "UnclassifiedColumnError";
  }
}

/**
 * Does a write touching exactly `changedColumns` on `model` warrant a
 * `pricing_input_change` row?
 *
 * FAILS LOUD on an unclassified column — never silently ignores it and
 * never silently treats it as price-affecting. An unclassified column is a
 * classification gap (close it in this file), not a runtime decision this
 * function is allowed to guess at.
 */
export function isPriceAffectingChange(model: CoveredModel, changedColumns: readonly string[]): boolean {
  const allowed = PRICE_AFFECTING_COLUMNS[model];
  const denied = NOT_PRICE_AFFECTING_COLUMNS[model];

  let anyPriceAffecting = false;
  for (const column of changedColumns) {
    const isAllowed = allowed.includes(column);
    const isDenied = Object.prototype.hasOwnProperty.call(denied, column);

    if (!isAllowed && !isDenied) {
      throw new UnclassifiedColumnError(model, column);
    }
    if (isAllowed) anyPriceAffecting = true;
  }

  return anyPriceAffecting;
}
