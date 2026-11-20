import { describe, expect, it } from "vitest";

import { FIRST_ACCESS_SIGNUP_SMS_BODY, buildSignupConfirmationSms } from "./signupSms";

/**
 * The confirmation text. Short, and every constraint on it is a real one.
 */
describe("the SMS signup confirmation", () => {
  it("uses only GSM-7 characters, because a single stray one adds a segment", () => {
    // THE ONE LENGTH-ADJACENT BUG WORTH A FENCE. A curly apostrophe or en dash
    // switches the whole message to UCS-2, which HALVES per-segment capacity
    // from 153 to 67 and silently adds a segment to a body that already spans
    // two. The owner's wording contains two apostrophes; they must stay
    // straight. Caught here rather than by a carrier splitting the message in
    // production and a bill explaining it later.
    const gsm7 =
      "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà" +
      "\n\r\f^{}\\[~]|€";
    const offenders = [...FIRST_ACCESS_SIGNUP_SMS_BODY].filter((ch) => !gsm7.includes(ch));
    expect(offenders, `non-GSM-7 characters: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("stays within two GSM-7 segments", () => {
    // NOT ONE SEGMENT, AND THE TEST SAYS SO HONESTLY. An earlier version of
    // this message fitted 160 characters; the owner's approved wording is 167
    // and does not. Pinning "<= 160" here would have failed on correct copy,
    // and loosening it to nothing would let the message grow unbounded — so
    // the bound is the real next threshold. Concatenated GSM-7 segments carry
    // 153 septets each, and Shopify adds its message prefix plus an appended
    // unsubscribe URL on top of this body, so the delivered text is 2-3
    // segments. Anything past 306 here means a rewrite nobody costed.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY.length).toBeLessThanOrEqual(306);
  });

  it("does NOT tell the customer to reply, because the sender cannot receive replies", () => {
    // Owner decision 2026-11-19, and the most important assertion in this file.
    // Shopify Messaging's US/Canada toll-free sender is DELIVERY-ONLY. A
    // "Reply STOP" instruction on it sends the customer into a dead end: they
    // believe they opted out, Shopify still has them SUBSCRIBED, and they stop
    // looking for the mechanism that works. Silence is strictly better than a
    // broken instruction, and Shopify appends the unsubscribe URL that works.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\breply\b/i);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\bSTOP\b/);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/\bHELP\b/);
  });

  it("does NOT prepend the brand, because Shopify Messaging already does", () => {
    // The shop's configured message prefix is `CaratForUs` (verified live), so
    // Shopify delivers "CaratForUs: <body>". Writing the brand here too
    // produces "CaratForUs: CaratForUs: ..." — which is why this assertion is
    // the exact inverse of the one it replaced. Brand identification on the
    // first text from an unknown number is still satisfied; it is just not
    // ours to add.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/CaratForUs/);
  });

  it("repeats the rates disclosure", () => {
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toContain("Msg & data rates may apply");
  });

  it("says what they joined, so it is recognisable as the thing they asked for", () => {
    // Names the list by the name the customer saw on the form, which is what
    // makes an unexpected text recognisable rather than alarming.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toMatch(/First Access list/i);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).toMatch(/group buys/i);
  });

  it("builds NO unsubscribe link of its own", () => {
    // Owner decision 2026-11-19: Shopify Messaging appends the unsubscribe URL,
    // and ONLY Shopify's link mutates `smsMarketingConsent`. A CaratForUs-built
    // one would be a second opt-out that Shopify does not honour — the same
    // defect as "Reply STOP" wearing a different hat.
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/unsubscribe/i);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/opt.?out/i);
    expect(FIRST_ACCESS_SIGNUP_SMS_BODY).not.toMatch(/caratforus\.com/i);
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
