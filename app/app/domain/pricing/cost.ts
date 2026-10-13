import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import type {
  CostBreakdown,
  DecimalString,
  ResolvedCostComponent,
  ResolvedStonePosition,
} from "./types";

/**
 * L3 — landed cost (spec §5.2). Pure; every input arrives as an argument.
 *
 * Nothing here rounds. Every value is an exact MoneyDecimal in MINOR units,
 * fractional minor units permitted, all the way to the single rounding
 * boundary at the final price (§5.4). The breakdown strings this module
 * returns are display projections and must never re-enter a calculation.
 */

/**
 * The evaluation order of cost_side components, as a named function rather
 * than an implicit array order — because the order is LOAD-BEARING. A
 * `cost_side` percentage component applies to the subtotal accumulated
 * *before* it, so moving warranty_reserve above packaging silently changes
 * every price.
 */
const COST_SIDE_ORDER: readonly string[] = [
  // labour
  "cad",
  "casting",
  "setting",
  "polishing",
  "assembly",
  "qc",
  // overhead, in the fixed §5.2 step-5 order
  "packaging",
  "shipping",
  "insurance",
  "warranty_reserve",
  "supplier_fee",
  "other",
];

const LABOUR_TYPES = new Set(["cad", "casting", "setting", "polishing", "assembly", "qc"]);

export function orderCostSideComponents(
  components: readonly ResolvedCostComponent[]
): readonly ResolvedCostComponent[] {
  const costSide = components.filter((c) => c.basis === "cost_side" && c.componentType !== "metal_loss");
  return [...costSide].sort((a, b) => {
    const ai = COST_SIDE_ORDER.indexOf(a.componentType);
    const bi = COST_SIDE_ORDER.indexOf(b.componentType);
    // Unknown types sort last, deterministically by name, rather than
    // landing at an arbitrary position that would shift percentage bases.
    if (ai === -1 && bi === -1) return a.componentType.localeCompare(b.componentType);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/** §5.2 steps 1-2. */
export function calculateMetalCost(input: {
  pricePerGramMinorUnits: DecimalString;
  weightGrams: DecimalString;
  metalLossRate: DecimalString;
}): MoneyDecimalValue {
  const base = new MoneyDecimal(input.pricePerGramMinorUnits).times(input.weightGrams);
  return base.plus(base.times(input.metalLossRate));
}

/**
 * Manufacturing labour: finished GRAMS x the rate per gram for the variant's
 * manufacturing source.
 *
 * Its own named function, and its own line in the breakdown, because it is the
 * one cost that scales with weight rather than with stones or with a
 * percentage. Rolling it into the component loop would bury the single largest
 * lever on a heavy piece.
 *
 * DISTINCT FROM STONE SETTING. Setting is per-stone or fixed and flows through
 * applyCostSideComponents; this does not. A heavy plain band and a light
 * multi-stone piece must not produce the same labour figure.
 */
export function calculateManufacturingLabour(input: {
  ratePerGramMinorUnits: DecimalString;
  weightGrams: DecimalString;
}): MoneyDecimalValue {
  return new MoneyDecimal(input.ratePerGramMinorUnits).times(input.weightGrams);
}

/** §5.2 step 3. Returns the stone count too — `per_stone` labour needs it. */
export function calculateStoneCost(positions: readonly ResolvedStonePosition[]): {
  totalMinorUnits: MoneyDecimalValue;
  stoneCount: number;
} {
  let total = new MoneyDecimal(0);
  let stoneCount = 0;

  for (const position of positions) {
    const quantity = position.quantity;
    stoneCount += quantity;

    const unit =
      position.unitCost !== undefined
        ? new MoneyDecimal(position.unitCost.amountMinorUnits)
        : new MoneyDecimal(position.perCaratCost ?? "0").times(position.carat ?? "0");

    total = total.plus(unit.times(quantity));
  }

  return { totalMinorUnits: total, stoneCount };
}

/**
 * §5.2 steps 4-5. All three value kinds, evaluated in the given order.
 * A `percentage` component applies to the subtotal accumulated so far.
 */
export function applyCostSideComponents(
  subtotal: MoneyDecimalValue,
  ordered: readonly ResolvedCostComponent[],
  stoneCount: number
): { total: MoneyDecimalValue; perComponent: readonly { componentType: string; amount: MoneyDecimalValue }[] } {
  let running = subtotal;
  const perComponent: { componentType: string; amount: MoneyDecimalValue }[] = [];

  for (const component of ordered) {
    let amount: MoneyDecimalValue;
    switch (component.valueKind) {
      case "fixed":
        amount = new MoneyDecimal(component.amount?.amountMinorUnits ?? "0");
        break;
      case "per_stone":
        amount = new MoneyDecimal(component.amount?.amountMinorUnits ?? "0").times(stoneCount);
        break;
      case "percentage":
        amount = running.times(component.rate ?? "0");
        break;
    }
    running = running.plus(amount);
    perComponent.push({ componentType: component.componentType, amount });
  }

  return { total: running, perComponent };
}

export interface LandedCostInput {
  pricePerGramMinorUnits: DecimalString;
  weightGrams: DecimalString;
  stones: readonly ResolvedStonePosition[];
  components: readonly ResolvedCostComponent[];
  /**
   * Manufacturing labour rate per gram, in MINOR units, for this variant's
   * source. Optional so existing callers and fixtures keep working; absent
   * means no grams-based labour, which is different from a zero rate only in
   * that nothing appears in the breakdown.
   */
  laborRatePerGramMinorUnits?: DecimalString;
}

export interface LandedCostResult {
  landedCost: MoneyDecimalValue;
  breakdown: CostBreakdown;
  stoneCount: number;
}

/** §5.2 end to end. Composes the functions above; adds no arithmetic of its own. */
export function calculateLandedCost(input: LandedCostInput): LandedCostResult {
  const metalLoss = input.components.find((c) => c.componentType === "metal_loss");
  const metal = calculateMetalCost({
    pricePerGramMinorUnits: input.pricePerGramMinorUnits,
    weightGrams: input.weightGrams,
    metalLossRate: metalLoss?.rate ?? "0",
  });

  const { totalMinorUnits: stones, stoneCount } = calculateStoneCost(input.stones);

  // Added to the base BEFORE the component loop, so any percentage-based
  // component (overhead, warranty reserve) is applied to a cost that already
  // includes labour. Applying them to metal + stones alone would understate
  // every percentage on a labour-heavy piece.
  const manufacturingLabour = input.laborRatePerGramMinorUnits
    ? calculateManufacturingLabour({
        ratePerGramMinorUnits: input.laborRatePerGramMinorUnits,
        weightGrams: input.weightGrams,
      })
    : new MoneyDecimal(0);

  const ordered = orderCostSideComponents(input.components);
  const { total, perComponent } = applyCostSideComponents(
    metal.plus(stones).plus(manufacturingLabour),
    ordered,
    stoneCount
  );

  // Component-driven labour (setting, polishing, QC…) PLUS the grams-based
  // manufacturing rate. Both are labour; they are summed for the headline and
  // itemised separately below.
  const labour = sumOf(perComponent.filter((c) => LABOUR_TYPES.has(c.componentType))).plus(
    manufacturingLabour
  );
  const overhead = sumOf(perComponent.filter((c) => !LABOUR_TYPES.has(c.componentType)));

  return {
    landedCost: total,
    stoneCount,
    breakdown: {
      metalMinorUnits: metal.toString(),
      stonesMinorUnits: stones.toString(),
      labourMinorUnits: labour.toString(),
      /// Broken out so "grams x rate" is auditable on its own, separately from
      /// per-stone setting and the other labour components.
      manufacturingLabourMinorUnits: manufacturingLabour.toString(),
      overheadMinorUnits: overhead.toString(),
      landedCostMinorUnits: total.toString(),
      perComponent: perComponent.map((c) => ({
        componentType: c.componentType,
        amountMinorUnits: c.amount.toString(),
      })),
    },
  };
}

/**
 * §5.3's `r` and `f` for revenue-side costs that legitimately belong to the
 * authoritative BANK PAYMENT PRICE economics. Card payment-processing expense
 * is NOT one of those under docs/BANK-CARD-PRICING.md §4 — and `FloorInput` has
 * no field for a revenue-side rate at all, so a caller cannot reintroduce it by
 * accident rather than merely being told not to. The tiered card uplift is a
 * separate derived display/payment layer.
 */
export function partitionRevenueSide(components: readonly ResolvedCostComponent[]): {
  rate: MoneyDecimalValue;
  fixedMinorUnits: MoneyDecimalValue;
} {
  let rate = new MoneyDecimal(0);
  let fixed = new MoneyDecimal(0);

  for (const component of components) {
    if (component.basis !== "revenue_side") continue;
    if (component.valueKind === "percentage") {
      rate = rate.plus(component.rate ?? "0");
    } else {
      fixed = fixed.plus(component.amount?.amountMinorUnits ?? "0");
    }
  }

  return { rate, fixedMinorUnits: fixed };
}

function sumOf(entries: readonly { amount: MoneyDecimalValue }[]): MoneyDecimalValue {
  return entries.reduce((acc, entry) => acc.plus(entry.amount), new MoneyDecimal(0));
}
