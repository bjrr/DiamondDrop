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
 * EVERYTHING IN THIS FILE IS THE BANK PAYMENT PRICE
 * (docs/BANK-CARD-PRICING.md, owner-locked 2026-09-18).
 *
 * The Bank Payment Price is the authoritative calculated selling price. Cost,
 * the target markup, the minimum gross-margin floor, the minimum dollar profit
 * and every variant floor are defined on it. Eligible bank methods are Zelle,
 * bank transfer, designated ACH, wire, and future explicitly approved
 * bank/manual methods.
 *
 * THE BANK-VS-CARD FEATURE MUST NOT TOUCH WHAT THIS FILE PRODUCES. Policy §2:
 * the Bank Payment Price is never discounted, increased or rounded by that
 * feature. The Regular/Card Price is derived afterwards, by a tiered uplift and
 * a $5 ceiling, and never flows back in. See regularCardPrice.ts.
 *
 * A card price entering here would inflate every margin by the uplift and let a
 * piece clear the floors on revenue it had not earned. Nothing in this module
 * accepts a card price, and nothing should start to.
 *
 * THE CIRCULARITY, AND WHY IT IS NOT A LOOP. A cost configured as a percentage
 * OF THE SELLING PRICE — full-value insurance, say — makes the price depend on
 * a cost that depends on the price. Where such a cost legitimately belongs to
 * the underlying economics it is solved algebraically rather than iteratively,
 * by putting its rate in the MARGIN MODEL's denominator. Card payment-processing
 * expense is not such a cost: the policy excludes it from profitability
 * entirely, and the floors below cannot see it at all.
 */

/**
 * WHAT "PROFITABILITY" MEANS HERE — named and versioned, because it is a
 * business decision rather than an arithmetic detail (owner-locked 2026-09-18):
 *
 *     contribution = bank payment price − landed cost
 *     gross margin = contribution / bank payment price
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
 * when on this basis the same tier is
 *
 *     bank base  = cost x 1.40
 *     tier price = cost x 1.40 x 0.90 = cost x 1.26
 *     margin     = 0.26 / 1.26 = 20.63%
 *
 * which clears the 20% floor. The floor was rejecting campaigns it should have
 * allowed.
 *
 * THE ID WAS RENAMED, NOT REVERSIONED. It read CASH_PRICE_... until the
 * vocabulary changed on 2026-09-18. No arithmetic moved: the same subtraction
 * on the same number, whose customer-facing NAME is now "Bank Payment Price".
 * Renaming is safe here specifically because nothing dispatches on this id — it
 * is descriptive metadata recorded alongside an evaluation, not a lookup key,
 * so no stored row is orphaned by the change. Had anything keyed off it, the
 * rename would have been a new id and a migration instead.
 *
 * The id exists so that adding a fee-aware floor later is a NEW basis with a
 * new id, not an edit to this one — the same contract the rounding,
 * price-ending, margin-model and card-price registries follow.
 */
export const PROFITABILITY_BASIS_ID = "BANK_PAYMENT_PRICE_GROSS_OF_PAYMENT_EXPENSE_V1" as const;

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
  /** The EXACT target BANK PAYMENT price in minor units, unrounded. */
  readonly targetBankPaymentPrice: (ctx: MarginModelContext) => MoneyDecimalValue;
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
   * bank payment price = cost x (1 + markupRate), markupRate = 0.40.
   *
   * NOT the same as a 40% gross margin, and the gap is large: 40% markup on a
   * $100 cost is $140, a 28.6% gross margin. A 40% gross margin on that cost is
   * $166.67. Using one for the other under-prices by roughly 16%.
   *
   * Revenue-side deductions are deliberately NOT solved into this, and — since
   * 2026-09-18 — they are not in the floors either. Markup sets the target on
   * the bank payment price; the floors are a separate safety net measured on
   * that same number.
   */
  MARKUP_ON_COST_V1: {
    id: "MARKUP_ON_COST_V1",
    targetBankPaymentPrice: ({ landedCostMinorUnits, profile }) => {
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
   * meaning. Moving it onto the fee-free basis is a new id
   * (TARGET_GROSS_MARGIN_ON_BANK_PAYMENT_V1) and an owner decision, not an
   * edit here.
   */
  TARGET_GROSS_MARGIN_V1: {
    id: "TARGET_GROSS_MARGIN_V1",
    targetBankPaymentPrice: ({ landedCostMinorUnits, revenueRate, revenueFixedMinorUnits, profile }) => {
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

export function solveExactBankPaymentPrice(input: SolveInput): {
  exactBankPayment: MoneyDecimalValue;
  binding: BindingConstraint;
} {
  const { landedCostMinorUnits: C } = input;

  const pTarget = getMarginModel(input.profile.marginModel).targetBankPaymentPrice({
    landedCostMinorUnits: C,
    revenueRate: input.revenueRate,
    revenueFixedMinorUnits: input.revenueFixedMinorUnits,
    profile: input.profile,
  });

  // The minimum-dollar-profit price, on the SAME basis the floor uses:
  //
  //     bank − cost >= minProfit   =>   bank >= cost + minProfit
  //
  // Previously this was (cost + fixedFee + minProfit) / (1 − revenueRate),
  // which solved for a profit NET of payment expense while the floor that
  // checks it is measured GROSS of it. Two statements of one rule that could
  // disagree; now there is one.
  const minDollarProfit = new MoneyDecimal(input.profile.minDollarProfit.amountMinorUnits);
  const pMinProfit = C.plus(minDollarProfit);
  const pFloor = input.variantFloorMinorUnits;

  let exactBankPayment = pTarget;
  let binding: BindingConstraint = "margin";
  if (pMinProfit.greaterThan(exactBankPayment)) {
    exactBankPayment = pMinProfit;
    binding = "min_profit";
  }
  if (pFloor.greaterThan(exactBankPayment)) {
    exactBankPayment = pFloor;
    binding = "variant_floor";
  }

  return { exactBankPayment, binding };
}

/**
 * The floors take a BANK PAYMENT price, a landed cost, and nothing else that
 * costs money. There is deliberately no field for a revenue-side rate or fixed
 * fee: their ABSENCE FROM THE TYPE is what stops payment expense re-entering
 * profitability through some future caller, which is how it got in the first
 * time. Re-admitting it means changing this interface, in the open.
 */
export interface FloorInput {
  bankPaymentPriceMinorUnits: bigint;
  landedCostMinorUnits: MoneyDecimalValue;
  minGrossMarginRate: MoneyDecimalValue;
  minDollarProfitMinorUnits: MoneyDecimalValue;
  variantFloorMinorUnits: MoneyDecimalValue;
}

/**
 * §5.5, PREDICATE ONLY — no loop. Split from `enforceFloors` deliberately:
 * it makes "is this rounded bank payment price acceptable?" a one-line test.
 *
 * Checks `minGrossMarginRate`, the hard FLOOR — never `targetGrossMarginRate`,
 * the objective. The schema enforces min <= target; comparing the rounded
 * price against the target would bump nearly every price by a cent for no
 * reason, and would look like it was working.
 */
export function evaluateFloors(input: FloorInput): FloorEvaluation {
  const bank = new MoneyDecimal(input.bankPaymentPriceMinorUnits.toString());
  const contribution = bank.minus(input.landedCostMinorUnits);
  const grossMargin = bank.isZero() ? new MoneyDecimal(0) : contribution.dividedBy(bank);

  const failing: FloorId[] = [];
  if (grossMargin.lessThan(input.minGrossMarginRate)) failing.push("min_gross_margin");
  if (contribution.lessThan(input.minDollarProfitMinorUnits)) failing.push("min_dollar_profit");
  if (bank.lessThan(input.variantFloorMinorUnits)) failing.push("variant_floor");

  return {
    satisfied: failing.length === 0,
    basisId: PROFITABILITY_BASIS_ID,
    bankPaymentContributionMinorUnits: contribution.toString(),
    bankPaymentGrossMarginRate: grossMargin.toString(),
    failing,
  };
}

/**
 * §5.5's bounded loop. Rounding can land a bank payment price marginally below
 * a hard floor; this nudges it up by `stepMinorUnits` until every floor passes.
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
): { bankPaymentPriceMinorUnits: bigint; bumps: number; final: FloorEvaluation } {
  let bank = input.bankPaymentPriceMinorUnits;
  let evaluation = evaluateFloors({ ...input, bankPaymentPriceMinorUnits: bank });
  let bumps = 0;

  while (!evaluation.satisfied) {
    if (bumps >= maxBumps) {
      throw new MarginFloorUnreachableError(
        bumps,
        bank.toString(),
        `still failing: ${evaluation.failing.join(", ")}`
      );
    }
    bank += stepMinorUnits;
    bumps += 1;
    evaluation = evaluateFloors({ ...input, bankPaymentPriceMinorUnits: bank });
  }

  return { bankPaymentPriceMinorUnits: bank, bumps, final: evaluation };
}
