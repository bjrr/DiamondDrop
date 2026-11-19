import { describe, expect, it } from "vitest";

import { FIRST_ACCESS_SIGNUP_SMS_BODY, buildSignupConfirmationSms } from "./signupSms";

/**
 * The confirmation text. Short, and every constraint on it is a real one.
 */
describe("the SMS signup confirmation", () => {
  it("fits one GSM-7 segment", () => {
    // A message that silently becomes two costs twice and can arrive out of
    // order, which for a FIRST text from an unknown number reads as spam.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY.length).toBeLessThanOrEqual(160);
  });

  it("uses only GSM-7 characters, so the limit it is measured against is the real one", () => {
    // A single curly quote or en dash switches the whole message to UCS-2 and
    // drops the segment limit from 160 to 70 — at which point the length
    // assertion above is measuring against the wrong number. Caught here
    // rather than by a carrier splitting the message in production.
    const gsm7 =
      "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
      "\n\r\f^{}\\[~]|€";
    const offenders = [...FIRST_ACCESS_SIGNUP_SMS_BODY].filter((ch) => !gsm7.includes(ch));
    expect(offenders, `non-GSM-7 characters: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("identifies the brand, because it is the first text from an unknown number", () => {
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toContain("CaratForUs");
    // And it is the FIRST thing, not buried mid-sentence.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY.startsWith("CaratForUs")).toBe(true);
  });

  it("carries HELP and STOP, which the opt-in promised", () => {
    // The opt-in wording says "Reply STOP to unsubscribe". A confirmation that
    // omits it is the worst possible place to drop that promise.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toContain("STOP");
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toContain("HELP");
  });

  it("repeats the rates disclosure", () => {
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toContain("Msg & data rates may apply");
  });

  it("says what they joined, so it is recognisable as the thing they asked for", () => {
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toMatch(/early access/i);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toMatch(/group buys/i);
  });

  it("is a confirmation, NOT the first marketing message", () => {
    // No offer, no code, no link. The very first text must not be a campaign
    // the customer has not yet seen the list behave for — and a link in an
    // unexpected SMS is what carriers and customers both read as spam.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/https?:\/\//);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\bcode\b/i);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\d+\s*%/);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\$\d/);
  });

  it("carries no name, because the proxy route is never given one", () => {
    // Names are deliberately not sent to the app-proxy endpoint, so there is
    // none to interpolate. A template placeholder here would render literally.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\{\{|\}\}|\$\{/);
  });

  it("builds the same body it exports", () => {
    expect(buildSignupConfirmationSms().body).toBe(FIRST_ACCESS_SIGNUP_SMS_BODY);
  });
});
