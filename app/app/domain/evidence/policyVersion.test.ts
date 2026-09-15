import { describe, expect, it } from "vitest";

import { buildPolicyVersionRecord, InvalidPolicyVersionError } from "./policyVersion";

describe("buildPolicyVersionRecord", () => {
  it("computes a content hash derived from the exact text", () => {
    const record = buildPolicyVersionRecord({
      slug: "luxury-steals-final-sale",
      version: 1,
      effectiveFrom: new Date("2026-01-01"),
      text: "All Luxury Steals purchases are Final Sale.",
    });
    expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes identical text identically across different slugs/versions", () => {
    const a = buildPolicyVersionRecord({
      slug: "policy-a",
      version: 1,
      effectiveFrom: new Date(),
      text: "Same text",
    });
    const b = buildPolicyVersionRecord({
      slug: "policy-b",
      version: 7,
      effectiveFrom: new Date(),
      text: "Same text",
    });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("rejects missing required fields", () => {
    expect(() => buildPolicyVersionRecord({ slug: "", version: 1, effectiveFrom: new Date(), text: "x" })).toThrow(
      InvalidPolicyVersionError
    );
    expect(() =>
      buildPolicyVersionRecord({ slug: "a", version: 1, effectiveFrom: new Date(), text: "" })
    ).toThrow(InvalidPolicyVersionError);
  });

  it("rejects a non-positive or non-integer version", () => {
    expect(() =>
      buildPolicyVersionRecord({ slug: "a", version: 0, effectiveFrom: new Date(), text: "x" })
    ).toThrow(InvalidPolicyVersionError);
    expect(() =>
      buildPolicyVersionRecord({ slug: "a", version: 1.5, effectiveFrom: new Date(), text: "x" })
    ).toThrow(InvalidPolicyVersionError);
  });
});
