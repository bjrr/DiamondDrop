import { describe, expect, it } from "vitest";

import { buildGroupBuyPaymentInstructionsEmail } from "./groupBuyPaymentInstructionsEmail";

/**
 * OBVIOUSLY-FAKE COORDINATES ON PURPOSE. Real ones live only in Fly secrets
 * and are read by `bankPaymentCoordinates.server.ts`; nothing resembling a
 * real routing or account number belongs in a repository, including in a
 * fixture where it would later be copied by someone in a hurry.
 */
const FAKE = {
  zelle: { recipient: "pay@example.invalid" },
  wire: {
    bankName: "Example Bank (TEST)",
    accountName: "Example Account (TEST)",
    routingNumber: "000000000",
    accountNumber: "000000000000",
  },
} as const;

const content = buildGroupBuyPaymentInstructionsEmail({
  bankPaymentOrderId: "gb-order-1234",
  campaignCode: "spring-halo",
  formattedAmountDue: "$1,062.00",
  paymentDeadline: new Date("2026-10-01T15:30:00.000Z"),
  coordinates: FAKE,
});

describe("Group Buy Bank Payment instructions email", () => {
  it("states everything the owner required: amount, reference, both methods, deadline", () => {
    expect(content.text).toContain("Amount due: $1,062.00");
    expect(content.text).toContain("Order reference: gb-order-1234");
    expect(content.text).toContain("Zelle");
    expect(content.text).toContain("Domestic bank wire");
    expect(content.text).toContain("Please send payment by: 2026-10-01 15:30 UTC");
    expect(content.subject).toContain("gb-order-1234");
  });

  it("names the timezone — a bare time is a time in someone else's day", () => {
    expect(content.text).toMatch(/Please send payment by: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  it("carries the payment coordinates it was given", () => {
    expect(content.text).toContain("pay@example.invalid");
    expect(content.text).toContain("Example Bank (TEST)");
    expect(content.text).toContain("000000000");
    expect(content.text).toContain("000000000000");
  });

  it("asks for the order reference with EVERY method, so an untraceable payment is less likely", () => {
    // A wire or Zelle transfer that arrives with no reference has to be
    // matched by hand against amount and name, which is exactly the manual
    // reconciliation this reference exists to avoid.
    const zelleBlock = content.text.slice(content.text.indexOf("Zelle"), content.text.indexOf("Domestic bank wire"));
    const wireBlock = content.text.slice(content.text.indexOf("Domestic bank wire"));
    expect(zelleBlock).toContain("gb-order-1234");
    expect(wireBlock).toContain("gb-order-1234");
  });

  it("does NOT offer ACH or generic bank transfer — owner limited MVP1 to Zelle and domestic wire", () => {
    const lower = content.text.toLowerCase();
    expect(lower).not.toContain("ach");
    expect(lower).not.toContain("swift");
    expect(lower).not.toContain("bic");
    // "bank transfer" as a named method; "domestic bank wire" is the wording used.
    expect(lower).not.toContain("bank transfer");
  });

  it("repeats the locked timing verbatim, so the page and the email cannot drift", () => {
    expect(content.text).toContain(
      "You have 48 hours to send payment; if you need longer we’ll automatically extend it once, by a further 48 hours."
    );
    expect(content.text).toContain(
      "Your order counts toward the group’s progress straight away, and your price is locked from the moment you order."
    );
    expect(content.text).toContain(
      "If payment hasn’t arrived after 96 hours we’ll set your order aside. While the campaign is still open you can email us to reactivate it — same order, same locked price."
    );
  });

  it("says plainly that sending payment is not the same as it being verified", () => {
    expect(content.text).toContain("Your payment is not confirmed until we receive it and verify it.");
  });

  it("never claims the order is complete, paid, or confirmed", () => {
    const lower = content.text.toLowerCase();
    for (const phrase of ["payment received", "order confirmed", "payment complete", "thank you for your payment"]) {
      expect(lower, `must not imply payment already happened: "${phrase}"`).not.toContain(phrase);
    }
  });

  it("leaves no unsubstituted placeholder", () => {
    for (const token of ["{", "}", "undefined", "null"]) {
      expect(content.text, `unsubstituted token in email body: ${token}`).not.toContain(token);
    }
  });
});
