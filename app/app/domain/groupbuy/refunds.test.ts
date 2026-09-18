import { describe, expect, it } from "vitest";

import {
  InvalidRefundTransitionError,
  RefundComputationError,
  assertRefundTransition,
  computeTierRefund,
  isTerminal,
  type RefundStatus,
} from "./refunds";

/**
 * Tier-adjustment refunds (README §171, §173).
 *
 * "If a lower tier is ultimately reached, earlier participants receive the same
 *  final eligible-variant price."
 */

describe("refund amount", () => {
  it("refunds the difference, times the units", () => {
    // Paid $400, campaign settled at $360, three units still qualifying.
    const result = computeTierRefund({
      paidPerUnitMinorUnits: 40_000n,
      finalPerUnitMinorUnits: 36_000n,
      qualifyingUnits: 3,
    });

    expect(result.refundPerUnitMinorUnits).toBe(4_000n);
    expect(result.totalRefundMinorUnits).toBe(12_000n);
    expect(result.owed).toBe(true);
  });

  it("owes nothing when the price did not move", () => {
    const result = computeTierRefund({
      paidPerUnitMinorUnits: 40_000n,
      finalPerUnitMinorUnits: 40_000n,
      qualifyingUnits: 2,
    });

    expect(result.totalRefundMinorUnits).toBe(0n);
    expect(result.owed).toBe(false);
    expect(result.finalPriceExceededPaid).toBe(false);
  });

  it("NEVER becomes a charge when the final price is higher", () => {
    // The asymmetry the README does not address. Cancellations can move the
    // tier backwards, so someone who bought at the deepest tier can find the
    // final tier shallower than the one they paid at. We absorb it: charging a
    // customer more after checkout because other people cancelled is not
    // something to infer from silence.
    const result = computeTierRefund({
      paidPerUnitMinorUnits: 36_000n,
      finalPerUnitMinorUnits: 40_000n,
      qualifyingUnits: 3,
    });

    expect(result.totalRefundMinorUnits).toBe(0n);
    expect(result.refundPerUnitMinorUnits).toBe(0n);
    expect(result.owed).toBe(false);
    // Recorded rather than silently swallowed — a campaign where this happens
    // has had cancellations undo a tier, and that is worth being able to see.
    expect(result.finalPriceExceededPaid).toBe(true);
  });

  it("owes nothing on a line with no qualifying units left", () => {
    // Fully cancelled: the tier adjustment is moot because the purchase is gone.
    const result = computeTierRefund({
      paidPerUnitMinorUnits: 40_000n,
      finalPerUnitMinorUnits: 36_000n,
      qualifyingUnits: 0,
    });
    expect(result.totalRefundMinorUnits).toBe(0n);
    expect(result.owed).toBe(false);
  });

  it("is exact on large amounts, with no float in the path", () => {
    // bigint throughout: a value beyond 2^53 still multiplies exactly.
    const result = computeTierRefund({
      paidPerUnitMinorUnits: 9_007_199_254_740_993n,
      finalPerUnitMinorUnits: 1n,
      qualifyingUnits: 3,
    });
    expect(result.totalRefundMinorUnits).toBe(27_021_597_764_222_976n);
  });

  it("rejects invalid inputs rather than coercing them", () => {
    expect(() =>
      computeTierRefund({ paidPerUnitMinorUnits: 1n, finalPerUnitMinorUnits: 0n, qualifyingUnits: 1.5 })
    ).toThrow(RefundComputationError);
    expect(() =>
      computeTierRefund({ paidPerUnitMinorUnits: -1n, finalPerUnitMinorUnits: 0n, qualifyingUnits: 1 })
    ).toThrow(/cannot be negative/);
  });
});

describe("the refund lifecycle holds money through production", () => {
  it("cannot go straight from pending to processing", () => {
    // The owner's timing, encoded: settled at close, HELD through production
    // and QC, released only at shipping. A direct pending -> processing path
    // would pay before the item shipped.
    expect(() => assertRefundTransition("pending", "processing")).toThrow(
      InvalidRefundTransitionError
    );
  });

  it("follows close -> shipped -> processed -> issued", () => {
    expect(() => assertRefundTransition("pending", "releasable")).not.toThrow();
    expect(() => assertRefundTransition("releasable", "processing")).not.toThrow();
    expect(() => assertRefundTransition("processing", "issued")).not.toThrow();
  });

  it("lets a failed refund be retried through the SAME path", () => {
    // Back to releasable, not straight to processing: a retry should not
    // acquire a second, less-tested route to money.
    expect(() => assertRefundTransition("processing", "failed")).not.toThrow();
    expect(() => assertRefundTransition("failed", "releasable")).not.toThrow();
    expect(() => assertRefundTransition("failed", "processing")).toThrow();
  });
});

describe("issued is terminal — no duplicate customer value", () => {
  it("has NO outgoing transitions at all", () => {
    // README 371: "Duplicate/retried refund ... must not create duplicate
    // customer value." A retry cannot find a path back into processing.
    const everyStatus: RefundStatus[] = [
      "pending",
      "releasable",
      "processing",
      "issued",
      "failed",
      "not_owed",
    ];

    for (const to of everyStatus) {
      expect(() => assertRefundTransition("issued", to)).toThrow(InvalidRefundTransitionError);
    }
    expect(isTerminal("issued")).toBe(true);
  });

  it("treats not_owed as terminal too", () => {
    expect(isTerminal("not_owed")).toBe(true);
    expect(() => assertRefundTransition("not_owed", "releasable")).toThrow();
  });

  it("names what WAS allowed when it refuses", () => {
    // A refusal that does not say what is permitted just moves the guesswork.
    expect(() => assertRefundTransition("pending", "issued")).toThrow(/Allowed: releasable, not_owed/);
  });
});
