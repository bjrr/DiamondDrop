import { describe, expect, it } from "vitest";

import { selectLowestPurchasablePrice, type AsLowAsCandidate } from "./asLowAs";

function candidate(masterVariantId: string, bankPaymentPriceMinorUnits: bigint): AsLowAsCandidate {
  return { masterVariantId, bankPaymentPriceMinorUnits };
}

describe("selectLowestPurchasablePrice — criteria 28-31", () => {
  it("returns null for an empty candidate list (criterion 31 — no fabricated figure)", () => {
    expect(selectLowestPurchasablePrice([])).toBeNull();
  });

  it("returns the only candidate when there is exactly one", () => {
    const only = candidate("v1", 100_000n);
    expect(selectLowestPurchasablePrice([only])).toBe(only);
  });

  it("picks the lowest bankPaymentPriceMinorUnits among several candidates", () => {
    const cheapest = candidate("v2", 80_000n);
    const result = selectLowestPurchasablePrice([
      candidate("v1", 100_000n),
      cheapest,
      candidate("v3", 250_000n),
    ]);
    expect(result).toBe(cheapest);
  });

  it("is unaffected by input order — the cheapest wins regardless of position", () => {
    const cheapest = candidate("v3", 50_000n);
    const first = selectLowestPurchasablePrice([cheapest, candidate("v1", 99_999n)]);
    const last = selectLowestPurchasablePrice([candidate("v1", 99_999n), cheapest]);
    expect(first).toBe(cheapest);
    expect(last).toBe(cheapest);
  });

  it("breaks an exact price tie deterministically by the lowest masterVariantId", () => {
    const a = candidate("variant-a", 100_000n);
    const b = candidate("variant-b", 100_000n);
    // Same tie, opposite input order — must name the same winner both ways,
    // or a re-run of the aggregator could flip the metafield's winner for no
    // underlying data change.
    expect(selectLowestPurchasablePrice([a, b])).toBe(a);
    expect(selectLowestPurchasablePrice([b, a])).toBe(a);
  });

  it("never lets a higher-priced variant win merely by appearing first", () => {
    const expensive = candidate("variant-first", 500_000n);
    const cheap = candidate("variant-second", 10_000n);
    expect(selectLowestPurchasablePrice([expensive, cheap])).toBe(cheap);
  });

  it("preserves extra fields on the winning candidate (works against full PublishedVariantPrice-shaped objects)", () => {
    interface Extended extends AsLowAsCandidate {
      priceCalculationId: string;
    }
    const winner: Extended = {
      masterVariantId: "v1",
      bankPaymentPriceMinorUnits: 10_000n,
      priceCalculationId: "calc-1",
    };
    const loser: Extended = {
      masterVariantId: "v2",
      bankPaymentPriceMinorUnits: 20_000n,
      priceCalculationId: "calc-2",
    };
    const result = selectLowestPurchasablePrice([loser, winner]);
    expect(result).toEqual(winner);
    expect(result?.priceCalculationId).toBe("calc-1");
  });
});
