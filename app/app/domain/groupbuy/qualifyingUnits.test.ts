import { describe, expect, it } from "vitest";

import {
  UnitLedgerError,
  canRemoveUnits,
  foldQualifyingUnits,
  type UnitEvent,
} from "./qualifyingUnits";

/**
 * Qualifying-unit counting, README:
 *
 *   "Thresholds use qualifying units sold, not unique buyers. Three eligible
 *    pieces purchased by one customer count as three units."
 *
 * And owner decision (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §24,
 * 2026-09-19, superseding the README's older "cancellation... can move the
 * live campaign back to a prior tier" line): the PUBLIC, tier-deciding total
 * is one-way. A cancellation or refund is recorded but never subtracts from
 * it.
 */

let seq = 0;
function purchase(lineRef: string, quantity: number, variant = "v1"): UnitEvent {
  return { externalRef: `e${++seq}`, kind: "purchased", quantity, masterVariantId: variant, lineRef };
}
function cancel(lineRef: string, quantity: number, variant = "v1"): UnitEvent {
  return { externalRef: `e${++seq}`, kind: "cancelled", quantity, masterVariantId: variant, lineRef };
}
function refund(lineRef: string, quantity: number, variant = "v1"): UnitEvent {
  return { externalRef: `e${++seq}`, kind: "refunded", quantity, masterVariantId: variant, lineRef };
}

describe("units, not buyers", () => {
  it("counts three pieces bought by ONE customer as three units", () => {
    // The README's own example, and the rule most likely to be implemented as
    // "count distinct orders" by mistake.
    expect(foldQualifyingUnits([purchase("line-1", 3)]).total).toBe(3);
  });

  it("counts one unit each across three separate buyers the same way", () => {
    const events = [purchase("line-1", 1), purchase("line-2", 1), purchase("line-3", 1)];
    expect(foldQualifyingUnits(events).total).toBe(3);
  });

  it("counts nothing for an empty campaign", () => {
    expect(foldQualifyingUnits([]).total).toBe(0);
  });
});

describe("cancelled and refunded units are recorded but never roll the PUBLIC total back (owner §24)", () => {
  it("does NOT subtract a cancellation from the public total", () => {
    // Superseded behaviour: this used to assert total === 2. Owner §24: "an
    // order that counted toward an unlock is never subtracted... because it
    // later goes unpaid/canceled."
    expect(foldQualifyingUnits([purchase("line-1", 3), cancel("line-1", 1)]).total).toBe(3);
  });

  it("does NOT subtract a refund from the public total either", () => {
    // They differ in why, not in effect on the public total.
    expect(foldQualifyingUnits([purchase("line-1", 3), refund("line-1", 2)]).total).toBe(3);
  });

  it("keeps the public total at its purchased peak even when a line is fully cancelled", () => {
    // Superseded behaviour: this used to assert total === 0.
    expect(foldQualifyingUnits([purchase("line-1", 2), cancel("line-1", 2)]).total).toBe(2);
  });

  it("never lets a later cancellation reduce the total below an EARLIER cancellation-adjusted level", () => {
    // The scenario §24 exists for: two customers join, unlocking a tier; the
    // first cancels. The tier — and the public total behind it — must not
    // fall back for the second customer, or for anyone reading the campaign
    // page afterwards.
    const events = [
      purchase("line-1", 5), // tier unlocked at 5
      purchase("line-2", 3), // a later customer joins at the unlocked tier
      cancel("line-1", 5), // the first customer's order is fully cancelled
    ];
    expect(foldQualifyingUnits(events).total).toBe(8);
  });

  it("reports purchased and removed separately, for the history — removed no longer implies a lower total", () => {
    const count = foldQualifyingUnits([purchase("line-1", 5), cancel("line-1", 2)]);
    expect(count.purchased).toBe(5);
    expect(count.removed).toBe(2);
    // Superseded behaviour: this used to assert total === 3 (purchased -
    // removed). The public total is purchases only now.
    expect(count.total).toBe(5);
  });
});

describe("counting is per line item", () => {
  it("tracks the PUBLIC per-line-item contribution to the total independently, purchases only", () => {
    const count = foldQualifyingUnits([
      purchase("line-1", 3),
      purchase("line-2", 2),
      cancel("line-1", 1),
    ]);
    // Superseded behaviour: this used to assert total === 4 (net of the
    // cancellation). Cancelling line-1 no longer reduces the public total.
    expect(count.total).toBe(5);
  });

  it("still tracks each line's NET separately, for the append-only-ledger validity check", () => {
    // `byLine` is not customer-facing (see the header) — it exists so
    // `canRemoveUnits` can refuse an over-cancellation, which is a different
    // question from what the public total shows.
    const count = foldQualifyingUnits([
      purchase("line-1", 3),
      purchase("line-2", 2),
      cancel("line-1", 1),
    ]);
    expect(count.byLine["line-1"]).toBe(2);
    expect(count.byLine["line-2"]).toBe(2);
  });

  it("REFUSES an over-removal on one line even when the campaign total covers it", () => {
    // The bug this prevents. Campaign-wide the numbers balance — 5 purchased,
    // 4 removed — but line-1 only ever had 1 unit. Validating a net total
    // alone would let another line's purchases silently absorb the
    // difference, and since refunds are calculated per line, the error would
    // reach a customer's payment.
    const events = [purchase("line-1", 1), purchase("line-2", 4), cancel("line-1", 4)];
    expect(() => foldQualifyingUnits(events)).toThrow(UnitLedgerError);
    expect(() => foldQualifyingUnits(events)).toThrow(/line line-1: removals exceed purchases/);
  });

  it("tracks PUBLIC units per variant too, purchases only — same one-way rule as the total", () => {
    const count = foldQualifyingUnits([
      purchase("line-1", 2, "gold-7"),
      purchase("line-2", 1, "plat-7"),
      cancel("line-1", 1, "gold-7"),
    ]);
    // Superseded behaviour: this used to assert byVariant["gold-7"] === 1
    // (net of the cancellation). `byVariant` is documented as feeding the
    // campaign page, so it follows the same public, one-way rule as `total`.
    expect(count.byVariant["gold-7"]).toBe(2);
    expect(count.byVariant["plat-7"]).toBe(1);
  });
});

describe("invalid events are rejected rather than absorbed", () => {
  it("rejects a zero or negative quantity", () => {
    // Direction comes from `kind`; a negative quantity would encode it twice
    // and let the ledger disagree with itself.
    expect(() => foldQualifyingUnits([purchase("line-1", 0)])).toThrow(/positive integer/);
    expect(() => foldQualifyingUnits([purchase("line-1", -2)])).toThrow(/positive integer/);
  });

  it("rejects a fractional quantity", () => {
    expect(() => foldQualifyingUnits([purchase("line-1", 1.5)])).toThrow(/positive integer/);
  });
});

describe("canRemoveUnits guards the append-only ledger", () => {
  const purchased = [purchase("line-1", 3)];

  it("allows a removal within what the line has left", () => {
    expect(canRemoveUnits(purchased, "line-1", 3)).toMatchObject({ allowed: true, remaining: 3 });
  });

  it("refuses one unit too many, and says how many remain", () => {
    const result = canRemoveUnits(purchased, "line-1", 4);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(3);
    expect(result.reason).toMatch(/only 3 remain/);
  });

  it("refuses any removal from a line with nothing on it", () => {
    expect(canRemoveUnits(purchased, "line-unknown", 1).allowed).toBe(false);
  });

  it("accounts for removals already recorded", () => {
    const events = [purchase("line-1", 3), cancel("line-1", 2)];
    expect(canRemoveUnits(events, "line-1", 1).allowed).toBe(true);
    expect(canRemoveUnits(events, "line-1", 2).allowed).toBe(false);
  });

  it("exists so an invalid event is never WRITTEN", () => {
    // The ledger is append-only. An over-removal recorded once would make every
    // later fold throw, leaving the campaign permanently unreadable rather than
    // merely wrong — so the check has to happen before the write.
    const bad = canRemoveUnits(purchased, "line-1", 99);
    expect(bad.allowed).toBe(false);
    expect(() => foldQualifyingUnits([...purchased, cancel("line-1", 99)])).toThrow();
  });
});
