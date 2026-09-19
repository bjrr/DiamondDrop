/**
 * Qualifying-unit counting (README, Group Buy).
 *
 * SUPERSEDED RULE, kept visible so the correction is legible. The README used
 * to read: "Cancellation removes qualifying units and can move the live
 * campaign BACK TO A PRIOR TIER before close." That is no longer the rule.
 *
 * THE CURRENT RULE (owner decision, docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md
 * §24, 2026-09-19), verbatim:
 *
 *   "Group Buy tier progression is one-way only: an order that counted toward
 *    an unlock is never subtracted from the customer-facing campaign count
 *    because it later goes unpaid/canceled; an unlocked tier never falls back;
 *    other customers are never repriced upward because another participant
 *    failed to pay; do not show another customer's cancellation in public
 *    campaign progress."
 *
 * WHAT THAT MEANS FOR THIS FOLD. `total` is the number this codebase treats as
 * the CAMPAIGN-WIDE, PUBLIC, TIER-DECIDING count (it is the only field
 * `unitLedger.server.ts` hands to `selectTier`, and the only one the App Proxy
 * route exposes as `qualifyingUnitsSold`). It is therefore a MONOTONIC,
 * PURCHASE-ONLY total — the running sum of every "purchased" event quantity,
 * full stop. A "cancelled" or "refunded" event is recorded, and is visible in
 * `removed`, but it never subtracts from `total`: doing so is exactly the
 * live behaviour §24 now forbids, because `total` is what the tier and the
 * storefront read.
 *
 * `byLine` stays NET (purchased minus removed, per line). That is a different
 * question — "does this specific line's own ledger balance" — and the
 * append-only-ledger validity check in `canRemoveUnits` genuinely needs a net
 * figure: it must still refuse cancelling more units than a line ever
 * purchased. Nothing about §24 says a line cannot record its own removal;
 * §24 says removals must not move the PUBLIC total or the PUBLIC tier
 * backward. `byLine` is never read by `selectTier` or exposed to the
 * storefront, so it carries no rollback risk.
 *
 * A COUNTER WOULD STILL BE THE WRONG SHAPE for `removed`/`purchased`/`byLine`.
 * §430 requires retaining "qualifying-unit history, cancellations, and tier
 * history" — a single integer remembers none of that. So the count is a FOLD
 * over an append-only ledger, and the ledger is the record.
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
  /**
   * Campaign-wide total — what tier thresholds compare against, and what the
   * storefront reads as `qualifyingUnitsSold`.
   *
   * MONOTONIC (owner §24): the running sum of "purchased" quantities only. A
   * cancellation or refund never reduces this — see the header for why.
   */
  total: number;
  /**
   * Per eligible variant, for the campaign page. Same one-way rule as
   * `total`: purchases only, never reduced by a removal.
   */
  byVariant: Readonly<Record<string, number>>;
  /**
   * Per line item, NET of any removal recorded on that line. An append-only-
   * ledger validity figure — used to refuse over-cancelling a line — not a
   * customer-facing count. Never read by `selectTier` or returned to the
   * storefront.
   */
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
 * TWO DIFFERENT ANSWERS, DELIBERATELY KEPT APART. `total`/`byVariant` are the
 * PUBLIC, ONE-WAY count (owner §24) — purchases only, a removal is recorded
 * but never subtracts. `byLine` is the PER-LINE NET, used only to police the
 * append-only ledger: a line must never be allowed to cancel more than it
 * ever purchased.
 *
 * REMOVALS ARE STILL VALIDATED PER LINE, not campaign-wide. Checking only a
 * campaign-wide net would let a line be over-cancelled while another line's
 * purchases silently absorbed the difference — the campaign figures would
 * look right and the refund owed on each line would be wrong. Since refunds
 * are calculated per line, that error would reach a customer's payment.
 */
export function foldQualifyingUnits(events: readonly UnitEvent[]): QualifyingUnitCount {
  const byLine: Record<string, number> = {};
  const byVariant: Record<string, number> = {};
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
      // PUBLIC, MONOTONIC: only ever added to. A cancellation or refund on
      // this same variant is still recorded in `removed`, just not here.
      byVariant[event.masterVariantId] = (byVariant[event.masterVariantId] ?? 0) + event.quantity;
    } else {
      removed += event.quantity;
    }

    // NET, PER LINE: a removal reduces this. Ledger-validity only — see
    // header. Never fed to `selectTier` and never returned to the storefront.
    byLine[event.lineRef] = (byLine[event.lineRef] ?? 0) + signed;
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
    // MONOTONIC (owner §24): equals `purchased`. Kept as its own field, named
    // for what it is used for, rather than making every caller read
    // `.purchased` and wonder whether that was intentional.
    total: purchased,
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
