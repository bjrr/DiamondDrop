import { describe, expect, it } from "vitest";

import {
  decideCancellationOrderCheckOutcome,
  verifyCancellationAcknowledgment,
  type CandidateCancellationAcknowledgment,
  type ExpectedCancellationAcknowledgmentContext,
} from "./cancellationOrderCheck";

const EXPECTED: ExpectedCancellationAcknowledgmentContext = {
  customerRef: "gid://shopify/Customer/111",
  campaignRef: "summer-2026",
  requiredText: "I understand the cancellation terms.",
  requiredLabel: "I Understand & Agree",
  requiredPolicySlug: "group-buy-cancellation-acknowledgment",
  requiredPolicyVersion: 1,
};

function validCandidate(overrides: Partial<CandidateCancellationAcknowledgment> = {}): CandidateCancellationAcknowledgment {
  return {
    id: "ack-1",
    exactText: EXPECTED.requiredText,
    affirmativeActionLabel: EXPECTED.requiredLabel,
    customerRef: EXPECTED.customerRef,
    campaignRef: EXPECTED.campaignRef,
    policyVersionSlug: EXPECTED.requiredPolicySlug,
    policyVersionVersion: EXPECTED.requiredPolicyVersion,
    ...overrides,
  };
}

describe("verifyCancellationAcknowledgment — reference is not proof", () => {
  it("matches when every field agrees with the current required context", () => {
    const result = verifyCancellationAcknowledgment(validCandidate(), EXPECTED);
    expect(result).toEqual({ outcome: "matched", matchedAcknowledgmentId: "ack-1", mismatchReason: null });
  });

  it("no candidate at all (missing/unparsable/unresolvable property) is unmatched", () => {
    const result = verifyCancellationAcknowledgment(null, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.matchedAcknowledgmentId).toBeNull();
    expect(result.mismatchReason).toBe("no_candidate");
  });

  it("THE COPIED CASE — a real, resolvable acknowledgment belonging to a DIFFERENT customer is unmatched, not treated as existing-therefore-valid", () => {
    const candidate = validCandidate({ customerRef: "gid://shopify/Customer/999" });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.matchedAcknowledgmentId).toBeNull();
    expect(result.mismatchReason).toBe("customer_mismatch");
  });

  it("THE COPIED CASE — the SAME customer's OWN acknowledgment from a DIFFERENT campaign is unmatched", () => {
    const candidate = validCandidate({ campaignRef: "different-campaign" });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("campaign_mismatch");
  });

  it("an acknowledgment with no customerRef at all (never should happen, but must still fail closed) is unmatched", () => {
    const candidate = validCandidate({ customerRef: null });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("customer_mismatch");
  });

  it("text that does not byte-match the CURRENT pinned copy is unmatched, even if everything else agrees", () => {
    const candidate = validCandidate({ exactText: "some other text" });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("text_mismatch");
  });

  it("a different affirmative-action label is unmatched", () => {
    const candidate = validCandidate({ affirmativeActionLabel: "I Certify & Agree" });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("label_mismatch");
  });

  it("a different policy slug entirely is unmatched", () => {
    const candidate = validCandidate({ policyVersionSlug: "rma-return-policy-acknowledgment" });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("policy_slug_mismatch");
  });

  it("THE STALE-VERSION CASE — the right slug, right text (today), but captured at a SUPERSEDED policy version is unmatched", () => {
    const candidate = validCandidate({ policyVersionVersion: 0 });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("policy_version_stale");
  });

  it("a newer policy version than currently required is ALSO unmatched — equality, not >=", () => {
    const candidate = validCandidate({ policyVersionVersion: 2 });
    const result = verifyCancellationAcknowledgment(candidate, EXPECTED);
    expect(result.outcome).toBe("unmatched");
    expect(result.mismatchReason).toBe("policy_version_stale");
  });
});

describe("decideCancellationOrderCheckOutcome — the schema-invariant mirror", () => {
  it("a non-null id decides matched", () => {
    expect(decideCancellationOrderCheckOutcome({ matchedAcknowledgmentId: "ack-1" })).toBe("matched");
  });

  it("a null id decides unmatched", () => {
    expect(decideCancellationOrderCheckOutcome({ matchedAcknowledgmentId: null })).toBe("unmatched");
  });
});
