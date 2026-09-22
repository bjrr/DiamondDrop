import { describe, expect, it } from "vitest";

import { buildGuaranteeCancellationEmail, PINNED } from "./guaranteeCancellationEmail";

/**
 * Pins the NOT-YET-OWNER-APPROVED cancellation copy so a future edit is a
 * visible diff against this file, exactly the discipline
 * `app/theme/ownerApprovedCopy.test.ts` applies to copy that HAS been
 * approved. This test additionally enforces the forbidden-terminology sweep
 * and the "no dollar figure" rule, so a well-meant addition of a specific
 * price cannot slip in unnoticed.
 */

describe("guarantee cancellation email content", () => {
  it("matches the currently pinned wording exactly", () => {
    const email = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "11111111-1111-1111-1111-111111111111",
      customerEmail: "customer@example.com",
    });

    expect(email.subject).toBe(PINNED.subject);
    expect(email.text).toBe(
      [
        "Order reference: 11111111-1111-1111-1111-111111111111",
        "",
        "The Bank Payment price quoted for this order was guaranteed for 24 hours. " +
          "That guarantee has now expired, the price has since changed, and no payment " +
          "was received in time, so this order has been cancelled.",
        "",
        "Nothing was charged to you.",
        "",
        "You're welcome to place a new order at the current price, or reply to this " +
          "email if you have any questions.",
      ].join("\n")
    );
  });

  it("names the order given, not a fixed placeholder", () => {
    const email = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "different-order-id",
      customerEmail: "customer@example.com",
    });
    expect(email.text).toContain("Order reference: different-order-id");
  });

  it("contains no forbidden pricing terminology", () => {
    const email = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "id",
      customerEmail: "c@example.com",
    });
    const forbidden = /\b(cash|cash discount|card fee|credit card fee|surcharge)\b/i;
    expect(forbidden.test(email.subject)).toBe(false);
    expect(forbidden.test(email.text)).toBe(false);
  });

  it("never states a specific dollar amount — that is unapproved material pricing communication", () => {
    const email = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "id",
      customerEmail: "c@example.com",
    });
    expect(email.text).not.toMatch(/\$\d/);
  });
});
