import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";

import { enumerateBandSizes, selectBandPrice } from "./bands";
import { calculateLandedCost, partitionRevenueSide } from "./cost";
import { PricingCurrencyMismatchError } from "./errors";
import { deriveCashPrice } from "./cashPrice";
import { applyPriceEnding, getPriceEndingRule } from "./priceEnding";
import { enforceFloors, evaluateFloors, solveExactPrice } from "./solve";
import type {
  BuyNowBandPriceResult,
  BuyNowBandPricingInputs,
  BuyNowPriceResult,
  BuyNowPricingInputs,
} from "./types";
import { PRICING_ENGINE_VERSION } from "./version";
import { calculateWeightGrams } from "./weight";

/**
 * L5 — the Buy Now pricing engine (spec §5.6). Pure: no I/O, no clock, no
 * randomness. `asOf` is a field on `inputs`, never read from a system clock,
 * which is what makes a stored calculation reproducible without a database.
 *
 * ANTI-MONOLITH RULE (criterion 35). This file performs NO money or rate
 * arithmetic of its own. Every `+ − × ÷` on a money or decimal quantity lives
 * in cost.ts, solve.ts, weight.ts or Money. What follows is a sequence of
 * named calls. If a formula appears here, the formula is in the wrong file —
 * add a named function rather than inlining "just this one subtraction".
 *
 * The `new MoneyDecimal(...)` calls below are parsing at the boundary, not
 * arithmetic: they turn JSON-safe decimal strings into the exact type the
 * calculation modules expect.
 */
export function computeBuyNowPrice(inputs: BuyNowPricingInputs): BuyNowPriceResult {
  assertCurrenciesMatch(inputs);

  const weightGrams = calculateWeightGrams(inputs.weight, inputs.size);

  const { landedCost, breakdown } = calculateLandedCost({
    pricePerGramMinorUnits: inputs.metalPricePerGramMinorUnits,
    weightGrams,
    stones: inputs.stones,
    components: inputs.components,
  });

  const revenueSide = partitionRevenueSide(inputs.components);

  // The profile goes in WHOLE. This file names no margin model and no
  // model-specific rate, which is what lets a new model be added without
  // touching the engine — the seam that the first version of this got wrong.
  const { exact, binding } = solveExactPrice({
    profile: inputs.profile,
    landedCostMinorUnits: landedCost,
    revenueRate: revenueSide.rate,
    revenueFixedMinorUnits: revenueSide.fixedMinorUnits,
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  });

  const ended = finalise(exact, inputs);

  const floorInput = {
    priceMinorUnits: ended,
    landedCostMinorUnits: landedCost,
    revenueRate: revenueSide.rate,
    revenueFixedMinorUnits: revenueSide.fixedMinorUnits,
    minGrossMarginRate: new MoneyDecimal(inputs.profile.minGrossMarginRate),
    minDollarProfitMinorUnits: new MoneyDecimal(inputs.profile.minDollarProfit.amountMinorUnits),
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  };
  // The floor loop steps by the price-ending granularity, so a whole-dollar
  // price stays a whole dollar even when a floor forces it upward.
  const { priceMinorUnits, bumps, final } = enforceFloors(
    floorInput,
    100,
    getPriceEndingRule(inputs.profile.priceEndingRuleId).stepMinorUnits
  );

  // D9. The cash price is derived from the FINAL list price — after rounding,
  // price ending and every floor bump — not from the exact solve. Deriving it
  // from the exact value would let the two disagree: a list price nudged up a
  // dollar to clear a floor would keep a cash price computed from the pre-bump
  // figure, and the advertised discount would not match the prices shown.
  //
  // The rule owns its own rounding (floor to whole dollars) rather than reusing
  // the list price's ending rule, because a discount rounded the wrong way is
  // advertised at 5% and delivered at 4.87%. See cashPrice.ts.
  const cashPriceMinorUnits = deriveCashPrice(
    priceMinorUnits,
    new MoneyDecimal(inputs.profile.cashDiscountRate),
    inputs.profile.cashPriceRuleId
  );

  // Evaluated for the RECORD, never enforced: the owner's instruction is that
  // the discount overrides the profit minimums. Passing `final` through
  // unchanged would hide how often that happens.
  const cashFloors = evaluateFloors({ ...floorInput, priceMinorUnits: cashPriceMinorUnits });

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    currency: inputs.currency,
    size: inputs.size,
    weightGrams,
    breakdown,
    exactPriceMinorUnits: exact.toString(),
    binding,
    price: Money.fromMinorUnits(priceMinorUnits, inputs.currency).toJSON(),
    cashPrice: Money.fromMinorUnits(cashPriceMinorUnits, inputs.currency).toJSON(),
    cashPriceRuleId: inputs.profile.cashPriceRuleId,
    cashDiscountRate: inputs.profile.cashDiscountRate,
    cashFloors,
    floors: final,
    bumps,
    roundingRuleId: inputs.profile.roundingRuleId,
    priceEndingRuleId: inputs.profile.priceEndingRuleId,
    profileVersion: inputs.profile.version,
  };
}

/**
 * Binds `computeBuyNowPrice` into `selectBandPrice` (§5.7). Every allowed size
 * in the band is priced; the band takes the maximum. `bands.ts` never imports
 * this module — the evaluation is injected here.
 */
export function computeBuyNowBandPrice(inputs: BuyNowBandPricingInputs): BuyNowBandPriceResult {
  const candidates = enumerateBandSizes(inputs.band, inputs.weight);

  const selection = selectBandPrice(candidates, (size) => {
    const result = computeBuyNowPrice({ ...inputs, size });
    return { priceMinorUnits: BigInt(result.price.amountMinorUnits), result };
  });

  return {
    band: inputs.band,
    bandPrice: Money.fromMinorUnits(selection.bandPrice, inputs.currency).toJSON(),
    costBasisSize: selection.costBasisSize,
    perSize: selection.perSize,
    winning: selection.winning,
  };
}

/**
 * THE single load-bearing rounding boundary (§5.4), plus the price ending that
 * always follows it. Everything upstream is exact decimal; everything
 * downstream is whole minor units.
 *
 * Extracted because the cash price and the card price must cross that boundary
 * IDENTICALLY. Written out twice, the two could drift — a different rounding
 * rule on one, or a price ending applied to one and not the other — and the
 * symptom would be a card price that is not a clean multiple of the cash price,
 * which reads as a rounding curiosity rather than as a bug.
 *
 * This is sequencing, not arithmetic: the rounding lives in the rounding
 * registry and the ending in the price-ending registry. The anti-monolith rule
 * for this file still holds.
 */
function finalise(exact: MoneyDecimalValue, inputs: BuyNowPricingInputs): bigint {
  const rounded = Money.fromDecimalMinorUnits(exact, inputs.currency, inputs.profile.roundingRuleId);
  return applyPriceEnding(rounded.amountMinorUnits, inputs.profile.priceEndingRuleId);
}

/**
 * Every monetary input must share the calculation's currency. Mixing them
 * would produce a numerically plausible price in no currency at all.
 */
function assertCurrenciesMatch(inputs: BuyNowPricingInputs): void {
  const expect = (actual: string | undefined, where: string): void => {
    if (actual !== undefined && actual !== inputs.currency) {
      throw new PricingCurrencyMismatchError(inputs.currency, actual, where);
    }
  };

  expect(inputs.profile.minDollarProfit.currency, "profile.minDollarProfit");
  expect(inputs.variantFloor?.currency, "variantFloor");
  for (const component of inputs.components) {
    expect(component.amount?.currency, `component ${component.componentType}`);
  }
  for (const stone of inputs.stones) {
    expect(stone.unitCost?.currency, `stone position ${stone.position}`);
  }
}
