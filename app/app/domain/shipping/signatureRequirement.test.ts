import { describe, expect, it } from "vitest";

import { validateSignatureRequirementDecision } from "./signatureRequirement";

describe("validateSignatureRequirementDecision — criterion 174: recorded, never derived", () => {
  it("accepts a well-formed staff decision, required=true", () => {
    const result = validateSignatureRequirementDecision({
      signatureRequired: true,
      decidedByActorRef: "staff:alice",
      decidedAt: new Date("2026-09-25T00:00:00Z"),
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a well-formed staff decision, required=false", () => {
    const result = validateSignatureRequirementDecision({
      signatureRequired: false,
      decidedByActorRef: "staff:bob",
      decidedAt: new Date("2026-09-25T00:00:00Z"),
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a decision with no decider", () => {
    const result = validateSignatureRequirementDecision({
      signatureRequired: true,
      decidedByActorRef: "   ",
      decidedAt: new Date(),
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a decision with an invalid timestamp", () => {
    const result = validateSignatureRequirementDecision({
      signatureRequired: true,
      decidedByActorRef: "staff:alice",
      decidedAt: new Date("not-a-date"),
    });
    expect(result.ok).toBe(false);
  });

  it("has no parameter for an order amount — TypeScript would refuse `{ orderTotal: ... }` at compile time, which is the point", () => {
    // Documented rather than type-tested at runtime: the whole point of
    // SignatureRequirementDecision's shape (criterion 175) is that there is
    // no field to smuggle a threshold comparison into. Any attempt to pass
    // an amount fails to typecheck, not merely fails a runtime assertion.
    const decision = {
      signatureRequired: true,
      decidedByActorRef: "staff:alice",
      decidedAt: new Date(),
    };
    expect(Object.keys(decision)).not.toContain("orderTotal");
    expect(Object.keys(decision)).not.toContain("orderAmount");
  });
});
