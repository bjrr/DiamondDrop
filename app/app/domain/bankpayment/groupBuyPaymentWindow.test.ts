import { describe, expect, it } from "vitest";

import {
  GROUP_BUY_AUTOMATIC_EXTENSION_MS,
  GROUP_BUY_TOTAL_PAYMENT_WINDOW_MS,
  groupBuyInitialPaymentDeadline,
  groupBuyPaymentWindowDeadline,
  hasGroupBuyPaymentWindowElapsed,
  resolveGroupBuyPaymentWindowStart,
} from "./groupBuyPaymentWindow";

const QUOTED_AT = new Date("2026-09-27T00:00:00Z");

describe("groupBuyPaymentWindowDeadline", () => {
  it("is exactly 96 hours (48h + 48h) after the window start", () => {
    expect(GROUP_BUY_TOTAL_PAYMENT_WINDOW_MS).toBe(96 * 60 * 60 * 1000);
    const deadline = groupBuyPaymentWindowDeadline(QUOTED_AT);
    expect(deadline.getTime() - QUOTED_AT.getTime()).toBe(96 * 60 * 60 * 1000);
  });
});

describe("hasGroupBuyPaymentWindowElapsed", () => {
  it("is false at the 48-hour mark — the automatic extension has not yet run out", () => {
    const at48h = new Date(QUOTED_AT.getTime() + 48 * 60 * 60 * 1000);
    expect(hasGroupBuyPaymentWindowElapsed(QUOTED_AT, at48h)).toBe(false);
  });

  it("is false one millisecond before the 96-hour deadline", () => {
    const justBefore = new Date(QUOTED_AT.getTime() + 96 * 60 * 60 * 1000 - 1);
    expect(hasGroupBuyPaymentWindowElapsed(QUOTED_AT, justBefore)).toBe(false);
  });

  it("is true exactly at the 96-hour deadline — AT OR PAST, not strictly past", () => {
    const exactly96h = new Date(QUOTED_AT.getTime() + 96 * 60 * 60 * 1000);
    expect(hasGroupBuyPaymentWindowElapsed(QUOTED_AT, exactly96h)).toBe(true);
  });

  it("is true well past the deadline", () => {
    const wellPast = new Date(QUOTED_AT.getTime() + 200 * 60 * 60 * 1000);
    expect(hasGroupBuyPaymentWindowElapsed(QUOTED_AT, wellPast)).toBe(true);
  });

  it("reactivation resets the clock by construction — a fresh window start is treated exactly like a fresh quote", () => {
    // This module never reads reactivatedAt itself (see its own doc
    // comment); the caller resolves which timestamp is "current" and
    // passes it in. Proven here: the SAME now that would be elapsed
    // against the original quote is NOT elapsed against a later
    // reactivation timestamp.
    const reactivatedAt = new Date(QUOTED_AT.getTime() + 200 * 60 * 60 * 1000);
    const shortlyAfterReactivation = new Date(reactivatedAt.getTime() + 1 * 60 * 60 * 1000);

    expect(hasGroupBuyPaymentWindowElapsed(QUOTED_AT, shortlyAfterReactivation)).toBe(true);
    expect(hasGroupBuyPaymentWindowElapsed(reactivatedAt, shortlyAfterReactivation)).toBe(false);
  });
});

describe("resolveGroupBuyPaymentWindowStart", () => {
  it("uses quotedAt when the order has never been reactivated", () => {
    expect(resolveGroupBuyPaymentWindowStart({ quotedAt: QUOTED_AT, reactivatedAt: null })).toEqual(QUOTED_AT);
  });

  it("uses reactivatedAt in preference to quotedAt once the order has been reactivated", () => {
    const reactivatedAt = new Date(QUOTED_AT.getTime() + 200 * 60 * 60 * 1000);
    expect(resolveGroupBuyPaymentWindowStart({ quotedAt: QUOTED_AT, reactivatedAt })).toEqual(reactivatedAt);
  });
});

/**
 * TWO DEADLINES, AND THEY MUST NOT BE CONFUSED.
 *
 * `groupBuyPaymentWindowDeadline` is the 96-hour INACTIVATION instant — when
 * the sweep may set an unpaid order aside. `groupBuyInitialPaymentDeadline` is
 * the 48-hour date a CUSTOMER is given, matching the locked sentence "You have
 * 48 hours to send payment".
 *
 * The production configuration gate caught the instructions email printing the
 * 96-hour value under those words, so a customer would have read a date four
 * days out while being told forty-eight hours. These tests exist so the two
 * can never quietly become the same number again.
 */
describe("the customer deadline and the inactivation deadline are different instants", () => {
  const start = new Date("2026-10-05T00:00:00.000Z");

  it("the customer is given 48 hours", () => {
    expect(groupBuyInitialPaymentDeadline(start).toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("inactivation is 96 hours — initial window plus the one automatic extension", () => {
    expect(groupBuyPaymentWindowDeadline(start).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("they are exactly one extension apart, never equal", () => {
    const customer = groupBuyInitialPaymentDeadline(start).getTime();
    const inactivation = groupBuyPaymentWindowDeadline(start).getTime();
    expect(inactivation).toBeGreaterThan(customer);
    expect(inactivation - customer).toBe(GROUP_BUY_AUTOMATIC_EXTENSION_MS);
  });
});
