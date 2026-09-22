import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";

import {
  BANK_PAYMENT_METHODS,
  chargedUnitPriceMinorUnits,
  classifyBankPaymentOrderState,
  compareReceivedToExpected,
  computeExpectedTotal,
  isBankPaymentMethod,
  parseVerificationFormData,
  validateVerificationSubmission,
  type RawVerificationSubmission,
} from "./verification";

/**
 * Pure-function table tests for the phase 2C-c verification decision layer
 * (spec §5.4/§14/§19 criteria 87-88, 103-104, 112-124). See
 * `verification.server.ts`'s own tests for the database/Shopify-facing half,
 * including D24's amount-mismatch refusal and D25's completion recovery.
 */

function raw(overrides: Partial<RawVerificationSubmission> = {}): RawVerificationSubmission {
  return {
    // Dollars and cents, as it appears on a bank statement — NOT minor units.
    amountReceived: "1500.00",
    currency: "usd",
    method: "zelle",
    reference: "REF-123",
    ...overrides,
  };
}

describe("BANK_PAYMENT_METHODS / isBankPaymentMethod", () => {
  it("is exactly the four electronic methods CLAUDE.md #14 makes eligible — no cheque, money order or other paper", () => {
    expect(BANK_PAYMENT_METHODS).toEqual(["zelle", "ach", "bank_transfer", "wire"]);
  });

  it.each(["zelle", "ach", "bank_transfer", "wire"])("accepts %s", (method) => {
    expect(isBankPaymentMethod(method)).toBe(true);
  });

  it.each(["check", "cashiers_check", "money_order", "cash", "", "ZELLE"])("rejects %s", (method) => {
    expect(isBankPaymentMethod(method)).toBe(false);
  });
});

describe("validateVerificationSubmission", () => {
  it("accepts a fully populated submission, normalizing currency case and trimming whitespace", () => {
    const result = validateVerificationSubmission(raw({ currency: " usd ", reference: "  REF-123  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({
      amountReceivedMinorUnits: 150000n,
      currency: "USD",
      method: "zelle",
      reference: "REF-123",
    });
  });

  it("accepts a blank reference as null — §8.7 'where available' is the one field allowed to stay blank", () => {
    const result = validateVerificationSubmission(raw({ reference: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.reference).toBeNull();
  });

  it("accepts a whitespace-only reference as null", () => {
    const result = validateVerificationSubmission(raw({ reference: "   " }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.reference).toBeNull();
  });

  it("refuses a missing amount", () => {
    const result = validateVerificationSubmission(raw({ amountReceived: null }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.errors).toEqual([{ field: "amountReceived", message: expect.stringContaining("required") }]);
  });

  it("refuses a zero amount", () => {
    const result = validateVerificationSubmission(raw({ amountReceived: "0" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.errors[0]?.field).toBe("amountReceived");
  });

  it("refuses a negative amount", () => {
    const result = validateVerificationSubmission(raw({ amountReceived: "-500" }));
    expect(result.ok).toBe(false);
  });

  it.each([
    ["1500", 150_000n],
    ["1500.00", 150_000n],
    ["1500.5", 150_050n],
    ["1500.55", 150_055n],
    ["0.01", 1n],
  ])("reads %s as the dollars-and-cents amount a statement would show", (typed, expected) => {
    const result = validateVerificationSubmission(raw({ amountReceived: typed }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.amountReceivedMinorUnits).toBe(expected);
  });

  /**
   * REFUSED, NOT ROUNDED. Every other decimal in this codebase is a computed
   * figure passed through a rounding rule. This one is a reported fact about
   * money that arrived, so a third decimal place means the person typing it
   * has something we cannot faithfully record — sending it back is the only
   * honest answer. Rounding would write down a receipt nobody observed.
   */
  it.each(["1500.005", "1500.123", "1e3", "1,500.00", "$1500", "-15", " 15 00 "])(
    "refuses %s rather than guessing what was meant",
    (typed) => {
      const result = validateVerificationSubmission(raw({ amountReceived: typed }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.errors.some((e) => e.field === "amountReceived")).toBe(true);
    }
  );

  it("refuses a currency-symbol amount", () => {
    const result = validateVerificationSubmission(raw({ amountReceived: "$1500" }));
    expect(result.ok).toBe(false);
  });

  it("refuses a missing currency", () => {
    const result = validateVerificationSubmission(raw({ currency: null }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.errors.some((e) => e.field === "currency")).toBe(true);
  });

  it("refuses a malformed currency", () => {
    const result = validateVerificationSubmission(raw({ currency: "US" }));
    expect(result.ok).toBe(false);
  });

  it("refuses a missing method", () => {
    const result = validateVerificationSubmission(raw({ method: null }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.errors.some((e) => e.field === "method")).toBe(true);
  });

  it("refuses a method outside the closed enum — e.g. a paper instrument CLAUDE.md #14 excludes", () => {
    const result = validateVerificationSubmission(raw({ method: "check" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.errors.some((e) => e.field === "method")).toBe(true);
  });

  it("has no verifying-admin field to validate — D23 removed it; the identity comes from the authenticated session, not this form", () => {
    const result = validateVerificationSubmission(raw());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).not.toHaveProperty("verifiedBy");
  });

  it("collects every field error at once rather than stopping at the first", () => {
    const result = validateVerificationSubmission({
      amountReceived: null,
      currency: null,
      method: null,
      reference: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.errors.map((e) => e.field).sort()).toEqual(["amountReceived", "currency", "method"]);
  });
});

describe("chargedUnitPriceMinorUnits / computeExpectedTotal", () => {
  it("charges the Bank Payment Price for an eligible-at-quote-time line", () => {
    expect(
      chargedUnitPriceMinorUnits({
        quantity: 1,
        eligibleAtQuoteTime: true,
        quotedBankPaymentPriceMinorUnits: 100_000n,
        quotedRegularCardPriceMinorUnits: 105_000n,
      })
    ).toBe(100_000n);
  });

  it("charges the Regular/Card Price for a line that was ineligible at quote time", () => {
    expect(
      chargedUnitPriceMinorUnits({
        quantity: 1,
        eligibleAtQuoteTime: false,
        quotedBankPaymentPriceMinorUnits: 100_000n,
        quotedRegularCardPriceMinorUnits: 105_000n,
      })
    ).toBe(105_000n);
  });

  it("sums charged unit price × quantity across every line", () => {
    const total = computeExpectedTotal(
      [
        { quantity: 2, eligibleAtQuoteTime: true, quotedBankPaymentPriceMinorUnits: 100_000n, quotedRegularCardPriceMinorUnits: 105_000n },
        { quantity: 1, eligibleAtQuoteTime: false, quotedBankPaymentPriceMinorUnits: 50_000n, quotedRegularCardPriceMinorUnits: 52_500n },
      ],
      "USD"
    );
    // (100_000 * 2) + (52_500 * 1) = 252_500
    expect(total.equals(Money.fromMinorUnits(252_500n, "USD"))).toBe(true);
  });

  it("returns zero for no lines", () => {
    expect(computeExpectedTotal([], "USD").isZero()).toBe(true);
  });
});

describe("compareReceivedToExpected", () => {
  it("reports an exact match", () => {
    const result = compareReceivedToExpected(Money.fromMinorUnits(150_000n, "USD"), Money.fromMinorUnits(150_000n, "USD"));
    expect(result).toMatchObject({ currencyMismatch: false, differenceMinorUnits: 0n, matchesExactly: true });
  });

  it("reports a positive difference for an overpayment, and never blocks on it", () => {
    const result = compareReceivedToExpected(Money.fromMinorUnits(150_000n, "USD"), Money.fromMinorUnits(150_500n, "USD"));
    expect(result).toMatchObject({ currencyMismatch: false, differenceMinorUnits: 500n, matchesExactly: false });
  });

  it("reports a negative difference for an underpayment, and never blocks on it", () => {
    const result = compareReceivedToExpected(Money.fromMinorUnits(150_000n, "USD"), Money.fromMinorUnits(149_000n, "USD"));
    expect(result).toMatchObject({ currencyMismatch: false, differenceMinorUnits: -1000n, matchesExactly: false });
  });

  it("flags a currency mismatch instead of computing a meaningless numeric difference", () => {
    const result = compareReceivedToExpected(Money.fromMinorUnits(150_000n, "USD"), Money.fromMinorUnits(150_000n, "EUR"));
    expect(result).toMatchObject({ currencyMismatch: true, differenceMinorUnits: null, matchesExactly: false });
  });
});

describe("parseVerificationFormData", () => {
  function formData(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) fd.set(key, value);
    return fd;
  }

  it("extracts all four fields by name", () => {
    const result = parseVerificationFormData(
      formData({
        amountReceived: "150000",
        currency: "USD",
        method: "zelle",
        reference: "REF-1",
      })
    );
    expect(result).toEqual<RawVerificationSubmission>({
      amountReceived: "150000",
      currency: "USD",
      method: "zelle",
      reference: "REF-1",
    });
  });

  it("reports a missing field as null, not undefined or empty string, so validation's own 'required' message applies uniformly", () => {
    const fd = new FormData();
    fd.set("amountReceived", "150000");
    // currency, method, reference all omitted.
    const result = parseVerificationFormData(fd);
    expect(result.amountReceived).toBe("150000");
    expect(result.currency).toBeNull();
    expect(result.method).toBeNull();
    expect(result.reference).toBeNull();
  });

  it("treats a File value (a mistyped or hijacked field) as absent rather than throwing", () => {
    const fd = new FormData();
    fd.set("amountReceived", new Blob(["not a number"]), "amountReceived.txt");
    const result = parseVerificationFormData(fd);
    expect(result.amountReceived).toBeNull();
  });

  it("round-trips into validateVerificationSubmission and is refused when required fields are missing", () => {
    const fd = new FormData();
    fd.set("amountReceived", "150000");
    const result = validateVerificationSubmission(parseVerificationFormData(fd));
    expect(result.ok).toBe(false);
  });
});

describe("classifyBankPaymentOrderState — D25, criteria 118-119", () => {
  it("is unverified when open and never verified", () => {
    expect(classifyBankPaymentOrderState({ status: "open", verifiedAt: null })).toBe("unverified");
  });

  it("is verified_pending_completion when open AND verified — the recovery state, never re-shown the form", () => {
    expect(classifyBankPaymentOrderState({ status: "open", verifiedAt: new Date() })).toBe(
      "verified_pending_completion"
    );
  });

  it("is completed once status says so, regardless of verifiedAt", () => {
    expect(classifyBankPaymentOrderState({ status: "completed", verifiedAt: new Date() })).toBe("completed");
  });

  it("is cancelled once status says so, even if it was verified before being cancelled", () => {
    expect(classifyBankPaymentOrderState({ status: "cancelled", verifiedAt: new Date() })).toBe("cancelled");
  });

  it("is cancelled when status says so and it was never verified", () => {
    expect(classifyBankPaymentOrderState({ status: "cancelled", verifiedAt: null })).toBe("cancelled");
  });
});
