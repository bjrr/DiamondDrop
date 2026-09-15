import Decimal from "decimal.js";

/**
 * Dedicated Decimal constructor clone for money-adjacent math (spec §0.4).
 *
 * Using `Decimal.clone(...)` instead of mutating the global `Decimal`
 * config means money math never inherits, and never leaks into, decimal.js
 * configuration used elsewhere in the codebase.
 *
 * Precision is fixed and documented at 40 significant digits — far beyond
 * any real metal-price-per-gram × grams, percentage, or allocation
 * calculation this system performs, so internal decimal.js rounding never
 * becomes a hidden source of error. All money-affecting rounding happens
 * explicitly, at the named boundary in rounding.ts — never here.
 */
export const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export type MoneyDecimalValue = InstanceType<typeof MoneyDecimal>;
