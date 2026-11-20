import { describe, expect, it } from "vitest";

import { resolveSmsPort } from "./configuredPort.server";

/**
 * THE APP IS NOT AN SMS SENDER — owner decision 2026-11-19.
 *
 * ============================================================================
 * WHAT THIS PROTECTS
 * ============================================================================
 * Shopify Messaging is the ONLY sender of the First Access welcome SMS. This
 * app retains a disabled `SmsPort` seam, and the failure this fence exists to
 * prevent is a SECOND live sender: Shopify Messaging decides for itself when a
 * new SMS subscriber gets a welcome text, this app cannot see that decision,
 * and Shopify cannot see this one. Two senders means two welcome texts for one
 * signup — on the first text from an unknown number, which is precisely the
 * impression a toll-free sender under carrier review must not make.
 *
 * The specific slip being fenced is mundane and therefore likely: someone sets
 * `SMS_API_KEY` and `SMS_FROM` in the environment, which looks like the
 * obvious way to "finish" an unconfigured integration, and starts sending
 * without ever opening the file that explains why they should not.
 *
 * So the assertion is deliberately absolute: `resolveSmsPort` returns
 * `configured: false` for EVERY input, credentials present or absent. A test
 * that only checked the missing-credentials case would pass while the duplicate
 * send shipped.
 */
describe("the app-side SMS sender stays disabled", () => {
  const env = (over: Record<string, unknown>) => ({ ...over }) as never;

  it("is unconfigured when the credentials are absent", () => {
    const r = resolveSmsPort(env({ SMS_API_KEY: undefined, SMS_FROM: undefined }));
    expect(r.configured).toBe(false);
  });

  it("is STILL unconfigured when both credentials are present", () => {
    // THE ASSERTION THAT MATTERS. Setting the two variables is the obvious
    // way someone would try to enable this, and it must not work.
    const r = resolveSmsPort(env({ SMS_API_KEY: "key-live-whatever", SMS_FROM: "+18888476660" }));
    expect(r.configured).toBe(false);
    if (r.configured) return;
    // And the reason names the owner decision, so whoever hits it is sent to
    // the actual constraint rather than to a missing-adapter dead end.
    expect(r.reason).toMatch(/Shopify Messaging/);
    expect(r.reason).toMatch(/2026-11-19/);
  });

  it("never returns a port, under any combination of credentials", () => {
    for (const SMS_API_KEY of [undefined, "", "k"]) {
      for (const SMS_FROM of [undefined, "", "+18888476660"]) {
        const r = resolveSmsPort(env({ SMS_API_KEY, SMS_FROM }));
        expect(r.configured, `configured with ${JSON.stringify({ SMS_API_KEY, SMS_FROM })}`).toBe(false);
        expect(r).not.toHaveProperty("port");
      }
    }
  });

  it("reports a reason rather than throwing, so a signup never fails for want of a sender", () => {
    // Consent recording and sending are separate concerns: the permission is
    // written to Shopify whether or not anything can text. A throw here would
    // couple them and lose a consent the customer actually gave.
    const r = resolveSmsPort(env({}));
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
