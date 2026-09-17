import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import { MarginFloorUnreachableError, UnreachableMarginError } from "./errors";
import type { BindingConstraint, FloorEvaluation, FloorId } from "./types";

/**
 * L5 — the price solve and the hard floors (spec §5.3, §5.5). Pure.
 *
 * THE CIRCULARITY, AND WHY THIS IS NOT A LOOP. Payment processing and
 * full-value insurance are percentages OF THE SELLING PRICE, so the price
 * depends on fees that depend on the price. Solved algebraically instead of
 * iteratively: revenue-side rates go into the denominator.
 *
 *     P = (C + f) / (1 − m − r)
 *
 * Gross margin is defined ON PRICE, not on cost, because R11 states the
 * validation rule as a minimum gross-margin percentage and the solve and the
 * floor check must use the same definition.
 */

/**
 * The two margin models (§5.3, D14).
 *
 * MARKUP_ON_COST_V1 is the MVP1 default, owner-resolved 2026-09-17:
 *
 *     price = cost x (1 + markupRate)        markupRate = 0.40
 *
 * This is NOT the same as a 40% gross margin, and the difference is large
 * enough to matter: 40% markup on a $100 cost is $140, which is a 28.6% gross
 * margin. A 40% gross margin on the same cost is $166.67. Using one number for
 * the other under-prices by roughly 16%.
 *
 * TARGET_GROSS_MARGIN_V1 solves for a fraction OF PRICE and remains available
 * for profiles that want it.
 */
export type MarginModelId = "MARKUP_ON_COST_V1" | "TARGET_GROSS_MARGIN_V1";

export interface SolveInput {
  marginModel: MarginModelId;
  landedCostMinorUnits: MoneyDecimalValue;
  /** Fraction OF PRICE. Required for TARGET_GROSS_MARGIN_V1. */
  targetGrossMarginRate?: MoneyDecimalValue;
  /** Fraction OF COST. Required for MARKUP_ON_COST_V1. */
  targetMarkupRate?: MoneyDecimalValue;
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  minDollarProfitMinorUnits: MoneyDecimalValue;
  variantFloorMinorUnits: MoneyDecimalValue;
}

export function solveExactPrice(input: SolveInput): {
  exact: MoneyDecimalValue;
  binding: BindingConstraint;
} {
  const { landedCostMinorUnits: C, revenueRate: r } = input;
  const f = input.revenueFixedMinorUnits;

  const profitDenominator = new MoneyDecimal(1).minus(r);
  if (profitDenominator.lessThanOrEqualTo(0)) {
    throw new UnreachableMarginError(profitDenominator.toString(), `1 − revenueRate(${r.toString()})`);
  }

  let pTarget: MoneyDecimalValue;

  if (input.marginModel === "MARKUP_ON_COST_V1") {
    const k = input.targetMarkupRate;
    if (!k) {
      throw new UnreachableMarginError("undefined", "MARKUP_ON_COST_V1 requires targetMarkupRate");
    }
    // Directly expressed, per D14: price = cost x (1 + markup). Revenue-side
    // deductions are NOT solved into this — they reduce realised margin, and
    // the minimum-margin floor below is what catches that. That separation is
    // the owner's stated design: markup sets the target, the floors are a
    // separate safety net.
    pTarget = C.times(new MoneyDecimal(1).plus(k));
  } else {
    const m = input.targetGrossMarginRate;
    if (!m) {
      throw new UnreachableMarginError(
        "undefined",
        "TARGET_GROSS_MARGIN_V1 requires targetGrossMarginRate"
      );
    }
    const marginDenominator = new MoneyDecimal(1).minus(m).minus(r);
    if (marginDenominator.lessThanOrEqualTo(0)) {
      throw new UnreachableMarginError(
        marginDenominator.toString(),
        `1 − targetGrossMargin(${m.toString()}) − revenueRate(${r.toString()})`
      );
    }
    pTarget = C.plus(f).dividedBy(marginDenominator);
  }

  const pMinProfit = C.plus(f).plus(input.minDollarProfitMinorUnits).dividedBy(profitDenominator);
  const pFloor = input.variantFloorMinorUnits;

  let exact = pTarget;
  let binding: BindingConstraint = "margin";
  if (pMinProfit.greaterThan(exact)) {
    exact = pMinProfit;
    binding = "min_profit";
  }
  if (pFloor.greaterThan(exact)) {
    exact = pFloor;
    binding = "variant_floor";
  }

  return { exact, binding };
}

export interface FloorInput {
  priceMinorUnits: bigint;
  landedCostMinorUnits: MoneyDecimalValue;
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  minGrossMarginRate: MoneyDecimalValue;
  minDollarProfitMinorUnits: MoneyDecimalValue;
  variantFloorMinorUnits: MoneyDecimalValue;
}

/**
 * §5.5, PREDICATE ONLY — no loop. Split from `enforceFloors` deliberately:
 * it makes "is this rounded price acceptable?" a one-line test.
 *
 * Checks `minGrossMarginRate`, the hard FLOOR — never `targetGrossMarginRate`,
 * the objective. The schema enforces min <= target; comparing the rounded
 * price against the target would bump nearly every price by a cent for no
 * reason, and would look like it was working.
 */
export function evaluateFloors(input: FloorInput): FloorEvaluation {
  const price = new MoneyDecimal(input.priceMinorUnits.toString());
  const deductions = input.revenueRate.times(price).plus(input.revenueFixedMinorUnits);
  const contribution = price.minus(deductions).minus(input.landedCostMinorUnits);
  const grossMargin = price.isZero() ? new MoneyDecimal(0) : contribution.dividedBy(price);

  const failing: FloorId[] = [];
  if (grossMargin.lessThan(input.minGrossMarginRate)) failing.push("min_gross_margin");
  if (contribution.lessThan(input.minDollarProfitMinorUnits)) failing.push("min_dollar_profit");
  if (price.lessThan(input.variantFloorMinorUnits)) failing.push("variant_floor");

  return {
    satisfied: failing.length === 0,
    contribution: contribution.toString(),
    grossMargin: grossMargin.toString(),
    failing,
  };
}

/**
 * §5.5's bounded loop. Rounding can land a price marginally below a hard floor;
 * this nudges it up by `stepMinorUnits` until every floor is satisfied.
 *
 * Bounded because an unsatisfiable configuration must fail loudly rather than
 * spin. Note that the CAP IS IN BUMPS, NOT IN MONEY, so the headroom it allows
 * scales with the step: 100 bumps of one minor unit is $1.00, but 100 bumps of
 * a whole dollar is $100.00. That is intentional — a whole-dollar price needs
 * whole-dollar room to clear the same floor — but it means the ceiling is
 * generous under WHOLE_DOLLAR_UP_V1, and a price that climbs anywhere near it
 * indicates a profile and a cost that disagree, which needs a human rather than
 * a larger cap.
 */
export function enforceFloors(
  input: FloorInput,
  maxBumps = 100,
  /**
   * Bump granularity, taken from the price-ending rule. A whole-dollar price
   * must be nudged by a whole dollar: stepping by one minor unit would turn
   * $140 into $140.01 and quietly undo the rounding rule just applied.
   */
  stepMinorUnits = 1n
): { priceMinorUnits: bigint; bumps: number; final: FloorEvaluation } {
  let price = input.priceMinorUnits;
  let evaluation = evaluateFloors({ ...input, priceMinorUnits: price });
  let bumps = 0;

  while (!evaluation.satisfied) {
    if (bumps >= maxBumps) {
      throw new MarginFloorUnreachableError(
        bumps,
        price.toString(),
        `still failing: ${evaluation.failing.join(", ")}`
      );
    }
    price += stepMinorUnits;
    bumps += 1;
    evaluation = evaluateFloors({ ...input, priceMinorUnits: price });
  }

  return { priceMinorUnits: price, bumps, final: evaluation };
}
