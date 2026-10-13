import { describe, expect, it } from "vitest";

import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
  CUSTOM_JEWELRY_DEPOSIT_CURRENCY,
  CUSTOM_JEWELRY_DEPOSIT_NON_REFUND_CONDITION_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
  CUSTOM_JEWELRY_DEPOSIT_POLICY_VERSION,
  CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT,
} from "./designDepositAcknowledgmentText";
import { CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE } from "./intakeCopy";

/**
 * This is the text a customer agrees to before $49 is charged. A failure here
 * is not a bug to be fixed by updating the expectation.
 */

describe("the four required disclosures are all present", () => {
  // The owner required four things displayed before the deposit is charged.
  // Asserted individually so a partial regression names which one went
  // missing, rather than one long string comparison that only says "changed".
  it("1. the $49 amount", () => {
    expect(CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT).toContain("$49 Design Deposit");
    expect(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT).toContain("$49 Design Deposit");
  });

  it("2. that it is credited toward the final price", () => {
    expect(CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT).toContain("credited toward your final price");
    expect(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT).toContain("credited toward my final price");
  });

  it("3. that it is refunded if CaratForUs completes the agreed design stage and the customer declines", () => {
    expect(CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT).toContain(
      "If CaratForUs completes the agreed design stage and you decide not to proceed, the $49 deposit is refunded"
    );
    expect(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT).toContain(
      "refunded if CaratForUs completes the agreed design stage and I decide not to proceed"
    );
  });

  it("4. that a refund is NOT automatic on abandonment or non-response", () => {
    expect(CUSTOM_JEWELRY_DEPOSIT_NON_REFUND_CONDITION_TEXT).toBe(
      "A refund is not automatic if you abandon the project or stop responding before the agreed design stage is completed."
    );
    expect(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT).toContain(
      "a refund is not automatic if I abandon the project or stop responding before the agreed design stage is completed"
    );
  });
});

describe("the re-shown terms are the owner-approved intake disclosure, not a second wording of it", () => {
  it("is byte-identical to the intake constant", () => {
    // The customer saw this exact wording on the enquiry form. A second copy
    // on the step where money is charged is where drift does most damage, so
    // it is imported rather than restated — and this asserts that it is.
    expect(CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT).toBe(CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE);
  });
});

describe("the fourth disclosure adds no policy the owner did not state", () => {
  it("invents no grace period, cure window, or definition of non-response", () => {
    // The owner gave the rule's substance and nothing more. A "14 days" or a
    // "reasonable attempts to contact you" here would be new policy smuggled
    // into an acknowledgment — the customer would be agreeing to a term
    // nobody approved.
    const both = `${CUSTOM_JEWELRY_DEPOSIT_NON_REFUND_CONDITION_TEXT} ${CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT}`.toLowerCase();
    for (const invented of [
      "grace period",
      "cure",
      "reasonable attempt",
      "three attempts",
      "two attempts",
      "day period",
      "calendar day",
      "business day",
      "forfeit",
      "non-refundable",
      "nonrefundable",
    ]) {
      expect(both, `the deposit copy introduces "${invented}", which the owner did not state`).not.toContain(invented);
    }
    expect(/\b\d+\s*(day|week|month)/.test(both), "the deposit copy introduces a time limit").toBe(false);
  });

  it("states BOTH conditions, so neither can be read alone", () => {
    // The refund condition alone is a promise; the abandonment rule alone is
    // a threat. They ship together, in the order the owner stated them.
    const refundAt = CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT.indexOf("is refunded if CaratForUs completes");
    const notAutomaticAt = CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT.indexOf("a refund is not automatic");
    expect(refundAt).toBeGreaterThan(-1);
    expect(notAutomaticAt).toBeGreaterThan(-1);
    expect(refundAt).toBeLessThan(notAutomaticAt);
  });
});

describe("no surface here promises a response time", () => {
  it.each([
    ["terms", CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT],
    ["non-refund condition", CUSTOM_JEWELRY_DEPOSIT_NON_REFUND_CONDITION_TEXT],
    ["acknowledgment", CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT],
  ])("%s carries no turnaround language", (_label, text) => {
    const lowered = text.toLowerCase();
    for (const promise of ["shortly", "as soon as possible", "promptly", "right away", "immediately"]) {
      expect(lowered).not.toContain(promise);
    }
    expect(lowered).not.toMatch(/within \d+/);
  });
});

describe("the amount and the sentence are pinned to each other", () => {
  it("$49 in the copy means 4900 minor units in the charge", () => {
    // THE WORST FAILURE THIS SURFACE CAN HAVE is a disclosure saying $49
    // beside a charge of something else. So the number is derived from the
    // constant and compared against the words, rather than each being
    // maintained independently and trusted to agree.
    expect(CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS).toBe(4900n);
    expect(CUSTOM_JEWELRY_DEPOSIT_CURRENCY).toBe("USD");

    const dollars = CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS / 100n;
    const cents = CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS % 100n;
    expect(cents, "a deposit with trailing cents would not match the wording '$49'").toBe(0n);
    expect(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT).toContain(`$${dollars}`);
    expect(CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT).toContain(`$${dollars}`);
    expect(CUSTOM_JEWELRY_DEPOSIT_NON_REFUND_CONDITION_TEXT).not.toContain("$");
  });

  it("uses integer minor units, never a float", () => {
    expect(typeof CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS).toBe("bigint");
  });
});

describe("the affirmative action label is evidence", () => {
  it("is the approved caption and reads as part of the family", () => {
    // It records what the customer actually clicked, so the storefront must
    // render THIS constant. "Authorize" rather than warranty's "Certify"
    // because the customer is permitting a charge, not attesting to facts.
    expect(CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL).toBe("I Authorize & Agree");
    expect(CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL).toContain("&");
  });

  it("is not a sentence — a button caption that scrolls is not a button", () => {
    expect(CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL.length).toBeLessThan(40);
    expect(CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL).not.toContain(".");
  });
});

describe("policy versioning", () => {
  it("names the policy and the version provisioned with this text", () => {
    // Shared with the provisioning migration so both sides name the same
    // policy by construction. A wording change must add version 2 via a NEW
    // migration and bump this — never edit the string in place, or the
    // evidence rows would point at text that is no longer what was shown.
    expect(CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG).toBe("custom-jewelry-design-deposit");
    expect(CUSTOM_JEWELRY_DEPOSIT_POLICY_VERSION).toBe(1);
  });
});
