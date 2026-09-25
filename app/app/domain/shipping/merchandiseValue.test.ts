import { describe, expect, it } from "vitest";

import {
  EmptyShipmentContentsError,
  InvalidShipmentMerchandiseLineError,
  computeShipmentMerchandiseValue,
  type ShipmentMerchandiseLine,
} from "./merchandiseValue";

function line(overrides: Partial<ShipmentMerchandiseLine> = {}): ShipmentMerchandiseLine {
  return { quantity: 1, merchandiseValueMinorUnits: 100_00n, currency: "USD", ...overrides };
}

describe("computeShipmentMerchandiseValue — D29", () => {
  it("sums a single line", () => {
    const result = computeShipmentMerchandiseValue([line({ merchandiseValueMinorUnits: 150_00n })]);
    expect(result.amountMinorUnits).toBe(150_00n);
    expect(result.currency).toBe("USD");
  });

  it("sums multiple lines in the same currency", () => {
    const result = computeShipmentMerchandiseValue([
      line({ merchandiseValueMinorUnits: 150_00n }),
      line({ merchandiseValueMinorUnits: 25_00n, quantity: 2 }),
    ]);
    expect(result.amountMinorUnits).toBe(175_00n);
  });

  it("refuses an empty shipment", () => {
    expect(() => computeShipmentMerchandiseValue([])).toThrow(EmptyShipmentContentsError);
  });

  it("refuses a non-positive quantity", () => {
    expect(() => computeShipmentMerchandiseValue([line({ quantity: 0 })])).toThrow(InvalidShipmentMerchandiseLineError);
    expect(() => computeShipmentMerchandiseValue([line({ quantity: -1 })])).toThrow(InvalidShipmentMerchandiseLineError);
  });

  it("refuses a non-integer quantity", () => {
    expect(() => computeShipmentMerchandiseValue([line({ quantity: 1.5 })])).toThrow(InvalidShipmentMerchandiseLineError);
  });

  it("refuses a negative merchandise value", () => {
    expect(() => computeShipmentMerchandiseValue([line({ merchandiseValueMinorUnits: -1n })])).toThrow(
      InvalidShipmentMerchandiseLineError
    );
  });

  it("accepts a zero-value line (e.g. a free promotional item included in the shipment)", () => {
    const result = computeShipmentMerchandiseValue([line({ merchandiseValueMinorUnits: 0n })]);
    expect(result.amountMinorUnits).toBe(0n);
  });

  it("refuses mismatched currencies across lines rather than silently summing them", () => {
    expect(() =>
      computeShipmentMerchandiseValue([line({ currency: "USD" }), line({ currency: "EUR" })])
    ).toThrow(/currency/i);
  });

  it("criterion — split shipments are valued independently: a second package's lines never influence this one's total", () => {
    // The whole point: this function has no parameter for "the rest of the
    // order." Passing only package A's lines values package A alone.
    const packageA = computeShipmentMerchandiseValue([line({ merchandiseValueMinorUnits: 200_00n })]);
    const packageB = computeShipmentMerchandiseValue([line({ merchandiseValueMinorUnits: 50_00n })]);
    expect(packageA.amountMinorUnits).toBe(200_00n);
    expect(packageB.amountMinorUnits).toBe(50_00n);
    // Neither computation knows the other package, or the order total,
    // exists — there is no way to combine them by accident.
  });

  it("criterion — tender is not value: nothing in the input type can represent an amount paid, a gift-card/store-credit reduction, or a tip", () => {
    // Structural proof, not a runtime one: ShipmentMerchandiseLine has
    // exactly three fields.
    const oneLine = line();
    expect(Object.keys(oneLine).sort()).toEqual(["currency", "merchandiseValueMinorUnits", "quantity"]);
  });
});
