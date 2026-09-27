import { describe, expect, it } from "vitest";

import { validatePurchasedCoverage } from "./purchasedCoverage";
import { JEWELERS_MUTUAL_PROVIDER_ID } from "./providers/jewelersMutual";

function coverage(overrides: Partial<Parameters<typeof validatePurchasedCoverage>[0]> = {}) {
  return {
    providerId: JEWELERS_MUTUAL_PROVIDER_ID,
    policyOrCertificateReference: "JM-CERT-12345",
    coveredValueMinorUnits: 500_000_00n,
    coveredValueCurrency: "USD",
    ...overrides,
  };
}

describe("validatePurchasedCoverage — provider + money, composed and never re-derived", () => {
  it("accepts a well-formed purchase from a registered provider", () => {
    expect(validatePurchasedCoverage(coverage())).toEqual({ ok: true });
  });

  it("refuses an unrecognized provider before checking anything else", () => {
    const result = validatePurchasedCoverage(coverage({ providerId: "acme_insurance" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a recognized insurance provider/);
  });

  it("refuses a blank reference — delegated to the provider adapter, not reimplemented here", () => {
    const result = validatePurchasedCoverage(coverage({ policyOrCertificateReference: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/reference is required/);
  });

  it("refuses a zero covered value — delegated to validateInsuredValue, not reimplemented here", () => {
    const result = validatePurchasedCoverage(coverage({ coveredValueMinorUnits: 0n }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/positive/);
  });

  it("refuses a negative covered value", () => {
    const result = validatePurchasedCoverage(coverage({ coveredValueMinorUnits: -1n }));
    expect(result.ok).toBe(false);
  });

  it("refuses a malformed currency code", () => {
    const result = validatePurchasedCoverage(coverage({ coveredValueCurrency: "US" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ISO-4217/);
  });

  it("does not enforce the covered value equals any particular figure — D30/G2 is still open", () => {
    // An arbitrarily large or small (but positive) covered value is accepted;
    // this module has no opinion on whether it equals a shipment's computed
    // merchandise value.
    expect(validatePurchasedCoverage(coverage({ coveredValueMinorUnits: 1n })).ok).toBe(true);
    expect(validatePurchasedCoverage(coverage({ coveredValueMinorUnits: 999_999_999_00n })).ok).toBe(true);
  });
});
