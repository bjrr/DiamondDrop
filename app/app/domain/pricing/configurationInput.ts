import { MoneyDecimal } from "~/domain/money/decimal";

/**
 * RUNTIME VALIDATION FOR OPERATOR-SUBMITTED PRICING CONFIGURATION.
 *
 * ============================================================================
 * WHY THIS EXISTS: A CAST IS NOT A CHECK
 * ============================================================================
 * The first version of the pricing-settings route passed form values straight
 * into Prisma through `as never`. That satisfies the compiler and validates
 * nothing: `as never` is erased at build time, so a crafted POST carrying
 * `metal=unobtanium` reached the database layer unexamined.
 *
 * Prisma did reject the unknown enum, so no bad row could be stored — but the
 * operator got an opaque 500 instead of "that is not a metal", and relying on
 * a downstream library to be the input boundary is exactly the posture that
 * fails the moment a column is more forgiving than expected. Which one was:
 *
 * **`currency` is `char(3)`, and Postgres BLANK-PADS a short value.** The
 * route defaulted `currency` to "USD" but never validated it, so a POST with
 * `currency=US` would be stored as `"US "` — silently, with no error at any
 * layer. That is data corruption rather than a rejected request, and it is
 * the finding that made this module necessary rather than merely tidy.
 *
 * ============================================================================
 * ENUM LISTS ARE NEVER RETYPED HERE
 * ============================================================================
 * Every enum check reads the Prisma-generated runtime object, which is the
 * same definition the schema and the database share. A hand-copied list in
 * this file would be a third definition, and the one nobody updates when the
 * schema changes.
 */

export class PricingConfigurationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingConfigurationInputError";
  }
}

/** Plain non-negative decimal. Rejects "1e5", "Infinity", "NaN", "0x10", "-1", "". */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
/** Plain non-negative money with at most two decimal places. */
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Validates a submitted value against a Prisma enum object.
 *
 * `enumObject` is Prisma's generated runtime map (e.g. `Metal`), so the set of
 * accepted values is always exactly the schema's.
 */
export function parseEnumValue<T extends Record<string, string>>(
  enumObject: T,
  raw: string,
  label: string
): T[keyof T] {
  const value = raw.trim();
  const permitted = Object.values(enumObject);
  if (!permitted.includes(value)) {
    throw new PricingConfigurationInputError(
      `${label} must be one of: ${permitted.join(", ")}.`
    );
  }
  return value as T[keyof T];
}

/**
 * Three upper-case letters, always.
 *
 * Not cosmetic: the column is `char(3)` and Postgres pads a shorter value
 * rather than rejecting it, so "US" would be stored as "US " and would then
 * never match "USD" in any comparison.
 */
export function parseCurrency(raw: string, label = "Currency"): string {
  const value = raw.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(value)) {
    throw new PricingConfigurationInputError(`${label} must be a three-letter code such as USD.`);
  }
  return value;
}

/** Strictly greater than zero. For inputs where zero is not a real-world value. */
export function parsePositiveDecimal(raw: string, label: string): string {
  const value = raw.trim().replace(/[$,\s]/g, "");
  if (!DECIMAL_PATTERN.test(value)) {
    throw new PricingConfigurationInputError(`${label} must be a plain decimal such as 82.70.`);
  }
  if (new MoneyDecimal(value).isZero()) {
    throw new PricingConfigurationInputError(`${label} must be greater than zero.`);
  }
  return value;
}

/** Zero or more. For inputs where zero is a legitimate configuration. */
export function parseNonNegativeDecimal(raw: string, label: string): string {
  const value = raw.trim().replace(/[$,\s]/g, "");
  if (!DECIMAL_PATTERN.test(value)) {
    throw new PricingConfigurationInputError(`${label} must be a plain decimal such as 5.25.`);
  }
  return value;
}

/** Money text to minor units by integer arithmetic. Never a float. */
export function parseMoneyMinorUnits(
  raw: string,
  label: string,
  options: { allowZero: boolean }
): bigint {
  const value = raw.trim().replace(/[$,\s]/g, "");
  if (!MONEY_PATTERN.test(value)) {
    throw new PricingConfigurationInputError(`${label} must be a plain amount such as 420 or 420.00.`);
  }
  const [whole, fraction = ""] = value.split(".");
  const minorUnits = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (!options.allowZero && minorUnits === 0n) {
    throw new PricingConfigurationInputError(`${label} must be greater than zero.`);
  }
  return minorUnits;
}

/**
 * A rate expressed as a decimal fraction, e.g. "0.029" for 2.9%.
 *
 * Bounded at 6 decimal places because the column is `Decimal(9,6)` and
 * Postgres would otherwise round away the excess, storing something other
 * than what the operator confirmed.
 */
export function parseRate(raw: string, label: string): string {
  const value = raw.trim().replace(/[%\s]/g, "");
  if (!DECIMAL_PATTERN.test(value)) {
    throw new PricingConfigurationInputError(
      `${label} must be a plain decimal fraction such as 0.029 for 2.9%.`
    );
  }
  const decimals = value.split(".")[1]?.length ?? 0;
  if (decimals > 6) {
    throw new PricingConfigurationInputError(`${label} supports at most six decimal places.`);
  }
  return value;
}

/** Half-open band [min, max). Minimum may be zero; maximum must exceed it. */
export function parseCaratBand(rawMin: string, rawMax: string): { caratMin: string; caratMax: string } {
  const caratMin = rawMin.trim();
  const caratMax = rawMax.trim();
  if (!DECIMAL_PATTERN.test(caratMin)) {
    throw new PricingConfigurationInputError("Carat minimum must be a plain decimal such as 0.9.");
  }
  if (!DECIMAL_PATTERN.test(caratMax)) {
    throw new PricingConfigurationInputError("Carat maximum must be a plain decimal such as 1.1.");
  }
  // Compared as exact decimals; `parseFloat` is banned repo-wide and carats
  // deserve the same discipline as money.
  if (!new MoneyDecimal(caratMin).lessThan(new MoneyDecimal(caratMax))) {
    throw new PricingConfigurationInputError(
      "Carat minimum must be strictly less than carat maximum — the band is [min, max)."
    );
  }
  return { caratMin, caratMax };
}
