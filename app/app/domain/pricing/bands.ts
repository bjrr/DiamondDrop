import { MoneyDecimal } from "~/domain/money/decimal";

import { InvalidBandError } from "./errors";
import type { BandSpec, DecimalString, SizeSpec } from "./types";

/**
 * L5 — ring-size bands (spec §5.7). Pure.
 *
 * THE RULE THAT MATTERS: a band's price is the maximum across EVERY allowed
 * size in the band, never a shortcut to `band.sizeMax`. An exact
 * finished-weight override (R8) can make an interior size the most expensive
 * one, and the shortcut would then sell that size below floor — on one product,
 * silently. The seeded fixture has exactly this case at size 7.50.
 *
 * `selectBandPrice` takes the per-size evaluation as an INJECTED function, so
 * this module never imports the engine and the max/tie logic is testable
 * against a three-line stub.
 */

/** Bands must cover the size range without gaps or overlaps (§5.7). */
export function validateBandCoverage(bands: readonly BandSpec[], spec: SizeSpec): void {
  if (bands.length === 0) {
    throw new InvalidBandError("(none)", "at least one band is required for a sized product");
  }

  const sorted = [...bands].sort((a, b) =>
    new MoneyDecimal(a.sizeMin).comparedTo(new MoneyDecimal(b.sizeMin))
  );

  for (const band of sorted) {
    if (new MoneyDecimal(band.sizeMin).greaterThan(new MoneyDecimal(band.sizeMax))) {
      throw new InvalidBandError(band.label, `sizeMin ${band.sizeMin} exceeds sizeMax ${band.sizeMax}`);
    }
  }

  const min = new MoneyDecimal(spec.allowedSizeMin);
  const max = new MoneyDecimal(spec.allowedSizeMax);

  if (!new MoneyDecimal(sorted[0]!.sizeMin).equals(min)) {
    throw new InvalidBandError(sorted[0]!.label, `first band must start at ${spec.allowedSizeMin}`);
  }
  const last = sorted[sorted.length - 1]!;
  if (!new MoneyDecimal(last.sizeMax).equals(max)) {
    throw new InvalidBandError(last.label, `last band must end at ${spec.allowedSizeMax}`);
  }

  const increment = new MoneyDecimal(spec.sizeIncrement);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    const expected = new MoneyDecimal(previous.sizeMax).plus(increment);
    if (!new MoneyDecimal(current.sizeMin).equals(expected)) {
      throw new InvalidBandError(
        current.label,
        `must start at ${expected.toString()} to meet "${previous.label}" without a gap or overlap`
      );
    }
  }
}

/** Every allowed size falling inside a band, on the increment grid (§5.7). */
export function enumerateBandSizes(band: BandSpec, spec: SizeSpec): DecimalString[] {
  const increment = new MoneyDecimal(spec.sizeIncrement);
  if (increment.lessThanOrEqualTo(0)) {
    throw new InvalidBandError(band.label, `size increment ${spec.sizeIncrement} must be positive`);
  }

  const max = new MoneyDecimal(band.sizeMax);
  const sizes: DecimalString[] = [];
  for (let s = new MoneyDecimal(band.sizeMin); s.lessThanOrEqualTo(max); s = s.plus(increment)) {
    sizes.push(s.toString());
  }

  if (sizes.length === 0) {
    throw new InvalidBandError(band.label, "contains no allowed sizes");
  }
  return sizes;
}

export interface BandPriceSelection<TResult> {
  bandPrice: bigint;
  costBasisSize: DecimalString;
  perSize: readonly { size: DecimalString; priceMinorUnits: string }[];
  winning: TResult;
}

/**
 * Evaluates every candidate size and returns the most expensive.
 *
 * A tie resolves to the SMALLEST size, deterministically — not to whichever
 * happened to be evaluated first. Two sizes costing the same is ordinary
 * (unsized products, flat overrides), so a tie must not be an error, but it
 * must also not be order-dependent, or `cost_basis_size` evidence would vary
 * between identical runs.
 */
export function selectBandPrice<TResult>(
  candidates: readonly DecimalString[],
  priceAtSize: (size: DecimalString) => { priceMinorUnits: bigint; result: TResult }
): BandPriceSelection<TResult> {
  if (candidates.length === 0) {
    throw new InvalidBandError("(unknown)", "no candidate sizes to evaluate");
  }

  const perSize: { size: DecimalString; priceMinorUnits: string }[] = [];
  let bestPrice: bigint | null = null;
  let bestSize: DecimalString | null = null;
  let bestResult: TResult | null = null;

  for (const size of candidates) {
    const { priceMinorUnits, result } = priceAtSize(size);
    perSize.push({ size, priceMinorUnits: priceMinorUnits.toString() });

    if (bestPrice === null || priceMinorUnits > bestPrice) {
      bestPrice = priceMinorUnits;
      bestSize = size;
      bestResult = result;
    }
    // Strictly greater-than above means an equal price keeps the earlier
    // (smaller) size, which is the deterministic tie rule.
  }

  return {
    bandPrice: bestPrice!,
    costBasisSize: bestSize!,
    perSize,
    winning: bestResult!,
  };
}
