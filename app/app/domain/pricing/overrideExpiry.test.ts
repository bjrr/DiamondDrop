import { describe, expect, it } from "vitest";

import { OverrideExpiryCurrencyMismatchError, decideOverrideExpiry } from "./overrideExpiry";

/**
 * Owner §2.4, spec criteria 15/16, definition locked at §13.1/§16.1 of
 * docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md. See the module doc
 * comment for the full rule text.
 */

function base() {
  return {
    neverExpire: false,
    departedFromBankPaymentPriceMinorUnits: 40_000n,
    departedFromCurrency: "USD",
    recalculatedBankPaymentPriceMinorUnits: 40_000n,
    recalculatedCurrency: "USD",
  };
}

describe("decideOverrideExpiry — the daily no-change trap", () => {
  it("does NOT expire when the recalculation reproduces the exact same price", () => {
    // This is the case the owner was specifically asked to confirm rather
    // than have assumed: if this were treated as material, every override
    // would die within 24 hours to the next scheduled (D15) run.
    const decision = decideOverrideExpiry(base());

    expect(decision.expires).toBe(false);
    expect(decision.reason).toMatch(/immaterial/);
  });

  it("does NOT expire across repeated identical recalculations either", () => {
    const input = base();
    for (let i = 0; i < 5; i++) {
      expect(decideOverrideExpiry(input).expires).toBe(false);
    }
  });
});

describe("decideOverrideExpiry — materiality", () => {
  it("expires when the recalculation produces a HIGHER price", () => {
    const decision = decideOverrideExpiry({
      ...base(),
      recalculatedBankPaymentPriceMinorUnits: 41_000n,
    });

    expect(decision.expires).toBe(true);
    expect(decision.reason).toMatch(/material/);
    expect(decision.reason).toMatch(/40000/);
    expect(decision.reason).toMatch(/41000/);
  });

  it("expires when the recalculation produces a LOWER price", () => {
    // Symmetric on purpose — a price drop is just as material as a rise; the
    // definition says "differs", not "increases".
    const decision = decideOverrideExpiry({
      ...base(),
      recalculatedBankPaymentPriceMinorUnits: 39_000n,
    });

    expect(decision.expires).toBe(true);
  });

  it("expires on a difference of a single minor unit", () => {
    const decision = decideOverrideExpiry({
      ...base(),
      recalculatedBankPaymentPriceMinorUnits: 40_001n,
    });

    expect(decision.expires).toBe(true);
  });
});

describe("decideOverrideExpiry — neverExpire (owner's escape hatch)", () => {
  it("does NOT expire even when the price materially changed", () => {
    const decision = decideOverrideExpiry({
      ...base(),
      neverExpire: true,
      recalculatedBankPaymentPriceMinorUnits: 999_999n,
    });

    expect(decision.expires).toBe(false);
    expect(decision.reason).toMatch(/neverExpire/);
  });

  it("is checked ahead of the price comparison — the reason names the escape hatch, not immateriality", () => {
    const decision = decideOverrideExpiry({ ...base(), neverExpire: true });

    expect(decision.reason).toMatch(/neverExpire/);
    expect(decision.reason).not.toMatch(/immaterial/);
  });
});

describe("decideOverrideExpiry — currency safety", () => {
  it("refuses to compare prices across different currencies", () => {
    expect(() =>
      decideOverrideExpiry({ ...base(), recalculatedCurrency: "EUR" })
    ).toThrow(OverrideExpiryCurrencyMismatchError);
  });

  it("names both currencies in the error", () => {
    try {
      decideOverrideExpiry({ ...base(), departedFromCurrency: "USD", recalculatedCurrency: "EUR" });
      expect.fail("expected OverrideExpiryCurrencyMismatchError");
    } catch (error) {
      expect(error).toBeInstanceOf(OverrideExpiryCurrencyMismatchError);
      expect((error as OverrideExpiryCurrencyMismatchError).departedFromCurrency).toBe("USD");
      expect((error as OverrideExpiryCurrencyMismatchError).recalculatedCurrency).toBe("EUR");
    }
  });

  it("checks currency BEFORE neverExpire, so a bad call never silently short-circuits", () => {
    expect(() =>
      decideOverrideExpiry({ ...base(), neverExpire: true, recalculatedCurrency: "EUR" })
    ).toThrow(OverrideExpiryCurrencyMismatchError);
  });
});
