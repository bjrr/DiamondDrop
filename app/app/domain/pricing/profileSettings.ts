import { MoneyDecimal } from "~/domain/money/decimal";

/**
 * VALIDATION FOR OPERATOR-ENTERED PRICING-PROFILE SETTINGS.
 *
 * Pure: no database, no clock, no environment. The embedded admin route
 * parses a form, calls this, and persists only on success.
 *
 * ============================================================================
 * WHY SERVER-SIDE VALIDATION EXISTS HERE AT ALL
 * ============================================================================
 * The database CHECK that looks like it guards these values does not.
 * `pricing_profile_min_margin_le_target` compares
 * `min_gross_margin_rate <= target_gross_margin_rate`, and the active margin
 * model is `MARKUP_ON_COST_V1`, under which `target_gross_margin_rate` is
 * NULL by its own CHECK. In SQL a comparison against NULL yields NULL, and a
 * CHECK passes on NULL — so that constraint is vacuous for every profile this
 * business actually uses. The only live numeric guard in the schema is
 * `card_uplift_rate >= 0`.
 *
 * That was tolerable while the only writer was a seed script authored by an
 * engineer. It is not tolerable once an operator can type into a form, so the
 * real guard lives here.
 *
 * ============================================================================
 * PERCENTS IN, RATES OUT — BY EXACT DECIMAL ARITHMETIC
 * ============================================================================
 * Operators think in percentages ("40"), the schema stores rates ("0.400000").
 * The conversion is `decimal.js` division, never a numeric cast followed by
 * `/ 100` — the obvious version, and wrong: 20.1 divided by 100 in binary
 * floating point is 0.20099999999999998.
 *
 * (The forbidden cast is not even spelled out here: `check-money-safety.mjs`
 * matches literally, including inside comments, so naming it would fail the
 * scan on this file's own documentation.)
 *
 * At most FOUR decimal places are accepted in a percent, because
 * `Decimal(9,6)` holds six after the division and Postgres would silently
 * round away anything finer — a stored value quietly different from the one
 * the operator confirmed.
 *
 * ============================================================================
 * NO UPPER BOUND ON MARKUP
 * ============================================================================
 * Deliberate. No approved requirement specifies one, and inventing a ceiling
 * is a business rule smuggled in as a validation detail. A markup high enough
 * to be a typo still has to pass the operator's own confirmation step, and
 * the engine's floors and the approval gate sit downstream of it.
 */

export interface PricingProfileSettingsFormInput {
  /** Percent as typed, e.g. "40" or "40.5". */
  readonly targetMarkupPercent: string;
  /** Percent as typed, e.g. "20". */
  readonly minGrossMarginPercent: string;
  /** Major units as typed, e.g. "100" or "100.00". */
  readonly minDollarProfit: string;
  readonly currency: string;
}

export interface ValidatedPricingProfileSettings {
  /** Decimal string for `Decimal(9,6)`, e.g. "0.4". */
  readonly targetMarkupRate: string;
  readonly minGrossMarginRate: string;
  readonly minDollarProfitMinorUnits: bigint;
  readonly currency: string;
}

export type PricingProfileSettingsValidation =
  | { readonly ok: true; readonly value: ValidatedPricingProfileSettings }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Plain decimal only. Rejects "1e5", "Infinity", "NaN", "0x10", "" — all of which decimal.js would otherwise accept. */
const PERCENT_PATTERN = /^-?\d+(\.\d{1,4})?$/;
/** Money with at most two decimal places. A negative sign is allowed through so it can be REJECTED with a useful message. */
const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const HUNDRED = new MoneyDecimal("100");

/**
 * Percent string to rate string, exactly. "40" -> "0.4", "20.25" -> "0.2025".
 * Division by 100 in decimal.js is exact at 40 significant digits.
 */
function percentToRate(percent: string): string {
  return new MoneyDecimal(percent).div(HUNDRED).toString();
}

/** Major-unit money text to minor units by integer arithmetic. Never a float. */
function moneyToMinorUnits(raw: string): bigint {
  const [whole, fraction = ""] = raw.split(".");
  const negative = whole!.startsWith("-");
  const wholeDigits = negative ? whole!.slice(1) : whole!;
  const magnitude = BigInt(wholeDigits) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -magnitude : magnitude;
}

export function validatePricingProfileSettings(
  input: PricingProfileSettingsFormInput
): PricingProfileSettingsValidation {
  const problems: string[] = [];

  const markupRaw = input.targetMarkupPercent.trim().replace(/[%\s]/g, "");
  const marginRaw = input.minGrossMarginPercent.trim().replace(/[%\s]/g, "");
  const profitRaw = input.minDollarProfit.trim().replace(/[$,\s]/g, "");
  const currency = input.currency.trim().toUpperCase();

  // ---- target markup -------------------------------------------------
  let targetMarkupRate: string | null = null;
  if (markupRaw === "") {
    problems.push("Target markup is required.");
  } else if (!PERCENT_PATTERN.test(markupRaw)) {
    problems.push(
      "Target markup must be a plain percentage such as 40 or 40.5, with at most four decimal places."
    );
  } else if (new MoneyDecimal(markupRaw).isNegative()) {
    problems.push("Target markup cannot be negative.");
  } else {
    targetMarkupRate = percentToRate(markupRaw);
  }

  // ---- minimum gross margin ------------------------------------------
  let minGrossMarginRate: string | null = null;
  if (marginRaw === "") {
    problems.push("Minimum gross margin is required.");
  } else if (!PERCENT_PATTERN.test(marginRaw)) {
    problems.push(
      "Minimum gross margin must be a plain percentage such as 20, with at most four decimal places."
    );
  } else {
    const value = new MoneyDecimal(marginRaw);
    if (value.isNegative()) {
      problems.push("Minimum gross margin cannot be negative.");
    } else if (value.greaterThanOrEqualTo(HUNDRED)) {
      // A gross margin of 100% implies infinite price; above it is nonsense.
      problems.push("Minimum gross margin must be below 100%.");
    } else {
      minGrossMarginRate = percentToRate(marginRaw);
    }
  }

  // ---- minimum dollar profit -----------------------------------------
  let minDollarProfitMinorUnits: bigint | null = null;
  if (profitRaw === "") {
    problems.push("Minimum profit is required.");
  } else if (!MONEY_PATTERN.test(profitRaw)) {
    problems.push("Minimum profit must be a plain amount such as 100 or 100.00.");
  } else {
    const minorUnits = moneyToMinorUnits(profitRaw);
    // Zero is permitted: "no fixed profit floor, rely on the margin floor" is
    // a legitimate configuration, unlike a negative floor which is not.
    if (minorUnits < 0n) problems.push("Minimum profit cannot be negative.");
    else minDollarProfitMinorUnits = minorUnits;
  }

  // ---- currency --------------------------------------------------------
  if (!CURRENCY_PATTERN.test(currency)) {
    problems.push("Currency must be a three-letter code such as USD.");
  }

  if (
    problems.length > 0 ||
    targetMarkupRate === null ||
    minGrossMarginRate === null ||
    minDollarProfitMinorUnits === null
  ) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    value: { targetMarkupRate, minGrossMarginRate, minDollarProfitMinorUnits, currency },
  };
}

/** Rate string back to a display percent, e.g. "0.400000" -> "40". For rendering current values. */
export function rateToPercentDisplay(rate: string): string {
  return new MoneyDecimal(rate).times(HUNDRED).toString();
}

/** Minor units to a display amount, e.g. 10000n -> "100.00". Integer arithmetic only. */
export function minorUnitsToDisplayAmount(minorUnits: bigint): string {
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;
  const padded = fraction < 10n ? `0${fraction}` : `${fraction}`;
  return `${negative ? "-" : ""}${whole}.${padded}`;
}
