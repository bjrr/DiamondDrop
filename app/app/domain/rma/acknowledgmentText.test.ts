import { describe, expect, it } from "vitest";

import {
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG,
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION,
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT,
} from "./acknowledgmentText";

/**
 * Criterion 180 — pinned character-for-character, same discipline as
 * `warranty/acknowledgmentText.test.ts` and
 * `luxurysteals/acknowledgmentText.test.ts`. A well-meaning tidy-up
 * (rewrapping, "fixing" punctuation) must fail this test rather than
 * silently changing what the evidence record says the customer agreed to —
 * the owner wrote this text themselves (approved 2026-09-26).
 */
describe("RMA return-policy acknowledgment — pinned copy", () => {
  it("is exactly the owner-approved text, character-for-character", () => {
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT).toBe(
      "I certify that the information I provided is accurate. I understand that submitting an RMA request does not approve a return. " +
        "I will not send the item until CaratForUs approves the return and provides an RMA number and return instructions. " +
        "I understand that I am responsible for tracked, appropriately insured return shipping, and that any refund or merchandise credit is subject to the applicable return window, timely receipt, and inspection of the returned item."
    );
  });

  it("is one paragraph (no internal newlines) and ends exactly as approved", () => {
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT).not.toContain("\n");
    expect(
      RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT.endsWith(
        "and that any refund or merchandise credit is subject to the applicable return window, timely receipt, and inspection of the returned item."
      )
    ).toBe(true);
  });

  it("does not restate condition/personalization/outbound-shipping terms — those are disclosed on the form, not folded into the checkbox (see this file's header)", () => {
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT.toLowerCase()).not.toContain("personaliz");
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT.toLowerCase()).not.toContain("unworn");
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT.toLowerCase()).not.toContain("expedited");
  });

  it("the affirmative action label is exactly 'I Certify & Agree' — same family as the warranty claim's label, by owner choice", () => {
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL).toBe("I Certify & Agree");
  });

  it("names a policy slug and a positive integer version for evidence rows to reference", () => {
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG).toBe("rma-return-policy-acknowledgment");
    expect(Number.isInteger(RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION)).toBe(true);
    expect(RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION).toBeGreaterThan(0);
  });
});
