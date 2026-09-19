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
 * EVERYTHING IN THIS FILE IS THE CASH PRICE (docs/CASH-CARD-PRICING.md,
 * owner-locked 2026-09-18).
 *
 * Cost, the target markup, the minimum gross-margin floor, the minimum dollar
 * profit and every variant floor are defined on the CASH-EQUIVALENT price — the
 * price paid by ACH, wire, Zelle or check. The credit-card price is derived
 * AFTER this module has finished, as cash x (1 + uplift), and never flows back
 * in. See creditCardPrice.ts.
 *
 * A card price entering here would inflate every margin by the uplift and let a
 * piece clear the floors on revenue it had not earned. Nothing in this module
 * accepts a card price, and nothing should start to.
 *
 * THE CIRCULARITY, AND WHY IT IS NOT A LOOP. A cost configured as a percentage
 * OF THE SELLING PRICE — full-value insurance, say — makes the price depend on
 * a cost that depends on the price. Where such a cost legitimately belongs to
 * cash economics it is solved algebraically rather than iteratively, by putting
 * its rate in the MARGIN MODEL's denominator. Card payment-processing expense
 * is not such a cost: the policy excludes it from cash profitability entirely,
 * and the floors below cannot see it at all.
 */

/**
 * WHAT "PROFITABILITY" MEANS HERE — named and versioned, because it is a
 * business decision rather than an arithmetic detail (owner-locked 2026-09-18):
 *
 *     cash contribution = cash price − landed cost
 *     cash gross margin = cash contribution / cash price
 *
 * PAYMENT-PROCESSING EXPENSE IS NOT DEDUCTED. Card fees, and revenue-side
 * components generally, sit outside this definition. The owner's rule is that
 * the 20% margin floor and the $100 profit floor are measured GROSS of payment
 * expense, and that no such deduction is introduced without an explicit
 * business rule adding it.
 *
 * THIS IS A CORRECTION. An earlier revision subtracted the 2.9% + $0.30
 * processing component from contribution before testing the floors, which
 * understated margin by roughly three points on every item. It had a visible
 * consequence: a 10% Group Buy tier measured 17.8% and was refused publication,
 * when on the cash basis the same tier is
 *
 *     cash base  = cost x 1.40
 *     tier price = cost x 1.40 x 0.90 = cost x 1.26
 *     margin     = 0.26 / 1.26 = 20.63%
 *
 * which clears the 20% floor. The floor was rejecting campaigns it should have
 * allowed.
 *
 * The id exists so that adding a fee-aware floor later is a NEW basis with a
 * new id and a migration, not an edit to this one — the same contract the
 * rounding, price-ending, margin-model and credit-card registries follow.
 */
export const PROFITABILITY_BASIS_ID = "CASH_PRICE_GROSS_OF_PAYMENT_EXPENSE_V1" as const;

/**
 * What a margin model is given. It receives the whole profile rather than a
 * pre-selected rate, and that is the point of the design: each model reads the
 * rate IT needs, so adding a model never forces a caller to learn about that
 * model's parameters. `engine.ts` passes `inputs.profile` wholesale and has no
 * knowledge of any individual model.
 *
 * `revenueRate` / `revenueFixedMinorUnits` are supplied for the one model that
 * targets a margin NET of revenue-side deductions. They are not part of the
 * floor definition — see PROFITABILITY_BASIS_ID — and MARKUP_ON_COST_V1, the
 * MVP1 default, ignores them entirely.
 */
export interface MarginModelContext {
  landedCostMinorUnits: MoneyDecimalValue;
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  profile: PricingProfileInputs;
}

export interface MarginModel {
  readonly id: MarginModelId;
  /** The EXACT target CASH price in minor units, unrounded. */
  readonly targetCashPrice: (ctx: MarginModelContext) => MoneyDecimalValue;
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
   * MVP1 default, owner-resolved 2026-09-17:
   * cash price = cost x (1 + markupRate), markupRate = 0.40.
   *
   * NOT the same as a 40% gross margin, and the gap is large: 40% markup on a
   * $100 cost is $140, a 28.6% gross margin. A 40% gross margin on that cost is
   * $166.67. Using one for the other under-prices by roughly 16%.
   *
   * Revenue-side deductions are deliberately NOT solved into this, and — since
   * 2026-09-18 — they are not in the floors either. Markup sets the target on
   * cash; the floors are a separate safety net measured on the same cash basis.
   */
  MARKUP_ON_COST_V1: {
    id: "MARKUP_ON_COST_V1",
    targetCashPrice: ({ landedCostMinorUnits, profile }) => {
      const k = profile.targetMarkupRate;
      if (!k) {
        throw new UnreachableMarginError("undefined", "MARKUP_ON_COST_V1 requires targetMarkupRate");
      }
      return landedCostMinorUnits.times(new MoneyDecimal(1).plus(new MoneyDecimal(k)));
    },
  },

  /**
   * Gross margin as a fraction OF PRICE, NET of revenue-side deductions, which
   * makes the price depend on fees that depend on the price. Solved
   * algebraically rather than iteratively: revenue-side rates go into the
   * denominator.
   *
   * INCONSISTENT WITH THE FLOOR BASIS, deliberately and visibly. This model
   * targets a margin after payment expense while the floors are measured gross
   * of it, so it aims HIGHER than the floors require. The direction is safe —
   * it can over-price, never under-price — but the two definitions do not
   * agree, and an owner selecting this model should know that before doing so.
   *
   * No profile uses it; MVP1 runs MARKUP_ON_COST_V1. It is left unchanged
   * rather than quietly redefined, because a versioned id may not change
   * meaning. Moving it onto the cash basis is a new id
   * (TARGET_GROSS_MARGIN_ON_CASH_V1) and an owner decision, not an edit here.
   */
  TARGET_GROSS_MARGIN_V1: {
    id: "TARGET_GROSS_MARGIN_V1",
    targetCashPrice: ({ landedCostMinorUnits, revenueRate, revenueFixedMinorUnits, profile }) => {
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
  /**
   * Revenue-side rate and fixed amount. Reaches the MARGIN MODEL only — never
   * the floors. Present because TARGET_GROSS_MARGIN_V1 targets a margin net of
   * them; MARKUP_ON_COST_V1, the MVP1 default, does not read them at all.
   */
  revenueRate: MoneyDecimalValue;
  revenueFixedMinorUnits: MoneyDecimalValue;
  variantFloorMinorUnits: MoneyDecimalValue;
}

export function solveExactCashPrice(input: SolveInput): {
  exactCash: MoneyDecimalValue;
  binding: BindingConstraint;
} {
  const { landedCostMinorUnits: C } = input;

  const pTarget = getMarginModel(input.profile.marginModel).targetCashPrice({
    landedCostMinorUnits: C,
    revenueRate: input.revenueRate,
    revenueFixedMinorUnits: input.revenueFixedMinorUnits,
    profile: input.profile,
  });

  // The minimum-dollar-profit price, on the SAME cash basis the floor uses:
  //
  //     cash − cost >= minProfit   =>   cash >= cost + minProfit
  //
  // Previously this was (cost + fixedFee + minProfit) / (1 − revenueRate),
  // which solved for a profit NET of payment expense while the floor that
  // checks it is measured GROSS of it. Two statements of one rule that could
  // disagree; now there is one.
  const minDollarProfit = new MoneyDecimal(input.profile.minDollarProfit.amountMinorUnits);
  const pMinProfit = C.plus(minDollarProfit);
  const pFloor = input.variantFloorMinorUnits;

  let exactCash = pTarget;
  let binding: BindingConstraint = "margin";
  if (pMinProfit.greaterThan(exactCash)) {
    exactCash = pMinProfit;
    binding = "min_profit";
  }
  if (pFloor.greaterThan(exactCash)) {
    exactCash = pFloor;
    binding = "variant_floor";
  }

  return { exactCash, binding };
}

/**
 * The floors take a CASH price, a landed cost, and nothing else that costs
 * money. There is deliberately no field here for a revenue-side rate or a fixed
 * fee: their ABSENCE FROM THE TYPE is what stops payment expense re-entering
 * profitability through some future caller, which is how it got in the first
 * time. Re-admitting it means changing this interface, in the open.
 */
export interface FloorInput {
  cashPriceMinorUnits: bigint;
  landedCostMinorUnits: MoneyDecimalValue;
  minGrossMarginRate: MoneyDecimalValue;
  minDollarProfitMinorUnits: MoneyDecimalValue;
  variantFloorMinorUnits: MoneyDecimalValue;
}

/**
 * §5.5, PREDICATE ONLY — no loop. Split from `enforceFloors` deliberately:
 * it makes "is this rounded cash price acceptable?" a one-line test.
 *
 * Checks `minGrossMarginRate`, the hard FLOOR — never `targetGrossMarginRate`,
 * the objective. The schema enforces min <= target; comparing the rounded
 * price against the target would bump nearly every price by a cent for no
 * reason, and would look like it was working.
 */
export function evaluateFloors(input: FloorInput): FloorEvaluation {
  const cash = new MoneyDecimal(input.cashPriceMinorUnits.toString());
  const cashContribution = cash.minus(input.landedCostMinorUnits);
  const cashGrossMargin = cash.isZero() ? new MoneyDecimal(0) : cashContribution.dividedBy(cash);

  const failing: FloorId[] = [];
  if (cashGrossMargin.lessThan(input.minGrossMarginRate)) failing.push("min_gross_margin");
  if (cashContribution.lessThan(input.minDollarProfitMinorUnits)) failing.push("min_dollar_profit");
  if (cash.lessThan(input.variantFloorMinorUnits)) failing.push("variant_floor");

  return {
    satisfied: failing.length === 0,
    basisId: PROFITABILITY_BASIS_ID,
    cashContributionMinorUnits: cashContribution.toString(),
    cashGrossMarginRate: cashGrossMargin.toString(),
    failing,
  };
}

/**
 * §5.5's bounded loop. Rounding can land a cash price marginally below a hard
 * floor; this nudges it up by `stepMinorUnits` until every floor is satisfied.
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
): { cashPriceMinorUnits: bigint; bumps: number; final: FloorEvaluation } {
  let cash = input.cashPriceMinorUnits;
  let evaluation = evaluateFloors({ ...input, cashPriceMinorUnits: cash });
  let bumps = 0;

  while (!evaluation.satisfied) {
    if (bumps >= maxBumps) {
      throw new MarginFloorUnreachableError(
        bumps,
        cash.toString(),
        `still failing: ${evaluation.failing.join(", ")}`
      );
    }
    cash += stepMinorUnits;
    bumps += 1;
    evaluation = evaluateFloors({ ...input, cashPriceMinorUnits: cash });
  }

  return { cashPriceMinorUnits: cash, bumps, final: evaluation };
}
