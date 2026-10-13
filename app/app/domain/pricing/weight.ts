import { MoneyDecimal } from "~/domain/money/decimal";

import { InvalidSizeError, InvalidWeightError } from "./errors";
import type { DecimalString, SizeSpec, WeightSpec } from "./types";

/**
 * L3 — weight (spec §5.1). Pure: no I/O, no clock, no repository.
 *
 * All size arithmetic is MoneyDecimal, never a JS number. A ring size is a
 * decimal quantity and `6.5 - 6` in binary float is not exactly `0.5`.
 */

/**
 * §5.1 rule 4. Validated BEFORE any override is applied, so an override at an
 * out-of-range size is rejected rather than silently honoured.
 */
export function validateSize(spec: SizeSpec, size: DecimalString): void {
  if (spec.sizeAxis === "none") return;

  const s = new MoneyDecimal(size);
  const min = new MoneyDecimal(spec.allowedSizeMin);
  const max = new MoneyDecimal(spec.allowedSizeMax);

  if (s.lessThan(min) || s.greaterThan(max)) {
    throw new InvalidSizeError(size, `outside allowed range [${spec.allowedSizeMin}, ${spec.allowedSizeMax}]`);
  }

  const increment = new MoneyDecimal(spec.sizeIncrement);
  if (increment.lessThanOrEqualTo(0)) {
    throw new InvalidSizeError(size, `size increment ${spec.sizeIncrement} must be positive`);
  }

  // Must sit on the increment grid measured from allowedSizeMin.
  const steps = s.minus(min).dividedBy(increment);
  if (!steps.isInteger()) {
    throw new InvalidSizeError(
      size,
      `not a multiple of increment ${spec.sizeIncrement} offset from ${spec.allowedSizeMin}`
    );
  }
}

/**
 * §5.1 rules 1-3 and 5, applied in exactly this order.
 *
 * An exact finished-weight override wins unconditionally (R8) — it is a
 * measured fact about a real manufactured piece, which beats a linear model.
 * The delta may be negative when size < baseSize; that is legitimate.
 */
export function calculateWeightGrams(spec: WeightSpec, size: DecimalString): DecimalString {
  validateSize(spec, size);

  const override = spec.overrides?.[size];
  const weight =
    override !== undefined
      ? new MoneyDecimal(override)
      : spec.sizeAxis === "none"
        ? new MoneyDecimal(spec.baseWeightGrams)
        : new MoneyDecimal(spec.baseWeightGrams).plus(
            new MoneyDecimal(size).minus(spec.baseSize).times(spec.weightPerFullSizeGrams)
          );

  if (weight.lessThanOrEqualTo(0)) {
    throw new InvalidWeightError(weight.toString(), size);
  }

  return weight.toString();
}

/** Every allowed size from min to max on the increment grid (§5.7). */
export function enumerateAllowedSizes(spec: SizeSpec): DecimalString[] {
  if (spec.sizeAxis === "none") return [];

  const increment = new MoneyDecimal(spec.sizeIncrement);
  if (increment.lessThanOrEqualTo(0)) {
    throw new InvalidSizeError(spec.sizeIncrement, "size increment must be positive");
  }

  const max = new MoneyDecimal(spec.allowedSizeMax);
  const sizes: DecimalString[] = [];
  for (let s = new MoneyDecimal(spec.allowedSizeMin); s.lessThanOrEqualTo(max); s = s.plus(increment)) {
    sizes.push(s.toString());
  }
  return sizes;
}
