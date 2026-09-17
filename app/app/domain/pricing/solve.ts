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

export interface SolveInput {
  landedCostMinorUnits: MoneyDecimalValue;
  targetGrossMarginRate: MoneyDecimalValue;
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  minDollarProfitMinorUnits: MoneyDecimalValue;
  variantFloorMinorUnits: MoneyDecimalValue;
}

export function solveExactPrice(input: SolveInput): {
  exact: MoneyDecimalValue;
  binding: BindingConstraint;
} {
  const { landedCostMinorUnits: C, targetGrossMarginRate: m, revenueRate: r } = input;
  const f = input.revenueFixedMinorUnits;

  const marginDenominator = new MoneyDecimal(1).minus(m).minus(r);
  if (marginDenominator.lessThanOrEqualTo(0)) {
    throw new UnreachableMarginError(
      marginDenominator.toString(),
      `1 − targetGrossMargin(${m.toString()}) − revenueRate(${r.toString()})`
    );
  }

  const profitDenominator = new MoneyDecimal(1).minus(r);
  if (profitDenominator.lessThanOrEqualTo(0)) {
    throw new UnreachableMarginError(profitDenominator.toString(), `1 − revenueRate(${r.toString()})`);
  }

  const pMargin = C.plus(f).dividedBy(marginDenominator);
  const pMinProfit = C.plus(f).plus(input.minDollarProfitMinorUnits).dividedBy(profitDenominator);
  const pFloor = input.variantFloorMinorUnits;

  let exact = pMargin;
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
 * §5.5's bounded loop. Rounding to the cent can land marginally below a hard
 * floor; this nudges up by one minor unit until every floor is satisfied.
 *
 * Bounded because an unsatisfiable configuration must fail loudly rather than
 * spin: if 100 cents of headroom does not clear the floors, the profile and
 * the cost are inconsistent and that needs a human.
 */
export function enforceFloors(
  input: FloorInput,
  maxBumps = 100
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
    price += 1n;
    bumps += 1;
    evaluation = evaluateFloors({ ...input, priceMinorUnits: price });
  }

  return { priceMinorUnits: price, bumps, final: evaluation };
}
