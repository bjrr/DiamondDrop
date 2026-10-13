/**
 * Named pricing errors (spec §5). Every one of these is a refusal to produce
 * a price, never a fallback to a default — a wrong price that looks plausible
 * is worse than no price, because it reaches a customer.
 */

/** Size is outside the allowed range, or off the configured increment (§5.1 rule 4). */
export class InvalidSizeError extends Error {
  constructor(readonly size: string, detail: string) {
    super(`Invalid size ${size}: ${detail}`);
    this.name = "InvalidSizeError";
  }
}

/** Computed or overridden weight is <= 0 — a data error, never a free product (§5.1 rule 5). */
export class InvalidWeightError extends Error {
  constructor(readonly weightGrams: string, readonly size: string) {
    super(
      `Computed weight ${weightGrams} g at size ${size} is not positive. ` +
        "A non-positive weight is a data error, not a zero-cost product."
    );
    this.name = "InvalidWeightError";
  }
}

/** A band is empty or its bounds are inconsistent with the size axis (§5.7). */
export class InvalidBandError extends Error {
  constructor(readonly label: string, detail: string) {
    super(`Invalid ring size band "${label}": ${detail}`);
    this.name = "InvalidBandError";
  }
}

/**
 * `1 − m − r` (or `1 − r`) is <= 0, so no finite price achieves the objective
 * (§5.3). Means the configured margin plus revenue-side rates consume the whole
 * selling price. A configuration error, surfaced rather than approximated.
 */
export class UnreachableMarginError extends Error {
  constructor(readonly denominator: string, detail: string) {
    super(`Cannot solve for price: denominator ${denominator} is not positive (${detail}).`);
    this.name = "UnreachableMarginError";
  }
}

/** The post-rounding floor loop did not converge within its bound (§5.5). */
export class MarginFloorUnreachableError extends Error {
  constructor(readonly iterations: number, readonly lastPriceMinorUnits: string, detail: string) {
    super(
      `Floors still unsatisfied after ${iterations} one-minor-unit increments ` +
        `(last price ${lastPriceMinorUnits}): ${detail}`
    );
    this.name = "MarginFloorUnreachableError";
  }
}

/** A currency mismatch between inputs that must share one currency. */
export class PricingCurrencyMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string, readonly where: string) {
    super(`Currency mismatch in ${where}: expected ${expected}, got ${actual}.`);
    this.name = "PricingCurrencyMismatchError";
  }
}
