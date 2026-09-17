import { MoneyDecimal, type MoneyDecimalValue } from "./decimal";
import { CurrencyMismatchError, InvalidAllocationError, InvalidMoneyAmountError } from "./errors";
import { getRoundingRule, type RoundingRuleId } from "./rounding";

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export interface MoneyJSON {
  amountMinorUnits: string;
  currency: string;
}

function assertValidCurrency(currency: string): void {
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new InvalidMoneyAmountError(
      `Invalid currency code: "${currency}". Expected a 3-letter ISO 4217 code (e.g. "USD").`
    );
  }
}

/**
 * Money as integer minor units (e.g. cents) + currency (spec §0.4).
 *
 * All arithmetic on `amountMinorUnits` is bigint-exact. TypeScript refuses
 * to mix `bigint` and `number` with arithmetic operators, so accidental
 * float arithmetic on a money amount is a compile-time error, not a
 * runtime bug — that type boundary is itself part of this module's safety
 * design, not just documentation of it.
 *
 * The only sanctioned entry points from decimal.js-based cost math into
 * Money are `fromDecimalMinorUnits` / `fromDecimalMajorUnits` (or
 * `multiplyByDecimal` / `divideByInteger` on an existing Money), and all
 * four require an explicit, named rounding rule — there is no overload
 * that omits one.
 */
export class Money {
  readonly amountMinorUnits: bigint;
  readonly currency: string;

  private constructor(amountMinorUnits: bigint, currency: string) {
    this.amountMinorUnits = amountMinorUnits;
    this.currency = currency;
  }

  static fromMinorUnits(amountMinorUnits: bigint, currency: string): Money {
    assertValidCurrency(currency);
    return new Money(amountMinorUnits, currency);
  }

  static zero(currency: string): Money {
    assertValidCurrency(currency);
    return new Money(0n, currency);
  }

  /**
   * Converts a Decimal (or numeric string) amount already expressed in
   * MINOR units (e.g. cents — fractional minor units are permitted, such
   * as an intermediate margin-solve result) into a Money, rounding under
   * the given, explicitly named rounding rule.
   *
   * This is the pricing engine's single rounding boundary (spec §5.4):
   * every other money-shaped value produced during a calculation is an
   * unrounded `MoneyDecimal` until it reaches this method exactly once,
   * at the final price. `roundingRuleId` is required, not defaulted — an
   * implicit rounding rule is exactly what the versioned registry in
   * `rounding.ts` exists to prevent.
   *
   * `fromDecimalMajorUnits` below is expressed in terms of this method so
   * there is exactly one rounding code path, not two.
   */
  static fromDecimalMinorUnits(
    value: MoneyDecimalValue | string,
    currency: string,
    roundingRuleId: RoundingRuleId
  ): Money {
    assertValidCurrency(currency);
    const rule = getRoundingRule(roundingRuleId);
    return new Money(rule.round(new MoneyDecimal(value)), currency);
  }

  /**
   * Converts a Decimal (or numeric string) MAJOR-unit amount (e.g. dollars,
   * not cents) into a Money, applying the named rounding rule at this
   * explicit boundary. Re-expressed in terms of `fromDecimalMinorUnits`:
   * scaling to minor units is exact (multiplication by an integer power of
   * ten), so routing through the minor-unit boundary preserves this
   * method's behavior exactly while keeping rounding centralized in one
   * place.
   */
  static fromDecimalMajorUnits(
    value: MoneyDecimalValue | string,
    currency: string,
    roundingRuleId: RoundingRuleId,
    minorUnitsPerMajorUnit = 100
  ): Money {
    const decimalMinorUnits = new MoneyDecimal(value).times(minorUnitsPerMajorUnit);
    return Money.fromDecimalMinorUnits(decimalMinorUnits, currency, roundingRuleId);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinorUnits + other.amountMinorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinorUnits - other.amountMinorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.amountMinorUnits, this.currency);
  }

  /** Exact integer scaling. No rounding rule is needed because the result is always exact. */
  multiplyByInteger(factor: bigint): Money {
    return new Money(this.amountMinorUnits * factor, this.currency);
  }

  /**
   * Scales by a decimal factor (e.g. a margin percentage), rounding at the
   * named boundary. There is no overload that omits `roundingRuleId`.
   */
  multiplyByDecimal(factor: MoneyDecimalValue | string, roundingRuleId: RoundingRuleId): Money {
    const rule = getRoundingRule(roundingRuleId);
    const scaled = new MoneyDecimal(this.amountMinorUnits.toString()).times(factor);
    return new Money(rule.round(scaled), this.currency);
  }

  /**
   * Division requires an explicit rounding rule argument (spec §0.4,
   * acceptance criterion 4) — there is no overload that omits it.
   */
  divideByInteger(divisor: bigint, roundingRuleId: RoundingRuleId): Money {
    if (divisor === 0n) {
      throw new InvalidMoneyAmountError("Cannot divide Money by zero.");
    }
    const rule = getRoundingRule(roundingRuleId);
    const result = new MoneyDecimal(this.amountMinorUnits.toString()).dividedBy(divisor.toString());
    return new Money(rule.round(result), this.currency);
  }

  /**
   * Splits this amount across `weights` (non-negative integers) using the
   * largest-remainder method. The parts always sum EXACTLY to the original
   * amount — no lost cent, no invented cent (spec §0.4, acceptance
   * criterion 2) — for any sign and any weight distribution.
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) {
      throw new InvalidAllocationError("allocate() requires at least one weight.");
    }
    if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
      throw new InvalidAllocationError("allocate() weights must be non-negative integers.");
    }
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
      throw new InvalidAllocationError("allocate() requires a positive total weight.");
    }

    const totalWeightBig = BigInt(totalWeight);
    const negative = this.amountMinorUnits < 0n;
    const absTotal = negative ? -this.amountMinorUnits : this.amountMinorUnits;

    const shares: bigint[] = [];
    const remainders: { index: number; remainder: bigint }[] = [];
    let allocated = 0n;

    weights.forEach((weight, index) => {
      const weightBig = BigInt(weight);
      const share = (absTotal * weightBig) / totalWeightBig;
      const remainder = (absTotal * weightBig) % totalWeightBig;
      shares.push(share);
      remainders.push({ index, remainder });
      allocated += share;
    });

    let leftover = absTotal - allocated;
    remainders.sort((a, b) => {
      if (b.remainder > a.remainder) return 1;
      if (b.remainder < a.remainder) return -1;
      return a.index - b.index; // stable, deterministic tie-break
    });
    for (let i = 0; i < remainders.length && leftover > 0n; i++) {
      const entry = remainders[i];
      if (!entry) break;
      shares[entry.index] = (shares[entry.index] ?? 0n) + 1n;
      leftover -= 1n;
    }

    return shares.map((amount) => new Money(negative ? -amount : amount, this.currency));
  }

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amountMinorUnits < other.amountMinorUnits) return -1;
    if (this.amountMinorUnits > other.amountMinorUnits) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinorUnits === other.amountMinorUnits;
  }

  isZero(): boolean {
    return this.amountMinorUnits === 0n;
  }

  isNegative(): boolean {
    return this.amountMinorUnits < 0n;
  }

  isPositive(): boolean {
    return this.amountMinorUnits > 0n;
  }

  /** Lossless: amountMinorUnits is serialized as a string, never a number. */
  toJSON(): MoneyJSON {
    return { amountMinorUnits: this.amountMinorUnits.toString(), currency: this.currency };
  }

  static fromJSON(json: MoneyJSON): Money {
    assertValidCurrency(json.currency);
    if (!/^-?\d+$/.test(json.amountMinorUnits)) {
      throw new InvalidMoneyAmountError(`Invalid serialized amountMinorUnits: "${json.amountMinorUnits}"`);
    }
    return new Money(BigInt(json.amountMinorUnits), json.currency);
  }

  toString(): string {
    return `${this.amountMinorUnits.toString()} ${this.currency} (minor units)`;
  }
}

/** Sums an array of Money values against an expected currency; throws CurrencyMismatchError on mismatch. */
export function sumMoney(values: readonly Money[], currency: string): Money {
  return values.reduce((total, value) => total.add(value), Money.zero(currency));
}
