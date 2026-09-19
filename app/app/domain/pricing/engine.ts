import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";

import { enumerateBandSizes, selectBandPrice } from "./bands";
import { calculateLandedCost, partitionRevenueSide } from "./cost";
import { PricingCurrencyMismatchError } from "./errors";
import { deriveCreditCardPrice } from "./creditCardPrice";
import { applyPriceEnding, getPriceEndingRule } from "./priceEnding";
import { enforceFloors, solveExactCashPrice } from "./solve";
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
 *
 * THE ORDER OF THE TWO PRICES IS THE BUSINESS RULE (owner-locked 2026-09-18).
 * Cost, markup, rounding, price ending and every floor run on the CASH price
 * and finish completely. Only then is the credit-card price derived from the
 * settled cash figure. Nothing downstream of that derivation feeds back, so the
 * 5% uplift cannot reach a cost, a markup, a margin floor or a profit floor.
 */
export function computeBuyNowPrice(inputs: BuyNowPricingInputs): BuyNowPriceResult {
  assertCurrenciesMatch(inputs);

  const weightGrams = calculateWeightGrams(inputs.weight, inputs.size);

  const { landedCost, breakdown } = calculateLandedCost({
    pricePerGramMinorUnits: inputs.metalPricePerGramMinorUnits,
    weightGrams,
    stones: inputs.stones,
    components: inputs.components,
    laborRatePerGramMinorUnits: inputs.laborRatePerGramMinorUnits,
  });

  const revenueSide = partitionRevenueSide(inputs.components);

  // The profile goes in WHOLE. This file names no margin model and no
  // model-specific rate, which is what lets a new model be added without
  // touching the engine — the seam that the first version of this got wrong.
  const { exactCash, binding } = solveExactCashPrice({
    profile: inputs.profile,
    landedCostMinorUnits: landedCost,
    revenueRate: revenueSide.rate,
    revenueFixedMinorUnits: revenueSide.fixedMinorUnits,
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  });

  const endedCash = finalise(exactCash, inputs);

  // NO REVENUE-SIDE FIGURES REACH THE FLOORS. `revenueSide` is resolved above
  // for the margin model alone; `FloorInput` has no field for it, so payment
  // processing cannot be deducted from the margin or the minimum profit. That
  // is the owner's rule, and the shape of the type is what keeps it.
  const floorInput = {
    cashPriceMinorUnits: endedCash,
    landedCostMinorUnits: landedCost,
    minGrossMarginRate: new MoneyDecimal(inputs.profile.minGrossMarginRate),
    minDollarProfitMinorUnits: new MoneyDecimal(inputs.profile.minDollarProfit.amountMinorUnits),
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  };
  // The floor loop steps by the price-ending granularity, so a whole-dollar
  // price stays a whole dollar even when a floor forces it upward.
  const { cashPriceMinorUnits, bumps, final } = enforceFloors(
    floorInput,
    100,
    getPriceEndingRule(inputs.profile.priceEndingRuleId).stepMinorUnits
  );

  // D9, AND THE LAST THING THAT HAPPENS. The displayed credit-card price is
  // derived from the FINAL cash price — after rounding, price ending and every
  // floor bump — not from the exact solve. Deriving it from the exact value
  // would let the two disagree: a cash price nudged up a dollar to clear a
  // floor would keep a card price computed from the pre-bump figure, and the
  // pair shown to the customer would not be consistent with each other.
  //
  // The rule owns its own rounding (ceiling to whole dollars) rather than
  // reusing the price-ending rule, because rounding a derived price DOWN would
  // put it under the uplift the configuration asked for. See creditCardPrice.ts.
  //
  // No floor evaluation for the card price: it is strictly above the cash
  // price, which has already satisfied every floor, so it satisfies them too.
  // Evaluating the floors against it would also be WRONG — it would report a
  // margin inflated by the uplift, which is not margin the business earns.
  const creditCardPriceMinorUnits = deriveCreditCardPrice(
    cashPriceMinorUnits,
    new MoneyDecimal(inputs.profile.creditCardUpliftRate),
    inputs.profile.creditCardPriceRuleId
  );

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    currency: inputs.currency,
    size: inputs.size,
    weightGrams,
    breakdown,
    exactCashPriceMinorUnits: exactCash.toString(),
    binding,
    cashPrice: Money.fromMinorUnits(cashPriceMinorUnits, inputs.currency).toJSON(),
    creditCardPrice: Money.fromMinorUnits(creditCardPriceMinorUnits, inputs.currency).toJSON(),
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
    return { cashPriceMinorUnits: BigInt(result.cashPrice.amountMinorUnits), result };
  });

  // The band's card price is derived from the band's CASH price, not carried
  // over from the winning size's own card price. They are the same number here,
  // because the derivation is monotonic and the winner is the cash maximum —
  // but taking it from the band cash price states the dependency rather than
  // relying on that coincidence continuing to hold.
  const bandCreditCardPriceMinorUnits = deriveCreditCardPrice(
    selection.bandCashPriceMinorUnits,
    new MoneyDecimal(inputs.profile.creditCardUpliftRate),
    inputs.profile.creditCardPriceRuleId
  );

  return {
    band: inputs.band,
    bandCashPrice: Money.fromMinorUnits(
      selection.bandCashPriceMinorUnits,
      inputs.currency
    ).toJSON(),
    bandCreditCardPrice: Money.fromMinorUnits(
      bandCreditCardPriceMinorUnits,
      inputs.currency
    ).toJSON(),
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
 * THE CASH PRICE IS THE ONLY THING THAT CROSSES IT. The credit-card price is
 * derived afterwards from the whole-minor-unit cash figure and carries its own
 * ceiling (creditCardPrice.ts), so it never passes through here. Keeping the
 * boundary single-purpose is what makes "which number did the floors bind?"
 * answerable: the one this function returned.
 *
 * This is sequencing, not arithmetic: the rounding lives in the rounding
 * registry and the ending in the price-ending registry. The anti-monolith rule
 * for this file still holds.
 */
function finalise(exactCash: MoneyDecimalValue, inputs: BuyNowPricingInputs): bigint {
  const rounded = Money.fromDecimalMinorUnits(
    exactCash,
    inputs.currency,
    inputs.profile.roundingRuleId
  );
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
