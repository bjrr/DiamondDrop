import { describe, expect, it } from "vitest";

import { redactedSummary, resolveBankPaymentCoordinates } from "./bankPaymentCoordinates.server";
import type { Env } from "~/lib/env.server";

/**
 * Obviously-fake values throughout. Nothing account-number-shaped belongs in a
 * repository, including in a fixture somebody later copies in a hurry.
 */
const COMPLETE = {
  PAYMENT_ZELLE_RECIPIENT: "pay@example.invalid",
  PAYMENT_WIRE_BANK_NAME: "Example Bank (TEST)",
  PAYMENT_WIRE_ACCOUNT_NAME: "Example Account (TEST)",
  PAYMENT_WIRE_ROUTING_NUMBER: "000000000",
  PAYMENT_WIRE_ACCOUNT_NUMBER: "000000000000",
} as const;

function env(overrides: Partial<Record<keyof typeof COMPLETE, string | undefined>> = {}): Env {
  return { ...COMPLETE, ...overrides } as unknown as Env;
}

describe("bank payment coordinates resolve all-or-nothing", () => {
  it("resolves when every value is present", () => {
    const r = resolveBankPaymentCoordinates(env());
    expect(r.configured).toBe(true);
    if (!r.configured) return;
    expect(r.coordinates.zelle.recipient).toBe("pay@example.invalid");
    expect(r.coordinates.wire.routingNumber).toBe("000000000");
  });

  it.each(Object.keys(COMPLETE) as (keyof typeof COMPLETE)[])(
    "FAILS CLOSED when %s is missing — a partial set is not 'mostly usable'",
    (key) => {
      const r = resolveBankPaymentCoordinates(env({ [key]: undefined }));
      expect(r.configured).toBe(false);
      if (r.configured) return;
      expect(r.reason).toContain(key);
    }
  );

  it("treats whitespace-only as missing — a secret set to a space is not configured", () => {
    const r = resolveBankPaymentCoordinates(env({ PAYMENT_WIRE_ACCOUNT_NUMBER: "   " }));
    expect(r.configured).toBe(false);
  });

  it("names the MISSING VARIABLES and never a present VALUE", () => {
    // Errors travel further than logs — into traces, alerts, sometimes a
    // response body. The reason string must be safe everywhere it can land.
    const r = resolveBankPaymentCoordinates(env({ PAYMENT_ZELLE_RECIPIENT: undefined }));
    expect(r.configured).toBe(false);
    if (r.configured) return;
    expect(r.reason).toContain("PAYMENT_ZELLE_RECIPIENT");
    for (const value of Object.values(COMPLETE)) {
      expect(r.reason, `reason leaked a coordinate value: ${value}`).not.toContain(value);
    }
  });

  it("redactedSummary discloses nothing when configured — not even a masked tail", () => {
    const r = resolveBankPaymentCoordinates(env());
    const summary = redactedSummary(r);
    for (const value of Object.values(COMPLETE)) {
      expect(summary).not.toContain(value);
    }
    // The last four digits are exactly what a caller is asked for to prove
    // account ownership, so a "safe" mask is not safe.
    expect(summary).not.toContain("0000");
    expect(summary).toBe("bank payment coordinates: configured");
  });

  it("redactedSummary passes the reason through when NOT configured, so an operator learns what to set", () => {
    const r = resolveBankPaymentCoordinates(env({ PAYMENT_WIRE_BANK_NAME: undefined }));
    expect(redactedSummary(r)).toContain("PAYMENT_WIRE_BANK_NAME");
  });
});
