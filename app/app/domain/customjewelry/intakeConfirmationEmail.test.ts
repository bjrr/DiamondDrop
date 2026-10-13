import { describe, expect, it } from "vitest";

import { buildCustomJewelryIntakeConfirmationEmail } from "./intakeConfirmationEmail";

/** PINS OWNER-APPROVED COPY CHARACTER-FOR-CHARACTER (approved 2026-10-05). */
describe("custom jewelry intake confirmation email", () => {
  const content = buildCustomJewelryIntakeConfirmationEmail({ projectReference: "CJ-7Q2MPX4N" });

  it("subject is exactly the approved sentence", () => {
    expect(content.subject).toBe("We received your custom jewelry request (CJ-7Q2MPX4N)");
  });

  it("body is exactly the approved text", () => {
    expect(content.text).toBe(
      [
        "Hi there,",
        "",
        "We’ve received your custom jewelry request and recorded it under reference CJ-7Q2MPX4N.",
        "",
        "There’s no charge for this enquiry. We’ll be in touch by email about the next step.",
        "",
        "CaratForUs",
      ].join("\n")
    );
  });

  it("uses the owner's curly apostrophes", () => {
    // An editor or lint autofix will "correct" these silently and the diff is
    // nearly invisible in review.
    expect(content.text).toContain("We’ve");
    expect(content.text).toContain("There’s");
    expect(content.text).toContain("We’ll");
    expect(content.text).not.toContain("We've");
    expect(content.text).not.toContain("There's");
  });

  it("promises NO response time — struck by the owner here and twice in warranty copy", () => {
    const forbidden = [
      "within",
      "business day",
      "business days",
      "shortly",
      "as soon as possible",
      "24 hours",
      "48 hours",
      "soon",
      "quickly",
    ];
    const haystack = `${content.subject}\n${content.text}`.toLowerCase();
    for (const phrase of forbidden) {
      expect(haystack, `confirmation must not promise timing: found "${phrase}"`).not.toContain(phrase);
    }
  });

  it("says the enquiry is free, and states NO deposit refund terms", () => {
    // The conditional refund rules — especially that a refund is not automatic
    // if the customer abandons before the agreed design stage completes —
    // belong on the deposit/approval step where they are affirmatively
    // accepted. In a welcome email they would read as a warning and could not
    // be acknowledged.
    expect(content.text).toContain("There’s no charge for this enquiry.");
    const lower = content.text.toLowerCase();
    for (const phrase of ["refund", "$49", "deposit", "non-refundable", "abandon"]) {
      expect(lower, `deposit terms do not belong in the intake confirmation: "${phrase}"`).not.toContain(phrase);
    }
  });

  it("substitutes the reference rather than leaving a placeholder", () => {
    expect(content.text).not.toContain("{projectReference}");
    const other = buildCustomJewelryIntakeConfirmationEmail({ projectReference: "CJ-ABCD1234" });
    expect(other.subject).toContain("CJ-ABCD1234");
    expect(other.text).toContain("CJ-ABCD1234");
    expect(other.text).not.toContain("CJ-7Q2MPX4N");
  });
});
