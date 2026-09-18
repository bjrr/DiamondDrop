/**
 * Qualifying-unit counting (README, Group Buy).
 *
 * THE RULES THIS ENCODES, verbatim from the locked README:
 *
 *   "Thresholds use qualifying units sold, not unique buyers. Three eligible
 *    pieces purchased by one customer count as three units. Cancelled/refunded
 *    units that no longer qualify stop counting."
 *
 *   "Tier qualification and cancellation/refund calculations operate at
 *    line-item/unit level."
 *
 *   "Cancellation removes qualifying units and can move the live campaign BACK
 *    TO A PRIOR TIER before close."
 *
 * A COUNTER WOULD BE THE WRONG SHAPE. Two consequences of those rules rule it
 * out. Cancellations move the count DOWN, so the tier is not a high-water mark
 * and cannot be tracked as "best reached". And §430 requires retaining
 * "qualifying-unit history, cancellations, and tier history" — a single integer
 * remembers none of that. So the count is a FOLD over an append-only ledger,
 * and the ledger is the record.
 *
 * NOTHING HERE READS A CLOCK OR A DATABASE. Given the same events it returns
 * the same count, which is what lets a disputed tier be recomputed later from
 * the ledger alone.
 */

export type UnitEventKind = "purchased" | "cancelled" | "refunded";

export interface UnitEvent {
  /** Stable identity, used to make recording idempotent. */
  externalRef: string;
  kind: UnitEventKind;
  /** Always POSITIVE. Direction comes from `kind`, never from the sign. */
  quantity: number;
  masterVariantId: string;
  /** Line item this applies to. Counting is per line, per the README. */
  lineRef: string;
}

export interface QualifyingUnitCount {
  /** Campaign-wide total — what tier thresholds compare against. */
  total: number;
  /** Per eligible variant, for the campaign page and the refund ledger. */
  byVariant: Readonly<Record<string, number>>;
  /** Per line item, which is the level cancellation operates at. */
  byLine: Readonly<Record<string, number>>;
  purchased: number;
  removed: number;
}

export class UnitLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitLedgerError";
  }
}

/** Cancelled and refunded both remove units; they differ only in why. */
const REMOVES_UNITS: ReadonlySet<UnitEventKind> = new Set(["cancelled", "refunded"]);

/**
 * Folds the ledger into a live count.
 *
 * REMOVALS ARE VALIDATED PER LINE, not campaign-wide. Checking only the total
 * would let a line be over-cancelled while another line's purchases silently
 * absorbed the difference — the campaign total would look right and the refund
 * owed on each line would be wrong. Since refunds are calculated per line, that
 * error would reach a customer's payment.
 */
export function foldQualifyingUnits(events: readonly UnitEvent[]): QualifyingUnitCount {
  const byLine: Record<string, number> = {};
  const byVariant: Record<string, number> = {};
  const purchasedByLine: Record<string, number> = {};
  let purchased = 0;
  let removed = 0;

  for (const event of events) {
    if (!Number.isInteger(event.quantity) || event.quantity <= 0) {
      // Units are whole pieces. A zero or fractional event is not a quantity of
      // jewellery, and a negative one would encode direction twice.
      throw new UnitLedgerError(
        `event ${event.externalRef}: quantity must be a positive integer, got ${event.quantity}`
      );
    }

    const signed = REMOVES_UNITS.has(event.kind) ? -event.quantity : event.quantity;

    if (event.kind === "purchased") {
      purchased += event.quantity;
      purchasedByLine[event.lineRef] = (purchasedByLine[event.lineRef] ?? 0) + event.quantity;
    } else {
      removed += event.quantity;
    }

    byLine[event.lineRef] = (byLine[event.lineRef] ?? 0) + signed;
    byVariant[event.masterVariantId] = (byVariant[event.masterVariantId] ?? 0) + signed;
  }

  for (const [lineRef, net] of Object.entries(byLine)) {
    if (net < 0) {
      throw new UnitLedgerError(
        `line ${lineRef}: removals exceed purchases (net ${net}). ` +
          `A line cannot have fewer than zero qualifying units.`
      );
    }
  }

  return {
    total: Object.values(byLine).reduce((sum, n) => sum + n, 0),
    byVariant,
    byLine,
    purchased,
    removed,
  };
}

/**
 * Whether a proposed removal is allowed, given what the line has left.
 *
 * Separated from the fold so a caller can REFUSE a bad cancellation before
 * writing it. The ledger is append-only: an invalid event recorded and then
 * folded would leave the campaign permanently unfoldable, because
 * foldQualifyingUnits would throw on every subsequent read.
 */
export function canRemoveUnits(
  events: readonly UnitEvent[],
  lineRef: string,
  quantity: number
): { allowed: boolean; remaining: number; reason?: string } {
  const remaining = foldQualifyingUnits(events).byLine[lineRef] ?? 0;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { allowed: false, remaining, reason: "quantity must be a positive integer" };
  }
  if (quantity > remaining) {
    return {
      allowed: false,
      remaining,
      reason: `cannot remove ${quantity} unit(s) from line ${lineRef}: only ${remaining} remain`,
    };
  }
  return { allowed: true, remaining };
}
