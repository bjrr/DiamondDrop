import { describe, expect, it } from "vitest";

import { buildBuyNowPaymentInstructionsEmail } from "./buyNowPaymentInstructionsEmail";

/** OBVIOUSLY-FAKE COORDINATES ON PURPOSE -- see groupBuyPaymentInstructionsEmail.test.ts. */
const FAKE = {
  zelle: { recipient: "pay@example.invalid" },
  wire: {
    bankName: "Example Bank (TEST)",
    accountName: "Example Account (TEST)",
    routingNumber: "000000000",
    accountNumber: "000000000000",
  },
} as const;

const content = buildBuyNowPaymentInstructionsEmail({
  bankPaymentOrderId: "bn-order-1234",
  formattedAmountDue: "1062.00 USD",
  guaranteeExpiresAt: new Date("2026-10-25T15:30:45.000Z"),
  coordinates: FAKE,
});

describe("Buy Now Bank Payment instructions email", () => {
  it("subject names the order reference", () => {
    expect(content.subject).toBe("Payment instructions for your CaratForUs order (bn-order-1234)");
  });

  it("states amount, reference and the guarantee deadline in UTC", () => {
    expect(content.text).toContain("Amount due: 1062.00 USD");
    expect(content.text).toContain("Order reference: bn-order-1234");
    expect(content.text).toContain("Your Bank Payment Price is guaranteed until: 2026-10-25 15:30 UTC");
  });

  it("carries every coordinate it was given, in the Zelle and wire blocks", () => {
    const zelleBlock = content.text.slice(content.text.indexOf("Zelle"), content.text.indexOf("Domestic bank wire"));
    const wireBlock = content.text.slice(content.text.indexOf("Domestic bank wire"));
    expect(zelleBlock).toContain("Send to: pay@example.invalid");
    expect(zelleBlock).toContain("Memo / note: bn-order-1234");
    expect(wireBlock).toContain("Bank name: Example Bank (TEST)");
    expect(wireBlock).toContain("Account name: Example Account (TEST)");
    expect(wireBlock).toContain("Routing number: 000000000");
    expect(wireBlock).toContain("Account number: 000000000000");
    expect(wireBlock).toContain("Reference: bn-order-1234");
  });

  it("repeats the owner-approved guarantee and not-committed sentences verbatim", () => {
    expect(content.text).toContain(
      "Your Bank Payment Price is guaranteed for 24 hours. After that, your order stays open only while the price is unchanged; if the price changes before your payment arrives, we’ll cancel the order and email you."
    );
    expect(content.text).toContain(
      "Your order is not committed and availability is not guaranteed until your Bank Payment is received and verified. We’ll email you once that is done."
    );
    expect(content.text.trimEnd().endsWith("\n\nCaratForUs")).toBe(true);
  });

  it("says the order is not committed and that payment must be verified", () => {
    expect(content.text).toMatch(/not committed/);
    expect(content.text).toMatch(/received and verified/);
  });

  it("never mentions card, fee or surcharge", () => {
    const lower = content.text.toLowerCase();
    for (const word of ["card", "fee", "surcharge"]) {
      expect(lower, `must not mention "${word}"`).not.toContain(word);
    }
  });

  it("offers only Zelle and domestic wire", () => {
    const lower = content.text.toLowerCase();
    expect(lower).not.toContain("swift");
    expect(lower).not.toContain("bank transfer");
    expect(lower).not.toContain("check");
  });

  it("leaves no unsubstituted placeholder", () => {
    for (const token of ["{", "}", "undefined", "null"]) {
      expect(content.text, `unsubstituted token in email body: ${token}`).not.toContain(token);
    }
  });
});
