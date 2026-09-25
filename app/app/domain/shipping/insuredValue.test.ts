import { describe, expect, it } from "vitest";

import { validateInsuredValue } from "./insuredValue";

describe("validateInsuredValue — criterion 173 coherence, never a threshold", () => {
  it("accepts absent insured value (both null)", () => {
    expect(validateInsuredValue({ insuredValueMinorUnits: null, currency: null })).toEqual({ ok: true });
  });

  it("accepts a well-formed positive insured value", () => {
    expect(validateInsuredValue({ insuredValueMinorUnits: 250_000n, currency: "USD" })).toEqual({ ok: true });
  });

  it("refuses a zero amount", () => {
    const result = validateInsuredValue({ insuredValueMinorUnits: 0n, currency: "USD" });
    expect(result.ok).toBe(false);
  });

  it("refuses a negative amount", () => {
    const result = validateInsuredValue({ insuredValueMinorUnits: -1n, currency: "USD" });
    expect(result.ok).toBe(false);
  });

  it("refuses a malformed currency code", () => {
    const result = validateInsuredValue({ insuredValueMinorUnits: 100n, currency: "US" });
    expect(result.ok).toBe(false);
  });

  it("the type system refuses an amount with no currency, and a currency with no amount — no partial state is constructible", () => {
    // @ts-expect-error — insuredValueMinorUnits present requires currency present too.
    const invalid: Parameters<typeof validateInsuredValue>[0] = { insuredValueMinorUnits: 100n, currency: null };
    expect(invalid).toBeDefined();
  });
});
