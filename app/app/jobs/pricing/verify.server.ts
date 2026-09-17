import { getPriceCalculationById } from "~/db/repositories/priceCalculationRepository.server";
import { canonicalJsonStringify } from "~/domain/evidence/canonicalJson";
import { computeBuyNowPrice } from "~/domain/pricing/engine";
import type { BuyNowPricingInputs } from "~/domain/pricing/types";
import { PRICING_ENGINE_VERSION } from "~/domain/pricing/version";

/**
 * The reproducibility check (spec §5.6, criterion 19) — the auditability
 * deliverable of R6/R15.
 *
 * The contract has two halves, and the second is the one that is easy to get
 * wrong: when the stored calculation was produced by a DIFFERENT engine
 * version, reproduction must report the DIFFERENCE rather than assert
 * equality. Asserting equality across versions would either fail every
 * historical calculation after any formula change, or — worse, if someone
 * "fixed" that by loosening the check — quietly claim old prices still
 * reproduce when they no longer do.
 */

export type VerifyOutcome =
  | { status: "reproduced"; calculationId: string; engineVersion: string }
  | {
      status: "diverged";
      calculationId: string;
      engineVersion: string;
      storedPriceMinorUnits: string;
      recomputedPriceMinorUnits: string;
      differences: readonly string[];
    }
  | {
      status: "engine_version_changed";
      calculationId: string;
      storedEngineVersion: string;
      currentEngineVersion: string;
      storedPriceMinorUnits: string;
      recomputedPriceMinorUnits: string;
      note: string;
    }
  | { status: "not_found"; calculationId: string };

export async function verifyPriceCalculation(calculationId: string): Promise<VerifyOutcome> {
  const calculation = await getPriceCalculationById(calculationId);
  if (!calculation || !calculation.snapshot) {
    return { status: "not_found", calculationId };
  }

  const payload = calculation.snapshot.payload as unknown as {
    engineVersion: string;
    inputs: BuyNowPricingInputs;
    result: { price: { amountMinorUnits: string } };
  };

  const recomputed = computeBuyNowPrice(payload.inputs);
  const storedPrice = calculation.computedPriceMinorUnits.toString();
  const recomputedPrice = recomputed.price.amountMinorUnits;

  if (payload.engineVersion !== PRICING_ENGINE_VERSION) {
    return {
      status: "engine_version_changed",
      calculationId,
      storedEngineVersion: payload.engineVersion,
      currentEngineVersion: PRICING_ENGINE_VERSION,
      storedPriceMinorUnits: storedPrice,
      recomputedPriceMinorUnits: recomputedPrice,
      note:
        "The engine version has moved on since this calculation was stored. The " +
        "prices above are reported for comparison and are NOT asserted equal: a " +
        "difference here is expected when the formula has changed, and is not " +
        "evidence that the stored calculation was wrong at the time.",
    };
  }

  const storedResultJson = canonicalJsonStringify(payload.result as never);
  const recomputedResultJson = canonicalJsonStringify(recomputed as never);

  if (storedResultJson === recomputedResultJson) {
    return { status: "reproduced", calculationId, engineVersion: payload.engineVersion };
  }

  return {
    status: "diverged",
    calculationId,
    engineVersion: payload.engineVersion,
    storedPriceMinorUnits: storedPrice,
    recomputedPriceMinorUnits: recomputedPrice,
    differences: [
      storedPrice === recomputedPrice
        ? "price matches but the full result differs — compare the breakdown"
        : `price differs: stored ${storedPrice}, recomputed ${recomputedPrice}`,
    ],
  };
}
