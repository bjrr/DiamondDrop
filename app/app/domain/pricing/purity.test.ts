import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import type { PurityFactorSetId } from "./purity";
import {
  UnknownPurityError,
  UnknownPurityFactorSetError,
  alloyedPricePerGram,
  purityFineness,
} from "./purity";

/**
 * The explicit alloy definition: staff enter ONE pure reference price per
 * metal, and the alloyed price is derived as pure x fineness.
 *
 * WHAT THIS MODEL PREVENTS, and why it replaced per-karat prices. Separate
 * prices per karat drift out of step silently. The seeded data demonstrated it:
 * 14k at $48.25/g and 18k at $62.00/g both implied pure gold near $82.7/g,
 * while 10k at $29.50/g implied $70.80/g — three karats, two underlying gold
 * prices, a 17% error on 10k, and nothing capable of detecting it. With one
 * reference that inconsistency is unrepresentable, which is the point.
 */

describe("fineness is the physical definition of the alloy", () => {
  it("uses parts-per-24 for gold", () => {
    // Karat is defined as parts of gold per 24 by mass. These are facts, not
    // business numbers, which is why they live in code rather than a table.
    expect(purityFineness("GOLD_18K")).toBe("0.750000"); // 18/24, exact
    expect(purityFineness("GOLD_14K")).toBe("0.583333"); // 14/24
    expect(purityFineness("GOLD_10K")).toBe("0.416667"); // 10/24
  });

  it("uses parts-per-1000 for silver and platinum", () => {
    expect(purityFineness("SILVER_925")).toBe("0.925000");
    expect(purityFineness("PLATINUM_950")).toBe("0.950000");
  });

  it("matches the arithmetic it claims to encode", () => {
    // Guards a typo in the table above. Compared NUMERICALLY, not as formatted
    // strings: "0.75" and "0.750000" are the same number, and asserting on the
    // padding would test the formatter rather than the fineness.
    const expectFineness = (purity: string, num: number, den: number) => {
      const exact = new MoneyDecimal(num).dividedBy(den).toDecimalPlaces(6);
      expect(new MoneyDecimal(purityFineness(purity)).equals(exact)).toBe(true);
    };

    expectFineness("GOLD_10K", 10, 24);
    expectFineness("GOLD_14K", 14, 24);
    expectFineness("GOLD_18K", 18, 24);
  });

  it("orders the karats correctly", () => {
    // A transposed pair would be invisible in any single-value assertion.
    const ten = new MoneyDecimal(purityFineness("GOLD_10K"));
    const fourteen = new MoneyDecimal(purityFineness("GOLD_14K"));
    const eighteen = new MoneyDecimal(purityFineness("GOLD_18K"));

    expect(ten.lessThan(fourteen)).toBe(true);
    expect(fourteen.lessThan(eighteen)).toBe(true);
    expect(eighteen.lessThan(1)).toBe(true);
  });

  it("THROWS on an unknown purity rather than assuming pure metal", () => {
    // Defaulting to 1.0 would price an alloy as if it were solid gold —
    // a silent overcharge of up to 140%.
    expect(() => purityFineness("GOLD_22K")).toThrow(UnknownPurityError);
    expect(() => purityFineness("GOLD_22K")).toThrow(/defaulting to 1\.0/);
  });

  it("throws on an unregistered factor set", () => {
    expect(() => purityFineness("GOLD_14K", "MADE_UP_V9" as PurityFactorSetId)).toThrow(
      UnknownPurityFactorSetError
    );
  });
});

describe("alloyedPricePerGram", () => {
  it("applies the owner's formula: pure x purity", () => {
    // $82.70/g pure gold, 14k.
    expect(alloyedPricePerGram(new MoneyDecimal("82.700000"), "GOLD_14K").toString()).toBe(
      "48.2416391"
    );
  });

  it("gives back the reference for a notional pure metal", () => {
    // 18k is exactly three quarters, so this is exact rather than approximate.
    expect(alloyedPricePerGram(new MoneyDecimal("100"), "GOLD_18K").toString()).toBe("75");
  });

  it("keeps the karats mutually consistent — the whole point of one reference", () => {
    const pure = new MoneyDecimal("82.700000");
    const ten = new MoneyDecimal(alloyedPricePerGram(pure, "GOLD_10K"));
    const eighteen = new MoneyDecimal(alloyedPricePerGram(pure, "GOLD_18K"));

    // 18k must cost exactly 18/10 of 10k, because both derive from one price.
    // Under per-karat entry this ratio was 2.10 — the drift that motivated the
    // change.
    expect(eighteen.dividedBy(ten).toDecimalPlaces(4).toString()).toBe("1.8");
  });

  it("does not round the intermediate", () => {
    // Rounding per-gram would compound across the weight multiplication, so it
    // is deferred to the single boundary in the engine.
    const result = alloyedPricePerGram(new MoneyDecimal("82.700000"), "GOLD_10K");
    expect(result.toString()).toMatch(/\./);
    expect(result.toString().split(".")[1]!.length).toBeGreaterThan(2);
  });

  it("is exact where a float would drift", () => {
    // 0.1-style hazard: 3 x 0.416667 is 1.250001 exactly, not 1.2500009999.
    expect(alloyedPricePerGram(new MoneyDecimal("3"), "GOLD_10K").toString()).toBe("1.250001");
  });

  it("throws rather than silently pricing an unknown alloy", () => {
    expect(() => alloyedPricePerGram(new MoneyDecimal("82.7"), "PLATINUM_900")).toThrow(
      UnknownPurityError
    );
  });
});
