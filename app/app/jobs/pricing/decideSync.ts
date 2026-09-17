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
  toleranceBps: number;
}

export interface DecideSyncResult {
  decision: SyncDecision;
  /** Signed delta in basis points; null on a first-ever price. */
  deltaBps: number | null;
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
      unchanged: false,
      reason: "first price for this variant — no prior price to compare against",
    };
  }

  const previous = new MoneyDecimal(input.lastSyncedPrice.amountMinorUnits);

  if (next.equals(previous)) {
    return {
      decision: "auto_apply",
      deltaBps: 0,
      unchanged: true,
      reason: "price unchanged — nothing to sync and nothing to approve",
    };
  }

  // A zero prior price cannot yield a meaningful percentage change; treat it
  // as unreviewable rather than dividing by zero.
  if (previous.isZero()) {
    return {
      decision: "needs_approval",
      deltaBps: null,
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
    unchanged: false,
    reason: withinTolerance
      ? `change of ${magnitudeBps.toDecimalPlaces(0).toString()} bps is within the ${input.toleranceBps} bps tolerance`
      : // Increases and decreases are treated symmetrically on purpose: a large
        // DECREASE is as much a data-entry-error signal as a large increase,
        // and auto-publishing one would quietly sell below cost.
        `change of ${magnitudeBps.toDecimalPlaces(0).toString()} bps exceeds the ${input.toleranceBps} bps tolerance`,
  };
}
