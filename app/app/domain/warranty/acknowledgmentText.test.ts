import { describe, expect, it } from "vitest";

import {
  WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
} from "./acknowledgmentText";

/**
 * Criterion 154 — pinned character-for-character, same discipline as
 * `luxurysteals/acknowledgmentText.test.ts`. A well-meaning tidy-up
 * (rewrapping, "fixing" punctuation) must fail this test rather than
 * silently changing what the evidence record says the customer agreed to.
 */
describe("Warranty Claim acknowledgment — pinned copy", () => {
  it("is exactly the owner-approved text, character-for-character", () => {
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT).toBe(
      "I certify that the information and files I submitted are accurate to the best of my knowledge. " +
        "I understand that submitting this claim does not establish warranty coverage. " +
        "I will not send my jewelry until CaratForUs authorizes an inspection and provides shipping instructions. " +
        "If inspection is authorized, I am responsible for tracked and appropriately insured shipping to CaratForUs. " +
        "Coverage and any remedy will be determined after CaratForUs reviews the claim and, when applicable, inspects the item."
    );
  });

  it("is one paragraph (no internal newlines) and ends exactly as approved", () => {
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT).not.toContain("\n");
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT.endsWith("Coverage and any remedy will be determined after CaratForUs reviews the claim and, when applicable, inspects the item.")).toBe(true);
  });

  it("uses US spelling 'jewelry', as approved — not 'jewellery'", () => {
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT).toContain("jewelry");
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT).not.toContain("jewellery");
  });

  it("the affirmative action label is exactly 'I Certify & Agree' — ampersand, not 'and', matching Final Sale's family of labels", () => {
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL).toBe("I Certify & Agree");
  });

  it("names a policy slug and a positive integer version for evidence rows to reference", () => {
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG).toBe("warranty-claim-acknowledgment");
    expect(Number.isInteger(WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION)).toBe(true);
    expect(WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION).toBeGreaterThan(0);
  });
});
