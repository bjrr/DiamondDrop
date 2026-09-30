import { describe, expect, it } from "vitest";

import { buildWarrantyClaimAcknowledgmentEmail } from "./claimAcknowledgmentEmail";

/**
 * PINS OWNER-APPROVED COPY CHARACTER-FOR-CHARACTER (approved 2026-09-29).
 *
 * Same discipline as `guaranteeCancellationEmail.test.ts`. The point is not
 * that the wording is fragile — it is that any change to it is new,
 * unapproved, customer-facing copy, and the only way to notice a "harmless"
 * tidy-up (a straight apostrophe, a reflowed line, a friendlier sign-off) is
 * to compare the whole string.
 */
describe("warranty claim acknowledgement email", () => {
  const content = buildWarrantyClaimAcknowledgmentEmail({
    claimReference: "WC-2026-0001",
    purchaserEmail: "buyer@example.com",
  });

  it("subject is exactly the approved sentence, with the reference substituted", () => {
    expect(content.subject).toBe("We’ve received your warranty claim (WC-2026-0001)");
  });

  it("body is exactly the approved text", () => {
    expect(content.text).toBe(
      [
        "Hi there,",
        "",
        "We’ve received your warranty claim and recorded it under reference WC-2026-0001.",
        "",
        "We’ll review what you’ve sent and email you at buyer@example.com.",
        "",
        "Do not send your jewelry until CaratForUs authorizes an inspection and provides shipping instructions.",
        "",
        "CaratForUs",
      ].join("\n")
    );
  });

  it("uses the owner's curly apostrophes, not straight ones", () => {
    // Spelled out because an editor or a lint autofix will "correct" these
    // silently, and the diff is nearly invisible in review.
    expect(content.subject).toContain("We’ve");
    expect(content.text).toContain("We’ve");
    expect(content.text).toContain("We’ll");
    expect(content.text).toContain("you’ve");
    expect(content.text).not.toContain("We've");
    expect(content.text).not.toContain("you've");
  });

  it("promises NO turnaround time — struck by the owner, twice", () => {
    const forbidden = [
      "within",
      "business day",
      "business days",
      "shortly",
      "as soon as possible",
      "24 hours",
      "48 hours",
      "soon",
    ];
    const haystack = `${content.subject}\n${content.text}`.toLowerCase();
    for (const phrase of forbidden) {
      expect(haystack, `acknowledgement email must not promise timing: found "${phrase}"`).not.toContain(phrase);
    }
  });

  it("carries the locked do-not-ship instruction, and NO consequence for ignoring it", () => {
    expect(content.text).toContain(
      "Do not send your jewelry until CaratForUs authorizes an inspection and provides shipping instructions."
    );
    // The owner rejected "…may be returned to you" with no replacement.
    expect(content.text.toLowerCase()).not.toContain("returned to you");
    expect(content.text.toLowerCase()).not.toContain("cannot be tracked");
  });

  it("substitutes both values rather than leaving a placeholder", () => {
    expect(content.text).not.toContain("{claimReference}");
    expect(content.text).not.toContain("{purchaserEmail}");
    const other = buildWarrantyClaimAcknowledgmentEmail({
      claimReference: "WC-2026-0002",
      purchaserEmail: "other@example.com",
    });
    expect(other.text).toContain("WC-2026-0002");
    expect(other.text).toContain("other@example.com");
    expect(other.text).not.toContain("WC-2026-0001");
  });
});
