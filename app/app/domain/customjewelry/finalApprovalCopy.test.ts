import { describe, expect, it } from "vitest";

import { CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS } from "./designDepositAcknowledgmentText";
import {
  CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
  CUSTOM_JEWELRY_FINAL_SALE_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_SALE_POLICY_VERSION,
  CUSTOM_JEWELRY_FINAL_SALE_TEXT,
  CUSTOM_JEWELRY_FORBIDDEN_PROMISE_TERMS,
  CUSTOM_JEWELRY_SHIPPING_TEXT,
  CUSTOM_JEWELRY_WARRANTY_TEXT,
} from "./finalApprovalCopy";

/**
 * The Custom Jewelry final approval copy, pinned.
 *
 * ============================================================================
 * WHY PIN A STRING CHARACTER FOR CHARACTER
 * ============================================================================
 * Same reasoning as `designDepositAcknowledgmentText.test.ts`: an
 * acknowledgment row records the EXACT text the customer accepted, and a
 * `policy_version` row records it again with a content hash. A well-meaning
 * edit to the constant would silently make every existing evidence row
 * describe words nobody ever saw — and this is the acknowledgment the
 * final-sale term rests on, for a piece that cannot be returned.
 *
 * A wording change is legitimate. It is a NEW policy version plus a constant
 * bump, which this test forces to be deliberate by failing on the old value.
 */

const ALL_CUSTOMER_FACING = [
  CUSTOM_JEWELRY_FINAL_SALE_TEXT,
  CUSTOM_JEWELRY_WARRANTY_TEXT,
  CUSTOM_JEWELRY_SHIPPING_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
] as const;

describe("the pinned text", () => {
  it("is exactly the final-sale sentence, with its four exceptions", () => {
    expect(CUSTOM_JEWELRY_FINAL_SALE_TEXT).toBe(
      "Once your final design and specifications are approved and the jewelry is purchased, your Custom Jewelry order is " +
        "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
        "approved design and specifications."
    );
  });

  it("is exactly the acknowledgment", () => {
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT).toBe(
      "I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and " +
        "engraving where applicable, exactly as displayed on this page. " +
        "I approve the final price shown and the credit of my $49 Design Deposit against it, and I understand I am paying " +
        "the remaining balance. " +
        "I understand that once my final design and specifications are approved and the jewelry is purchased, my order is " +
        "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
        "approved design and specifications."
    );
  });

  it("is exactly the warranty and shipping statements", () => {
    expect(CUSTOM_JEWELRY_WARRANTY_TEXT).toBe(
      "Your piece is covered by the CaratForUs 1-year limited manufacturing warranty, which covers qualifying defects in " +
        "materials, construction, setting, or assembly under normal use."
    );
    expect(CUSTOM_JEWELRY_SHIPPING_TEXT).toBe(
      "Standard shipping and insurance are included in the price shown."
    );
  });

  it("is exactly the affirmative action label", () => {
    // The storefront IMPORTS this as the button caption. If the two drifted,
    // the evidence row would describe a button the customer never saw.
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL).toBe("I Approve & Agree");
  });

  it("names its policy slugs and versions", () => {
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG).toBe("custom-jewelry-final-approval");
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION).toBe(1);
    // SEPARATE from the acknowledgment, because the package preserves them
    // separately and they can change independently.
    expect(CUSTOM_JEWELRY_FINAL_SALE_POLICY_SLUG).toBe("custom-jewelry-final-sale");
    expect(CUSTOM_JEWELRY_FINAL_SALE_POLICY_VERSION).toBe(1);
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG).not.toBe(CUSTOM_JEWELRY_FINAL_SALE_POLICY_SLUG);
  });
});

describe("the four final-sale exceptions always ship with the term", () => {
  it.each([
    "covered defects",
    "incorrect specifications",
    "shipping damage",
    "material failure to match",
  ])("the final-sale text names %s", (exception) => {
    // "Final sale" read alone overstates the term. Splitting the sentence
    // would turn a fair term into an unfair-looking one — and would also
    // mislead a customer about what they can still claim.
    expect(CUSTOM_JEWELRY_FINAL_SALE_TEXT).toContain(exception);
  });

  it.each([
    "covered defects",
    "incorrect specifications",
    "shipping damage",
    "material failure to match",
  ])("the acknowledgment names %s too", (exception) => {
    // The customer is certifying their understanding of the term, so the
    // exceptions have to be inside the sentence they certify — not only
    // displayed nearby.
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT).toContain(exception);
  });
});

describe("the acknowledgment establishes everything the owner enumerated", () => {
  it.each([
    ["design", /\bdesign\b/i],
    ["specifications", /\bspecifications\b/i],
    ["materials", /\bmaterials\b/i],
    ["dimensions and size", /dimensions and size/i],
    ["engraving", /\bengraving\b/i],
    ["the final price", /final price/i],
    ["the deposit credit", /Design Deposit/i],
    ["final-sale treatment", /final sale/i],
  ])("covers %s", (_label, pattern) => {
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT).toMatch(pattern);
  });

  it("binds the approval to THIS page's displayed content", () => {
    // Load-bearing, not decorative: the approval is against a frozen package
    // version, and "my design" would describe nothing checkable afterwards.
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT).toContain("exactly as displayed on this page");
  });

  it("says the customer pays the remaining balance", () => {
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT).toContain("paying the remaining balance");
  });
});

describe("no unsupported promises — the owner's explicit prohibition", () => {
  it.each(CUSTOM_JEWELRY_FORBIDDEN_PROMISE_TERMS)("no customer-facing string contains %s", (term) => {
    for (const text of ALL_CUSTOMER_FACING) {
      expect(text.toLowerCase(), `"${term}" appears in: ${text}`).not.toContain(term);
    }
  });

  it("makes no delivery-time statement of any kind", () => {
    // Shipping is INCLUDED in the price. That is the only shipping fact the
    // README supports, and a number of days is exactly what must not appear.
    expect(CUSTOM_JEWELRY_SHIPPING_TEXT).not.toMatch(/\d/);
    expect(CUSTOM_JEWELRY_SHIPPING_TEXT.toLowerCase()).not.toContain("day");
    expect(CUSTOM_JEWELRY_SHIPPING_TEXT.toLowerCase()).not.toContain("week");
  });

  it("promises no warranty REMEDY, only coverage", () => {
    // docs/WARRANTY-CLAIMS.md is explicit that CaratForUs determines repair,
    // replacement, refund or another remedy AFTER inspection. Naming one here
    // would promise it before anyone has inspected anything.
    const lower = CUSTOM_JEWELRY_WARRANTY_TEXT.toLowerCase();
    for (const remedy of ["we will repair", "we will replace", "we will refund", "free repair"]) {
      expect(lower).not.toContain(remedy);
    }
  });

  it("softens the final-sale term nowhere", () => {
    const lower = CUSTOM_JEWELRY_FINAL_SALE_TEXT.toLowerCase();
    for (const soften of ["may be returned", "change of mind", "cancel any time", "30 day"]) {
      expect(lower).not.toContain(soften);
    }
  });
});

describe("the deposit amount is imported, never retyped", () => {
  it("states the same figure the deposit charge uses", () => {
    // A page crediting one figure while the charge was another is the single
    // worst defect this surface could carry — and a hardcoded "$49" here is
    // exactly how the two drift when the amount changes.
    const dollars = CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS / 100n;
    expect(CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT).toContain(`$${dollars}`);
    expect(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT).toContain(`$${dollars}`);
  });

  it("says the deposit is CREDITED, never discounted", () => {
    // The owner's distinction. A discount reduces the price; a credit reduces
    // what is collected while the price stands.
    expect(CUSTOM_JEWELRY_DEPOSIT_CREDIT_TEXT.toLowerCase()).toContain("credited");
    for (const text of ALL_CUSTOMER_FACING) {
      expect(text.toLowerCase()).not.toContain("discount");
    }
  });
});
