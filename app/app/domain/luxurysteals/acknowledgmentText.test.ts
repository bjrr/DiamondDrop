import { describe, expect, it } from "vitest";

import {
  LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
  LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION,
  LUXURY_STEALS_ACKNOWLEDGMENT_TEXT,
} from "./acknowledgmentText";

/**
 * Criterion 134 / spec §13.2 — pinned character-for-character, same
 * discipline as `guaranteeCancellationEmail.test.ts`. A well-meaning tidy-up
 * (rewrapping, "fixing" punctuation, adding emphasis markup back in) must
 * fail this test rather than silently changing what the evidence record
 * says the customer agreed to.
 */
describe("Luxury Steals Final Sale acknowledgment — pinned copy", () => {
  it("is exactly the policy-approved text, character-for-character", () => {
    expect(LUXURY_STEALS_ACKNOWLEDGMENT_TEXT).toBe(
      "FINAL SALE ACKNOWLEDGMENT\n\n" +
        "I understand that this item is a Luxury Steal and is FINAL SALE. I understand that it cannot be returned or exchanged because I change my mind, prefer another style, select the wrong size or configuration, or otherwise no longer want the item. I have reviewed the item specifications and selected options before purchasing."
    );
  });

  it("contains no markdown emphasis markers — the words are pinned, not the source document's formatting", () => {
    expect(LUXURY_STEALS_ACKNOWLEDGMENT_TEXT).not.toContain("*");
  });

  it("the affirmative action label is exactly 'I Understand & Agree'", () => {
    expect(LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL).toBe("I Understand & Agree");
  });

  it("names a policy slug and a positive integer version for evidence rows to reference", () => {
    expect(LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG).toBe("luxury-steals-final-sale-acknowledgment");
    expect(Number.isInteger(LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION)).toBe(true);
    expect(LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION).toBeGreaterThan(0);
  });
});
