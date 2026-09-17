import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

import { MarginFloorUnreachableError, UnreachableMarginError } from "./errors";
import type {
  BindingConstraint,
  FloorEvaluation,
  FloorId,
  MarginModelId,
  PricingProfileInputs,
} from "./types";

export type { MarginModelId };

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
 * What a margin model is given. It receives the whole profile rather than a
 * pre-selected rate, and that is the point of the design: each model reads the
 * rate IT needs, so adding a model never forces a caller to learn about that
 * model's parameters. `engine.ts` passes `inputs.profile` wholesale and has no
 * knowledge of any individual model.
 */
export interface MarginModelContext {
  landedCostMinorUnits: MoneyDecimalValue;
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  profile: PricingProfileInputs;
}

export interface MarginModel {
  readonly id: MarginModelId;
  /** The EXACT target price in minor units, unrounded. */
  readonly targetPrice: (ctx: MarginModelContext) => MoneyDecimalValue;
}

/**
 * The margin-model registry (§5.3, D14).
 *
 * Same versioning contract as the rounding, price-ending and credit-card
 * registries: an id referenced by a stored calculation may NEVER change
 * behaviour, because the stored calculation must stay reproducible. A change to
 * how a model prices is a new id and a migration, not an edit here.
 *
 * Adding a third model touches this registry, the id union in types.ts, the
 * profile rate it reads, and a migration extending the CHECK constraint. It
 * does NOT touch engine.ts — that was the seam this registry exists to fix.
 */
const MARGIN_MODELS: Record<MarginModelId, MarginModel> = {
  /**
   * MVP1 default, owner-resolved 2026-09-17: price = cost x (1 + markupRate),
   * markupRate = 0.40.
   *
   * NOT the same as a 40% gross margin, and the gap is large: 40% markup on a
   * $100 cost is $140, a 28.6% gross margin. A 40% gross margin on that cost is
   * $166.67. Using one for the other under-prices by roughly 16%.
   *
   * Revenue-side deductions are deliberately NOT solved into this. They reduce
   * realised margin, and the minimum-margin floor is what catches that. The
   * separation is the owner's stated design: markup sets the target, the floors
   * are a separate safety net.
   */
  MARKUP_ON_COST_V1: {
    id: "MARKUP_ON_COST_V1",
    targetPrice: ({ landedCostMinorUnits, profile }) => {
      const k = profile.targetMarkupRate;
      if (!k) {
        throw new UnreachableMarginError("undefined", "MARKUP_ON_COST_V1 requires targetMarkupRate");
      }
      return landedCostMinorUnits.times(new MoneyDecimal(1).plus(new MoneyDecimal(k)));
    },
  },

  /**
   * Gross margin as a fraction OF PRICE, which makes the price depend on fees
   * that depend on the price. Solved algebraically rather than iteratively:
   * revenue-side rates go into the denominator.
   */
  TARGET_GROSS_MARGIN_V1: {
    id: "TARGET_GROSS_MARGIN_V1",
    targetPrice: ({ landedCostMinorUnits, revenueRate, revenueFixedMinorUnits, profile }) => {
      const rate = profile.targetGrossMarginRate;
      if (!rate) {
        throw new UnreachableMarginError(
          "undefined",
          "TARGET_GROSS_MARGIN_V1 requires targetGrossMarginRate"
        );
      }
      const m = new MoneyDecimal(rate);
      const denominator = new MoneyDecimal(1).minus(m).minus(revenueRate);
      if (denominator.lessThanOrEqualTo(0)) {
        throw new UnreachableMarginError(
          denominator.toString(),
          `1 − targetGrossMargin(${m.toString()}) − revenueRate(${revenueRate.toString()})`
        );
      }
      return landedCostMinorUnits.plus(revenueFixedMinorUnits).dividedBy(denominator);
    },
  },
};

export class UnknownMarginModelError extends Error {
  constructor(readonly id: string) {
    super(`Unknown margin model id "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownMarginModelError";
  }
}

export function getMarginModel(id: MarginModelId): MarginModel {
  const model = MARGIN_MODELS[id];
  if (!model) throw new UnknownMarginModelError(id);
  return model;
}

export interface SolveInput {
  /**
   * Passed whole rather than destructured into named rates, so that a new
   * margin model's parameters never appear in this signature or in any caller.
   */
  profile: PricingProfileInputs;
  landedCostMinorUnits: MoneyDecimalValue;
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
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

  const pTarget = getMarginModel(input.profile.marginModel).targetPrice({
    landedCostMinorUnits: C,
    revenueRate: r,
    revenueFixedMinorUnits: f,
    profile: input.profile,
  });

  const minDollarProfit = new MoneyDecimal(input.profile.minDollarProfit.amountMinorUnits);
  const pMinProfit = C.plus(f).plus(minDollarProfit).dividedBy(profitDenominator);
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
