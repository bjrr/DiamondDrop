import { describe, expect, it } from "vitest";

import {
  SIGNUP_NOTIFICATION_RECIPIENT,
  buildSignupConfirmationEmail,
  buildSignupInternalNotification,
  signupGreeting,
} from "./signupEmails";

/**
 * THE LAUNCHING SOON SIGNUP EMAILS.
 *
 * The owner supplied this copy word for word on 2026-11-13, so the body is
 * asserted in full rather than sampled. Customer-facing wording that nobody
 * pinned is wording that drifts: a well-meant tidy of "early-access" to
 * "early access", or a reordered bullet list, changes what a customer reads
 * and nothing fails.
 *
 * The two cases the owner asked for by name -- a signup WITHOUT a phone and
 * a signup WITH one -- are the first two describe blocks. The phone is
 * optional on this form, and the defect that opened this work was a signup
 * without one never reaching the backend at all, so "no phone behaves
 * exactly like phone, minus the phone line" is the property that matters.
 */

const CONFIRMATION_BODY = [
  "Thank you for joining CaratForUs.",
  "",
  "You’re now on our early-access list, and we’ll let you know as soon as we launch.",
  "",
  "CaratForUs is being built around a simpler way to buy fine jewelry, diamonds, and exclusive Group Buys at exceptional pricing.",
  "",
  "You’ll be among the first to hear about:",
  "",
  "- Our official launch",
  "- Direct diamond pricing",
  "- New Group Buy opportunities",
  "- Special early-access offers",
  "",
  "We look forward to welcoming you.",
  "",
  "The CaratForUs Team",
].join("\n");

describe("Case A — first name and email, phone left blank", () => {
  const input = { firstName: "Brian", lastName: "Jishi", email: "brian@example.com" };

  it("greets by the stored first name", () => {
    expect(buildSignupConfirmationEmail(input).text.startsWith("Hi Brian,")).toBe(true);
  });

  it("carries the approved subject", () => {
    expect(buildSignupConfirmationEmail(input).subject).toBe("You’re on the CaratForUs list");
  });

  it("carries the approved body, in full", () => {
    expect(buildSignupConfirmationEmail(input).text).toBe(`Hi Brian,\n\n${CONFIRMATION_BODY}`);
  });

  it("notifies us without inventing a phone line", () => {
    // "Phone: " with nothing after it reads as a capture bug and sends
    // someone looking for a number that was never asked for.
    const notification = buildSignupInternalNotification(input);
    expect(notification.text).toContain("First name: Brian");
    expect(notification.text).toContain("Last name: Jishi");
    expect(notification.text).toContain("Email: brian@example.com");
    expect(notification.text).not.toContain("Phone");
  });

  it("says where the signup came from", () => {
    expect(buildSignupInternalNotification(input).text).toContain("Launching Soon signup");
  });
});

describe("Case B — first name, email and phone", () => {
  const input = {
    firstName: "Brian",
    lastName: "Jishi",
    email: "brian@example.com",
    phone: "+15551234567",
  };

  it("sends the customer exactly the same confirmation as Case A", () => {
    // The phone changes what WE are told, never what the customer reads.
    expect(buildSignupConfirmationEmail(input)).toEqual(
      buildSignupConfirmationEmail({ firstName: "Brian", lastName: "Jishi", email: "brian@example.com" })
    );
  });

  it("includes the phone in the internal notification", () => {
    expect(buildSignupInternalNotification(input).text).toContain("Phone: +15551234567");
  });

  it("still includes every other field", () => {
    const text = buildSignupInternalNotification(input).text;
    expect(text).toContain("First name: Brian");
    expect(text).toContain("Last name: Jishi");
    expect(text).toContain("Email: brian@example.com");
  });
});

describe("the greeting falls back rather than greeting nobody", () => {
  it("uses the first name when there is one", () => {
    expect(signupGreeting("Brian")).toBe("Hi Brian,");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
  ])("falls back to 'Hi there,' when the name is %s", (_label, value) => {
    // "Hi ," is the defect this exists for, and it only ever appears in
    // someone's inbox.
    expect(signupGreeting(value as string | null | undefined)).toBe("Hi there,");
  });

  it("uses the fallback in the real confirmation body", () => {
    const content = buildSignupConfirmationEmail({ email: "someone@example.com" });
    expect(content.text).toBe(`Hi there,\n\n${CONFIRMATION_BODY}`);
  });

  it("trims a padded name rather than greeting 'Hi  Brian ,'", () => {
    expect(signupGreeting("  Brian  ")).toBe("Hi Brian,");
  });
});

describe("what the two emails must never do", () => {
  const input = { firstName: "Brian", email: "brian@example.com", phone: "+15551234567" };

  it("keeps the customer's details out of the customer's own email", () => {
    // The confirmation is a welcome, not a receipt. Echoing the address and
    // phone back adds nothing and turns a forwarded email into a leak.
    const text = buildSignupConfirmationEmail(input).text;
    expect(text).not.toContain("brian@example.com");
    expect(text).not.toContain("+15551234567");
  });

  it("uses no em dash, per the First Access copy rule", () => {
    expect(buildSignupConfirmationEmail(input).text).not.toContain("—");
    expect(buildSignupInternalNotification(input).text).not.toContain("—");
  });

  it("promises no launch date and no response time", () => {
    const text = buildSignupConfirmationEmail(input).text.toLowerCase();
    for (const phrase of ["within 24", "within 48", "business days", "hours", "on sale", "guarantee"]) {
      expect(text, `must not promise "${phrase}"`).not.toContain(phrase);
    }
  });

  it("sends the notification to the one internal address", () => {
    expect(SIGNUP_NOTIFICATION_RECIPIENT).toBe("orders@caratforus.com");
  });

  it("identifies the signup in the notification subject", () => {
    expect(buildSignupInternalNotification(input).subject).toBe("New Launching Soon signup: Brian");
  });

  it("falls back to the email in the subject when there is no name", () => {
    expect(buildSignupInternalNotification({ email: "x@example.com" }).subject).toBe(
      "New Launching Soon signup: x@example.com"
    );
  });
});
