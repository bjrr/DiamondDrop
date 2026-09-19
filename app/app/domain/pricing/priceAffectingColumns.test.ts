import { describe, expect, it } from "vitest";

import {
  NOT_PRICE_AFFECTING_COLUMNS,
  PRICE_AFFECTING_COLUMNS,
  UnclassifiedColumnError,
  isPriceAffectingChange,
} from "./priceAffectingColumns";

/**
 * Criterion 58 — created by T5's own R5 audit caveat. See the module doc
 * comment for the stakes: `lastSyncedPriceCalculationId` is stamped on
 * every successful publish, so classifying it as price-affecting would
 * create a catalogue-wide publish/recalculate loop.
 */

describe("isPriceAffectingChange — the required scenarios (criterion 58)", () => {
  it("a write touching ONLY lastSyncedPriceCalculationId triggers nothing — THE LOOP CASE", () => {
    expect(
      isPriceAffectingChange("MasterVariant", ["lastSyncedPriceCalculationId"])
    ).toBe(false);
  });

  it("a bankPaymentDiscountEligible toggle triggers nothing", () => {
    expect(isPriceAffectingChange("MasterVariant", ["bankPaymentDiscountEligible"])).toBe(false);
  });

  it("a status change triggers nothing (MasterVariant)", () => {
    expect(isPriceAffectingChange("MasterVariant", ["status"])).toBe(false);
  });

  it("a status change triggers nothing (MasterProduct)", () => {
    expect(isPriceAffectingChange("MasterProduct", ["status"])).toBe(false);
  });

  it("a baseWeightGrams change DOES trigger", () => {
    expect(isPriceAffectingChange("MasterVariant", ["baseWeightGrams"])).toBe(true);
  });

  it("a MIXED write — one price-affecting column and one irrelevant one — DOES trigger", () => {
    expect(
      isPriceAffectingChange("MasterVariant", ["lastSyncedPriceCalculationId", "baseWeightGrams"])
    ).toBe(true);
  });

  it("the mixed case is order-independent", () => {
    expect(
      isPriceAffectingChange("MasterVariant", ["baseWeightGrams", "status", "shopifyVariantGid"])
    ).toBe(true);
  });
});

describe("isPriceAffectingChange — every covered table's non-price-affecting columns", () => {
  for (const [model, columns] of Object.entries(NOT_PRICE_AFFECTING_COLUMNS)) {
    for (const column of Object.keys(columns)) {
      it(`${model}.${column} does not trigger on its own`, () => {
        expect(isPriceAffectingChange(model as never, [column])).toBe(false);
      });
    }
  }
});

describe("isPriceAffectingChange — every covered table's price-affecting columns", () => {
  for (const [model, columns] of Object.entries(PRICE_AFFECTING_COLUMNS)) {
    for (const column of columns) {
      it(`${model}.${column} triggers on its own`, () => {
        expect(isPriceAffectingChange(model as never, [column])).toBe(true);
      });
    }
  }
});

describe("isPriceAffectingChange — fails loud on an unclassified column", () => {
  it("throws UnclassifiedColumnError rather than guessing either direction", () => {
    expect(() => isPriceAffectingChange("MasterVariant", ["someBrandNewColumn"])).toThrow(
      UnclassifiedColumnError
    );
  });

  it("names the model and column in the error", () => {
    try {
      isPriceAffectingChange("MasterProduct", ["notReal"]);
      expect.fail("expected UnclassifiedColumnError");
    } catch (error) {
      expect(error).toBeInstanceOf(UnclassifiedColumnError);
      expect((error as UnclassifiedColumnError).model).toBe("MasterProduct");
      expect((error as UnclassifiedColumnError).column).toBe("notReal");
    }
  });

  it("throws even when an earlier column in the same call IS classified — never a partial/guessed answer", () => {
    expect(() =>
      isPriceAffectingChange("MasterVariant", ["baseWeightGrams", "someBrandNewColumn"])
    ).toThrow(UnclassifiedColumnError);
  });
});

describe("the two lists never overlap for the same column", () => {
  for (const model of Object.keys(PRICE_AFFECTING_COLUMNS) as (keyof typeof PRICE_AFFECTING_COLUMNS)[]) {
    it(`${model}: no column is both price-affecting and explicitly not`, () => {
      const allowed = new Set(PRICE_AFFECTING_COLUMNS[model]);
      const denied = new Set(Object.keys(NOT_PRICE_AFFECTING_COLUMNS[model]));
      const overlap = [...allowed].filter((c) => denied.has(c));
      expect(overlap).toEqual([]);
    });
  }
});

describe("empty and no-op calls", () => {
  it("an empty changed-columns list never triggers", () => {
    expect(isPriceAffectingChange("MasterVariant", [])).toBe(false);
  });
});
