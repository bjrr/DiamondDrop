import { describe, expect, it } from "vitest";

import { validateWarrantyRemedyMoney } from "./remedy";

describe("validateWarrantyRemedyMoney — criterion 164 coherence", () => {
  it("accepts a refund remedy with a positive amount and currency", () => {
    expect(
      validateWarrantyRemedyMoney({ kind: "refund", refundAmountMinorUnits: 125_00n, currency: "USD" })
    ).toEqual({ ok: true });
  });

  it("refuses a refund remedy with no amount", () => {
    const result = validateWarrantyRemedyMoney({ kind: "refund", refundAmountMinorUnits: null, currency: "USD" });
    expect(result.ok).toBe(false);
  });

  it("refuses a refund remedy with no currency", () => {
    const result = validateWarrantyRemedyMoney({ kind: "refund", refundAmountMinorUnits: 100n, currency: null });
    expect(result.ok).toBe(false);
  });

  it("refuses a refund remedy with a zero amount", () => {
    const result = validateWarrantyRemedyMoney({ kind: "refund", refundAmountMinorUnits: 0n, currency: "USD" });
    expect(result.ok).toBe(false);
  });

  it("refuses a refund remedy with a negative amount", () => {
    const result = validateWarrantyRemedyMoney({ kind: "refund", refundAmountMinorUnits: -1n, currency: "USD" });
    expect(result.ok).toBe(false);
  });

  it("refuses a refund remedy with a malformed currency code", () => {
    const result = validateWarrantyRemedyMoney({ kind: "refund", refundAmountMinorUnits: 100n, currency: "US" });
    expect(result.ok).toBe(false);
  });

  it.each(["repair", "replacement", "other"] as const)("accepts a %s remedy with no money fields", (kind) => {
    expect(validateWarrantyRemedyMoney({ kind, refundAmountMinorUnits: null, currency: null })).toEqual({
      ok: true,
    });
  });

  it.each(["repair", "replacement", "other"] as const)(
    "refuses a %s remedy that carries refund money fields",
    (kind) => {
      const result = validateWarrantyRemedyMoney({ kind, refundAmountMinorUnits: 100n, currency: "USD" });
      expect(result.ok).toBe(false);
    }
  );
});
