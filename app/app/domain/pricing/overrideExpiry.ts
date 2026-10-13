/**
 * Override expiry decision (owner §2.4; spec criteria 15/16; definition
 * locked at docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §13.1/§16.1):
 *
 *   "A recalculation is material for a given override when it produces a
 *    Bank Payment Price that differs from the Bank Payment Price of the
 *    calculation the override departed from. A recalculation producing an
 *    identical Bank Payment Price is immaterial and leaves the override in
 *    force."
 *
 * PURE — no database access, no I/O, no clock. Mirrors the discipline of
 * `app/app/domain/pricing/engine.ts` and of the sibling decision function
 * `decideSync` (`app/app/jobs/pricing/decideSync.ts`, owned by another
 * agent): every input is passed explicitly, so this module never resolves
 * "the departed-from calculation" or "the newest calculation" itself — that
 * lookup is a repository concern (see
 * `app/app/db/repositories/priceOverrideExpiryRepository.server.ts`).
 *
 * THE COMPARISON IS CALCULATION-TO-CALCULATION, NOT OVERRIDE-TO-CALCULATION.
 * An override's own chosen price (`price_override.override_bank_payment_
 * price_minor_units`) is a human's deliberate departure from the engine and
 * plays NO part in materiality — only the two ENGINE OUTPUTS (before and
 * after) are compared. An override that departed from a $400 calculation and
 * manually set $999 is retired by a recalculation that moves the engine's
 * own answer to $401, never by how far $999 sits from either figure.
 *
 * THE DAILY NO-CHANGE TRAP. If a recalculation that reproduces the exact same
 * Bank Payment Price were treated as material, every override would be
 * retired within 24 hours by the very next scheduled run (D15), making the
 * feature useless. That is exactly why "differs" — not "a recalculation
 * happened" — is the trigger, and it is exercised as its own test case
 * rather than left to be implied by the "differs" case alone.
 */

export class OverrideExpiryCurrencyMismatchError extends Error {
  constructor(
    readonly departedFromCurrency: string,
    readonly recalculatedCurrency: string
  ) {
    super(
      `Cannot judge override materiality across currencies: the calculation this override departed from was ${departedFromCurrency}, the new calculation is ${recalculatedCurrency}.`
    );
    this.name = "OverrideExpiryCurrencyMismatchError";
  }
}

export interface OverrideExpiryInput {
  /** `price_override.never_expire` on the override currently in force. */
  neverExpire: boolean;
  /**
   * The Bank Payment Price of the calculation THIS OVERRIDE DEPARTED FROM —
   * i.e. `priceCalculation.bankPaymentPriceMinorUnits` for the row named by
   * the in-force override's `priceCalculationId`.
   */
  departedFromBankPaymentPriceMinorUnits: bigint;
  departedFromCurrency: string;
  /** The Bank Payment Price the NEW recalculation just produced. */
  recalculatedBankPaymentPriceMinorUnits: bigint;
  recalculatedCurrency: string;
}

export interface OverrideExpiryDecision {
  expires: boolean;
  /** Human-readable, for the audit note on the appended `expired` row. */
  reason: string;
}

export function decideOverrideExpiry(input: OverrideExpiryInput): OverrideExpiryDecision {
  // Both are already Bank Payment Prices in the same store currency in every
  // real call — this exists so a caller error surfaces as a named,
  // attributable exception rather than a silently wrong bigint comparison.
  if (input.departedFromCurrency !== input.recalculatedCurrency) {
    throw new OverrideExpiryCurrencyMismatchError(
      input.departedFromCurrency,
      input.recalculatedCurrency
    );
  }

  // Checked FIRST, ahead of materiality: the owner's escape hatch survives
  // ANY number of material recalculations, so there is no price comparison
  // whose answer would change this outcome (owner §2.4, criterion 16).
  if (input.neverExpire) {
    return {
      expires: false,
      reason: "neverExpire is set — this override survives any material recalculation and is retired only by an explicit human revoke",
    };
  }

  // Exact bigint equality — both operands are whole minor units, so this is
  // precise with no rounding/float hazard (CLAUDE.md #6).
  const unchanged =
    input.recalculatedBankPaymentPriceMinorUnits === input.departedFromBankPaymentPriceMinorUnits;

  if (unchanged) {
    return {
      expires: false,
      reason:
        "the recalculation produced the same Bank Payment Price as the calculation this override departed from — immaterial, the override stays in force",
    };
  }

  return {
    expires: true,
    reason:
      `the recalculation produced a different Bank Payment Price than the calculation this override departed from ` +
      `(${input.departedFromBankPaymentPriceMinorUnits.toString()} -> ${input.recalculatedBankPaymentPriceMinorUnits.toString()} minor units) — material, the override is retired`,
  };
}
