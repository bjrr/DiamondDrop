import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";

import { enumerateBandSizes, selectBandPrice } from "./bands";
import { calculateLandedCost, partitionRevenueSide } from "./cost";
import { PricingCurrencyMismatchError } from "./errors";
import { deriveCreditCardPrice } from "./creditCardPrice";
import { applyPriceEnding, getPriceEndingRule } from "./priceEnding";
import { enforceFloors, solveExactPrice } from "./solve";
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

  const { exact, binding } = solveExactPrice({
    marginModel: inputs.profile.marginModel,
    landedCostMinorUnits: landedCost,
    targetGrossMarginRate: inputs.profile.targetGrossMarginRate
      ? new MoneyDecimal(inputs.profile.targetGrossMarginRate)
      : undefined,
    targetMarkupRate: inputs.profile.targetMarkupRate
      ? new MoneyDecimal(inputs.profile.targetMarkupRate)
      : undefined,
    revenueRate: revenueSide.rate,
    revenueFixedMinorUnits: revenueSide.fixedMinorUnits,
    minDollarProfitMinorUnits: new MoneyDecimal(inputs.profile.minDollarProfit.amountMinorUnits),
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  });

  // THE single load-bearing rounding boundary (§5.4). Everything above is
  // exact decimal; everything below is whole minor units.
  const rounded = Money.fromDecimalMinorUnits(exact, inputs.currency, inputs.profile.roundingRuleId);
  const ended = applyPriceEnding(rounded.amountMinorUnits, inputs.profile.priceEndingRuleId);

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

  // D9. The card price is derived from the FINAL cash price — after rounding,
  // price ending and every floor bump — not from the exact solve. Deriving it
  // from the exact value would let the two prices disagree: a cash price nudged
  // a dollar to clear a floor would keep a card price computed from the pre-bump
  // figure. It then passes through the same rounding boundary and the same
  // price-ending rule, so a whole-dollar cash price yields a whole-dollar card
  // price rather than $366.45.
  const exactCardPrice = deriveCreditCardPrice(
    new MoneyDecimal(priceMinorUnits.toString()),
    new MoneyDecimal(inputs.profile.creditCardUpliftRate),
    inputs.profile.creditCardPriceRuleId
  );
  const cardPrice = applyPriceEnding(
    Money.fromDecimalMinorUnits(exactCardPrice, inputs.currency, inputs.profile.roundingRuleId)
      .amountMinorUnits,
    inputs.profile.priceEndingRuleId
  );

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    currency: inputs.currency,
    size: inputs.size,
    weightGrams,
    breakdown,
    exactPriceMinorUnits: exact.toString(),
    binding,
    price: Money.fromMinorUnits(priceMinorUnits, inputs.currency).toJSON(),
    creditCardPrice: Money.fromMinorUnits(cardPrice, inputs.currency).toJSON(),
    creditCardPriceRuleId: inputs.profile.creditCardPriceRuleId,
    creditCardUpliftRate: inputs.profile.creditCardUpliftRate,
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
