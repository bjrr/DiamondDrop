import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";

import { enumerateBandSizes, selectBandPrice } from "./bands";
import { calculateLandedCost, partitionRevenueSide } from "./cost";
import { PricingCurrencyMismatchError } from "./errors";
import { deriveRegularCardPrice } from "./regularCardPrice";
import { applyPriceEnding, getPriceEndingRule } from "./priceEnding";
import { enforceFloors, solveExactBankPaymentPrice } from "./solve";
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
 * Cost, markup, rounding, price ending and every floor run on the BANK PAYMENT
 * PRICE and finish completely. Only then is the Regular/Card Price derived from
 * that settled figure. Nothing downstream of the derivation feeds back, so the
 * card uplift cannot reach a cost, a markup, a margin floor or a profit floor —
 * and the Bank Payment Price the customer is quoted is the same number every
 * floor was tested against.
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
  const { exactBankPayment, binding } = solveExactBankPaymentPrice({
    profile: inputs.profile,
    landedCostMinorUnits: landedCost,
    revenueRate: revenueSide.rate,
    revenueFixedMinorUnits: revenueSide.fixedMinorUnits,
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  });

  const endedBankPayment = finalise(exactBankPayment, inputs);

  // NO REVENUE-SIDE FIGURES REACH THE FLOORS. `revenueSide` is resolved above
  // for the margin model alone; `FloorInput` has no field for it, so payment
  // processing cannot be deducted from the margin or the minimum profit. That
  // is the owner's rule, and the shape of the type is what keeps it.
  const floorInput = {
    bankPaymentPriceMinorUnits: endedBankPayment,
    landedCostMinorUnits: landedCost,
    minGrossMarginRate: new MoneyDecimal(inputs.profile.minGrossMarginRate),
    minDollarProfitMinorUnits: new MoneyDecimal(inputs.profile.minDollarProfit.amountMinorUnits),
    variantFloorMinorUnits: new MoneyDecimal(inputs.variantFloor?.amountMinorUnits ?? "0"),
  };
  // The floor loop steps by the price-ending granularity, so a whole-dollar
  // price stays a whole dollar even when a floor forces it upward.
  const { bankPaymentPriceMinorUnits, bumps, final } = enforceFloors(
    floorInput,
    100,
    getPriceEndingRule(inputs.profile.priceEndingRuleId).stepMinorUnits
  );

  // THE LAST THING THAT HAPPENS. The Regular/Card Price is derived from the
  // FINAL Bank Payment Price — after rounding, price ending and every floor
  // bump — not from the exact solve. Deriving it from the exact value would let
  // the two disagree: a bank price nudged up a dollar to clear a floor would
  // keep a card price computed from the pre-bump figure, and the pair shown to
  // the customer would not be consistent with each other.
  //
  // THE BANK PAYMENT PRICE IS NOT TOUCHED HERE. The rule returns it unchanged
  // and that value is what goes into the result. Policy §2 makes this a rule
  // rather than an implementation detail, because every floor, freeze and
  // refund in the system is already pinned to that exact number.
  //
  // The rule owns its own rounding — a $5 ceiling, which is coarser than the
  // whole-dollar price ending applied to the bank price. Reusing the
  // price-ending rule would put the card price below the tier the policy asked
  // for on most items. See regularCardPrice.ts.
  //
  // No floor evaluation for the card price: it is at or above the bank price,
  // which has already satisfied every floor. Evaluating the floors against it
  // would also be WRONG — it would report a margin inflated by the uplift,
  // which is not margin the business earns.
  const card = deriveRegularCardPrice(
    bankPaymentPriceMinorUnits,
    new MoneyDecimal(inputs.profile.fixedCardUpliftRate),
    inputs.profile.regularCardPriceRuleId
  );

  return {
    engineVersion: PRICING_ENGINE_VERSION,
    currency: inputs.currency,
    size: inputs.size,
    weightGrams,
    breakdown,
    exactBankPaymentPriceMinorUnits: exactBankPayment.toString(),
    binding,
    // Read back from the RULE, not from the local variable, so that a rule
    // which altered the bank price would be caught by the tests asserting these
    // two are identical — rather than hidden by the engine quietly re-sending
    // its own copy.
    bankPaymentPrice: Money.fromMinorUnits(
      card.bankPaymentPriceMinorUnits,
      inputs.currency
    ).toJSON(),
    regularCardPrice: Money.fromMinorUnits(
      card.regularCardPriceMinorUnits,
      inputs.currency
    ).toJSON(),
    bankPaymentSavings: Money.fromMinorUnits(
      card.bankPaymentSavingsMinorUnits,
      inputs.currency
    ).toJSON(),
    regularCardPriceRuleId: inputs.profile.regularCardPriceRuleId,
    appliedCardUpliftRate: card.appliedUpliftRate,
    appliedCardUpliftTierLabel: card.appliedTierLabel,
    fixedCardUpliftRate: inputs.profile.fixedCardUpliftRate,
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
    return { bankPaymentPriceMinorUnits: BigInt(result.bankPaymentPrice.amountMinorUnits), result };
  });

  // The band's card price is derived from the BAND's bank payment price, not
  // carried over from the winning size's own card price.
  //
  // Under the $5 ceiling that is no longer a distinction without a difference.
  // Two sizes whose bank prices straddle a tier boundary can produce card prices
  // that do not order the same way as their bank prices, so "the winner's card
  // price" and "the card price of the winning bank price" are genuinely
  // separate quantities. The policy says the card price is derived from the
  // Bank Payment Price, so that is what this does.
  const bandCard = deriveRegularCardPrice(
    selection.bandBankPaymentPriceMinorUnits,
    new MoneyDecimal(inputs.profile.fixedCardUpliftRate),
    inputs.profile.regularCardPriceRuleId
  );

  return {
    band: inputs.band,
    bandBankPaymentPrice: Money.fromMinorUnits(
      selection.bandBankPaymentPriceMinorUnits,
      inputs.currency
    ).toJSON(),
    bandRegularCardPrice: Money.fromMinorUnits(
      bandCard.regularCardPriceMinorUnits,
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
 * THE BANK PAYMENT PRICE IS THE ONLY THING THAT CROSSES IT. The Regular/Card
 * Price is derived afterwards from the whole-minor-unit bank figure and carries
 * its own $5 ceiling, so it never passes through here. Keeping the
 * boundary single-purpose is what makes "which number did the floors bind?"
 * answerable: the one this function returned.
 *
 * This is sequencing, not arithmetic: the rounding lives in the rounding
 * registry and the ending in the price-ending registry. The anti-monolith rule
 * for this file still holds.
 */
function finalise(exactBankPayment: MoneyDecimalValue, inputs: BuyNowPricingInputs): bigint {
  const rounded = Money.fromDecimalMinorUnits(
    exactBankPayment,
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
