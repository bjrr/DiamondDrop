import { MoneyDecimal } from "~/domain/money/decimal";
import type { MoneyJSON } from "~/domain/money/money";

/**
 * The sync decision (spec §9.3). PURE — no I/O, so it is unit-testable and
 * cannot depend on when it runs.
 */

export type SyncDecision = "auto_apply" | "needs_approval";

export interface DecideSyncInput {
  newPrice: MoneyJSON;
  /** Absent when this variant has never had a synced price. */
  lastSyncedPrice?: MoneyJSON | null;
  /**
   * NULL means the owner has not supplied a tolerance (D14 outstanding).
   * Automatic publication is then DISABLED: every change needs approval.
   * Zero is a different, legitimate answer — "any change at all needs
   * approval" — and both produce needs_approval, but for stated reasons.
   */
  toleranceBps: number | null;
}

export interface DecideSyncResult {
  decision: SyncDecision;
  /** Signed delta in basis points; null on a first-ever price. */
  deltaBps: number | null;
  /**
   * Signed delta in MINOR UNITS — D15 asks for the dollar change alongside the
   * percentage one. A bigint, not a number: a price delta is money.
   *
   * Null exactly when deltaBps is, so the two never disagree about whether a
   * comparison happened.
   */
  deltaMinorUnits: bigint | null;
  /** True when the new price equals the last synced one — nothing to do. */
  unchanged: boolean;
  reason: string;
}

export function decideSync(input: DecideSyncInput): DecideSyncResult {
  const next = new MoneyDecimal(input.newPrice.amountMinorUnits);

  // A brand-new price must NEVER auto-publish. There is no prior price to
  // sanity-check the magnitude against, so the first price for a variant is
  // always a human decision.
  if (!input.lastSyncedPrice) {
    return {
      decision: "needs_approval",
      deltaBps: null,
      deltaMinorUnits: null,
      unchanged: false,
      reason: "first price for this variant — no prior price to compare against",
    };
  }

  const previous = new MoneyDecimal(input.lastSyncedPrice.amountMinorUnits);

  if (next.equals(previous)) {
    return {
      decision: "auto_apply",
      deltaBps: 0,
      deltaMinorUnits: 0n,
      unchanged: true,
      reason: "price unchanged — nothing to sync and nothing to approve",
    };
  }

  // Checked AFTER the unchanged case on purpose: a price that did not move has
  // nothing to publish, so it stays a no-op even with no tolerance configured.
  // Queueing it would fill the approval list with nothing to approve (§9.3).
  if (input.toleranceBps === null) {
    return {
      decision: "needs_approval",
      deltaBps: null,
      deltaMinorUnits: null,
      unchanged: false,
      reason:
        "automatic publication is disabled: no auto-apply tolerance configured (owner decision D14 outstanding)",
    };
  }

  // A zero prior price cannot yield a meaningful percentage change; treat it
  // as unreviewable rather than dividing by zero.
  if (previous.isZero()) {
    return {
      decision: "needs_approval",
      deltaBps: null,
      deltaMinorUnits: null,
      unchanged: false,
      reason: "prior price was zero — relative change is undefined",
    };
  }

  const delta = next.minus(previous);
  const deltaBpsExact = delta.dividedBy(previous).times(10000);
  const magnitudeBps = deltaBpsExact.abs();

  // Boundary is INCLUSIVE: a change exactly at tolerance auto-applies.
  const withinTolerance = magnitudeBps.lessThanOrEqualTo(input.toleranceBps);

  return {
    decision: withinTolerance ? "auto_apply" : "needs_approval",
    // Rounded only for display/storage; the comparison above used the exact value.
    deltaBps: Number(deltaBpsExact.toDecimalPlaces(0).toString()),
    // Both operands are whole minor units, so this subtraction is exact and the
    // bigint conversion loses nothing.
    deltaMinorUnits: BigInt(next.minus(previous).toString()),
    unchanged: false,
    reason: withinTolerance
      ? `change of ${magnitudeBps.toDecimalPlaces(0).toString()} bps is within the ${input.toleranceBps} bps tolerance`
      : // Increases and decreases are treated symmetrically on purpose: a large
        // DECREASE is as much a data-entry-error signal as a large increase,
        // and auto-publishing one would quietly sell below cost.
        `change of ${magnitudeBps.toDecimalPlaces(0).toString()} bps exceeds the ${input.toleranceBps} bps tolerance`,
  };
}
