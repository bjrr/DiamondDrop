import { describe, expect, it } from "vitest";

import {
  buildCustomJewelryIntakeConfirmation,
  CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE,
  CUSTOM_JEWELRY_FOLLOW_UP_CHOICES,
  CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE,
} from "./intakeCopy";

/**
 * These pin OWNER-APPROVED copy. A failure here is not a bug to be fixed by
 * updating the expectation — it means someone changed customer-facing text the
 * owner approved verbatim, and the fix is to restore it or get new approval.
 */

describe("the approved confirmation sentence", () => {
  it("is exactly the approved wording, curly apostrophes included", () => {
    expect(CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE).toBe(
      "Thanks — we’ve received your custom jewelry request and recorded it under {projectReference}. " +
        "There’s no charge for this enquiry. We’ll be in touch by email."
    );
  });

  it("substitutes the server-assigned reference", () => {
    expect(buildCustomJewelryIntakeConfirmation("CJ-2026-0042")).toContain("recorded it under CJ-2026-0042.");
    expect(buildCustomJewelryIntakeConfirmation("CJ-2026-0042")).not.toContain("{projectReference}");
  });
});

describe("the approved $49 Design Deposit disclosure", () => {
  it("is exactly the approved wording", () => {
    expect(CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE).toBe(
      "This enquiry is free. If we move forward with design/CAD work, there is a $49 Design Deposit. " +
        "The deposit is charged when design/CAD work begins and is credited toward your final price. " +
        "If CaratForUs completes the agreed design stage and you decide not to proceed, the $49 deposit is refunded."
    );
  });

  it("keeps the refund CONDITIONAL — it must never read as unconditional", () => {
    // The owner's words: "Do not let the initial intake wording imply the
    // deposit is unconditionally refundable." The conditional clause is the
    // thing that prevents that, so it is asserted on its own.
    expect(CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE).toContain(
      "If CaratForUs completes the agreed design stage and you decide not to proceed"
    );
    for (const unconditional of ["fully refundable", "always refunded", "refundable at any time", "100% refundable"]) {
      expect(CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE.toLowerCase()).not.toContain(unconditional);
    }
  });

  it("does NOT carry the abandonment rule — that belongs on the deposit step", () => {
    // Explicit owner instruction: "Do not put the abandonment/non-response
    // rule on the initial intake form. Keep the intake welcoming." Asserted
    // here so a well-meaning later edit cannot quietly add it back.
    const lowered = CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE.toLowerCase();
    for (const term of ["abandon", "stop responding", "stops responding", "unresponsive", "non-response"]) {
      expect(lowered).not.toContain(term);
    }
  });
});

describe("no surface in this module promises a response time", () => {
  it.each([
    ["confirmation", CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE],
    ["deposit disclosure", CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE],
  ])("%s carries no turnaround language", (_label, text) => {
    const lowered = text.toLowerCase();
    // "as soon as possible" is included deliberately: it is a turnaround
    // promise wearing a vague coat, and the owner struck exactly that kind of
    // phrasing from the warranty copy twice.
    for (const promise of [
      "shortly",
      "as soon as possible",
      "within 24",
      "within 48",
      "business day",
      "business days",
      "same day",
      "promptly",
      "right away",
      "immediately",
    ]) {
      expect(lowered).not.toContain(promise);
    }
    expect(lowered).not.toMatch(/within \d+/);
  });
});

describe("the approved follow-up choices", () => {
  it("are exactly the two the owner approved, in order", () => {
    expect(CUSTOM_JEWELRY_FOLLOW_UP_CHOICES).toEqual([
      { value: "schedule_consultation", label: "Schedule a consultation" },
      { value: "contact_me", label: "Please contact me" },
    ]);
  });
});
