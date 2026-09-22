import { describe, expect, it } from "vitest";

import {
  buildGuaranteeCancellationEmail,
  PINNED,
  UNAPPROVED_FALLBACK_GREETING_NAME,
} from "./guaranteeCancellationEmail";

/**
 * PINNED CHARACTER-FOR-CHARACTER, like `ownerApprovedCopy.test.ts` does for
 * the cart strings. This is material customer communication about a cancelled
 * order and money not taken; the owner approved this exact text on 2026-09-22,
 * and an edit — even fixing what looks like a typo — is new unapproved copy.
 *
 * The literal below is written out in full rather than assembled from the
 * module's own pieces on purpose. A test that rebuilds the string from the
 * same source it is checking proves only that the code equals itself.
 */
const APPROVED_SUBJECT = "An update on your CaratForUs Bank Payment order";

const APPROVED_BODY_FOR_ADA_AND_ORDER_42 = [
  "Hi Ada,",
  "",
  "We’re writing to let you know that your CaratForUs Bank Payment order order-42 has been canceled.",
  "",
  "When you placed your order, your Bank Payment Price was guaranteed for 24 hours. Because payment was not received and verified within that guarantee period, and the price of your order changed after the 24-hour window expired, we’re no longer able to honor the original quoted price.",
  "",
  "Rather than automatically changing your order to a different price, we canceled it so you can review the current price and decide whether you’d like to place a new order.",
  "",
  "No payment has been processed by CaratForUs for this order.",
  "",
  "If you already sent a bank payment, please reply to this email and we’ll review it for you.",
  "",
  "You’re welcome to place a new order at the current price at any time. If you have any questions, simply reply to this email and we’ll be happy to help.",
  "",
  "Thank you,",
  "CaratForUs Customer Care",
  "orders@caratforus.com",
].join("\n");

describe("the owner-approved cancellation email", () => {
  it("is exactly the approved text, with the first name and order reference substituted", () => {
    const email = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "order-42",
      customerFirstName: "Ada",
    });

    expect(email.subject).toBe(APPROVED_SUBJECT);
    expect(email.text).toBe(APPROVED_BODY_FOR_ADA_AND_ORDER_42);
  });

  it("keeps the curly apostrophes and the US spelling the owner wrote", () => {
    const { text } = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "order-1",
      customerFirstName: "Ada",
    });

    // Straight apostrophes would be a silent substitution by an editor or a
    // helpful autocorrect; asserting their absence catches that.
    expect(text).not.toContain("'");
    expect(text).toContain("We’re");
    expect(text).toContain("canceled");
    expect(text).not.toContain("cancelled");
  });

  /**
   * NEVER: dollar figures, percentages, or anything about how the price is
   * derived. The owner's instruction was explicit, and this is the surface
   * where a helpful "the price rose to $X" would be most tempting.
   */
  it("carries no money figure and no internal pricing vocabulary", () => {
    // A digit-free order reference, so the digit assertion below measures the
    // COPY rather than whatever id the fixture happened to use.
    const { subject, text } = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "ORDER-REF",
      customerFirstName: "Ada",
    });
    const whole = `${subject}\n${text}`;

    expect(whole).not.toMatch(/\$|\d+(\.\d{2})?\s*(USD|dollars)/i);
    expect(whole).not.toMatch(/surcharge|cash discount|card fee|uplift|tier|margin|markup|landed cost/i);
    // "24 hours" and "24-hour" are the only numbers the approved copy uses.
    expect(whole.match(/\d+/g)).toEqual(["24", "24"]);
  });

  it("falls back to a neutral greeting when the first name cannot be read", () => {
    for (const missing of [null, "", "   "]) {
      const { text } = buildGuaranteeCancellationEmail({
        bankPaymentOrderId: "order-7",
        customerFirstName: missing,
      });
      expect(text.startsWith(`Hi ${UNAPPROVED_FALLBACK_GREETING_NAME},`)).toBe(true);
    }
  });

  it("trims a name that arrives padded, rather than greeting 'Hi  Ada ,'", () => {
    const { text } = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "order-7",
      customerFirstName: "  Ada  ",
    });
    expect(text.startsWith("Hi Ada,")).toBe(true);
  });

  it("exposes the subject through PINNED so callers cannot drift from it", () => {
    expect(PINNED.subject).toBe(APPROVED_SUBJECT);
  });
});
