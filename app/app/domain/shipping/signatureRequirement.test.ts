import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";

import {
  STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD,
  UnsupportedSignatureThresholdCurrencyError,
  decideStandardSignatureRequirementByRule,
  isSignatureServiceUsed,
  resolveShipmentSignatureRequirement,
  SIGNATURE_SERVICES_USED,
  type StaffSignatureOverride,
} from "./signatureRequirement";

describe("STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD — D31, the one place $100.00 lives", () => {
  it("is exactly $100.00 in USD minor units", () => {
    expect(STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD.amountMinorUnits).toBe(10000n);
    expect(STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD.currency).toBe("USD");
  });
});

describe("decideStandardSignatureRequirementByRule — D31 boundary, exact", () => {
  it("$99.99 does not require a signature", () => {
    const result = decideStandardSignatureRequirementByRule(Money.fromMinorUnits(9999n, "USD"));
    expect(result.required).toBe(false);
  });

  it("$100.00 exactly does not require a signature — the boundary is > not >=", () => {
    const result = decideStandardSignatureRequirementByRule(Money.fromMinorUnits(10000n, "USD"));
    expect(result.required).toBe(false);
  });

  it("$100.01 requires a signature", () => {
    const result = decideStandardSignatureRequirementByRule(Money.fromMinorUnits(10001n, "USD"));
    expect(result.required).toBe(true);
  });

  it("$0.00 does not require a signature", () => {
    const result = decideStandardSignatureRequirementByRule(Money.fromMinorUnits(0n, "USD"));
    expect(result.required).toBe(false);
  });

  it("a very high merchandise value still requires only STANDARD, never adult-signature, from the rule alone", () => {
    const result = decideStandardSignatureRequirementByRule(Money.fromMinorUnits(50_000_00n, "USD"));
    expect(result.required).toBe(true);
    // The rule's own type has no field for "adult" — it cannot produce one.
    expect(Object.keys(result)).toEqual(["required"]);
  });

  it("refuses a non-USD merchandise value rather than inventing a conversion", () => {
    expect(() => decideStandardSignatureRequirementByRule(Money.fromMinorUnits(10001n, "EUR"))).toThrow(
      UnsupportedSignatureThresholdCurrencyError
    );
  });
});

describe("resolveShipmentSignatureRequirement — rule vs. a recorded override, never collapsed", () => {
  it("with no override, the result mirrors the rule and is sourced 'rule'", () => {
    const result = resolveShipmentSignatureRequirement({ required: false }, null);
    expect(result).toEqual({ ok: true, value: { required: false, source: "rule", override: null } });
  });

  it("with no override, a rule-required shipment stays required, sourced 'rule'", () => {
    const result = resolveShipmentSignatureRequirement({ required: true }, null);
    expect(result).toEqual({ ok: true, value: { required: true, source: "rule", override: null } });
  });

  it("a well-formed override always wins, regardless of what the rule said, sourced 'staff_override'", () => {
    const override: StaffSignatureOverride = {
      overriddenByActorRef: "staff:1",
      overriddenAt: new Date("2026-09-25T00:00:00Z"),
      reason: "high-risk delivery address",
    };
    const result = resolveShipmentSignatureRequirement({ required: false }, override);
    expect(result).toEqual({
      ok: true,
      value: { required: true, source: "staff_override", override },
    });
  });

  it("the override is retained on the result, distinguishable from the rule firing on its own", () => {
    const override: StaffSignatureOverride = { overriddenByActorRef: "staff:2", overriddenAt: new Date() };
    const result = resolveShipmentSignatureRequirement({ required: true }, override);
    expect(result.ok && result.value.source).toBe("staff_override");
    expect(result.ok && result.value.override).toEqual(override);
  });

  it("refuses an override with no recorded actor", () => {
    const override: StaffSignatureOverride = { overriddenByActorRef: "   ", overriddenAt: new Date() };
    const result = resolveShipmentSignatureRequirement({ required: false }, override);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("who required it") });
  });

  it("refuses an override with an invalid timestamp", () => {
    const override: StaffSignatureOverride = { overriddenByActorRef: "staff:1", overriddenAt: new Date("not-a-date") };
    const result = resolveShipmentSignatureRequirement({ required: false }, override);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("valid timestamp") });
  });

  it("an override cannot waive a requirement — there is no field or code path that produces required: false from an override", () => {
    // Structural: StaffSignatureOverride carries no "required" field at all,
    // so a caller cannot construct an override that waives the rule — the
    // only value resolveShipmentSignatureRequirement ever produces for a
    // non-null override is required: true.
    const override: StaffSignatureOverride = { overriddenByActorRef: "staff:1", overriddenAt: new Date() };
    expect(Object.keys(override)).not.toContain("required");
    const result = resolveShipmentSignatureRequirement({ required: true }, override);
    expect(result.ok && result.value.required).toBe(true);
  });
});

describe("SignatureServiceUsed — evidence of what happened, a closed set with no derivation", () => {
  it("recognises exactly the three services", () => {
    expect(SIGNATURE_SERVICES_USED).toEqual(["none", "standard", "adult_signature_required"]);
  });

  it.each(SIGNATURE_SERVICES_USED)("isSignatureServiceUsed recognises %s", (service) => {
    expect(isSignatureServiceUsed(service)).toBe(true);
  });

  it("rejects an unrecognised value", () => {
    expect(isSignatureServiceUsed("expedited")).toBe(false);
  });
});
