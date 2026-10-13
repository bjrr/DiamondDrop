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
      storedBankPaymentPriceMinorUnits: string;
      recomputedBankPaymentPriceMinorUnits: string;
      differences: readonly string[];
    }
  | {
      status: "engine_version_changed";
      calculationId: string;
      storedEngineVersion: string;
      currentEngineVersion: string;
      storedBankPaymentPriceMinorUnits: string;
      recomputedBankPaymentPriceMinorUnits: string;
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
    result: { bankPaymentPrice: { amountMinorUnits: string } };
  };

  const storedBankPaymentPrice = calculation.bankPaymentPriceMinorUnits.toString();

  // THE VERSION IS CHECKED BEFORE THE RECOMPUTE, and the recompute is allowed
  // to fail.
  //
  // A snapshot from an older engine version may carry INPUTS the current engine
  // cannot even parse — the 2026-09-18 rename means a V1 payload's profile has
  // `creditCardPriceRuleId` where the engine now reads `regularCardPriceRuleId`,
  // so recomputing it throws rather than returning a different number.
  //
  // Recomputing first therefore made this function throw on precisely the rows
  // the version field exists to explain: an operator auditing a pre-rename
  // price got a stack trace instead of "the engine has moved on". The audit
  // path must never be the thing that breaks when the engine changes.
  if (payload.engineVersion !== PRICING_ENGINE_VERSION) {
    return {
      status: "engine_version_changed",
      calculationId,
      storedEngineVersion: payload.engineVersion,
      currentEngineVersion: PRICING_ENGINE_VERSION,
      storedBankPaymentPriceMinorUnits: storedBankPaymentPrice,
      // Best effort. A cross-version recompute is informational either way, so
      // a failure to produce one is reported as "not recomputable" rather than
      // allowed to abort the whole verification.
      recomputedBankPaymentPriceMinorUnits: tryRecomputeBankPaymentPrice(payload.inputs),
      note:
        "The engine version has moved on since this calculation was stored. The " +
        "prices above are reported for comparison and are NOT asserted equal: a " +
        "difference here is expected when the formula has changed, and is not " +
        "evidence that the stored calculation was wrong at the time.",
    };
  }

  const recomputed = computeBuyNowPrice(payload.inputs);
  const recomputedBankPaymentPrice = recomputed.bankPaymentPrice.amountMinorUnits;

  const storedResultJson = canonicalJsonStringify(payload.result as never);
  const recomputedResultJson = canonicalJsonStringify(recomputed as never);

  if (storedResultJson === recomputedResultJson) {
    return { status: "reproduced", calculationId, engineVersion: payload.engineVersion };
  }

  return {
    status: "diverged",
    calculationId,
    engineVersion: payload.engineVersion,
    storedBankPaymentPriceMinorUnits: storedBankPaymentPrice,
    recomputedBankPaymentPriceMinorUnits: recomputedBankPaymentPrice,
    differences: [
      storedBankPaymentPrice === recomputedBankPaymentPrice
        ? "bank payment price matches but the full result differs — compare the breakdown"
        : `bank payment price differs: stored ${storedBankPaymentPrice}, recomputed ${recomputedBankPaymentPrice}`,
    ],
  };
}

/**
 * A cross-version recompute, which is allowed to fail.
 *
 * Only ever called when the stored engine version differs from the current one,
 * where the recomputed figure is informational — the caller has already been
 * told the two are not comparable. Returning a marker rather than throwing is
 * what keeps `verifyPriceCalculation` answerable for every stored row,
 * including ones whose inputs the current engine can no longer parse.
 *
 * Deliberately NOT a general-purpose swallow: on the same-version path the
 * recompute is load-bearing and any exception there must surface.
 */
function tryRecomputeBankPaymentPrice(inputs: BuyNowPricingInputs): string {
  try {
    return computeBuyNowPrice(inputs).bankPaymentPrice.amountMinorUnits;
  } catch {
    return "(not recomputable under the current engine)";
  }
}
