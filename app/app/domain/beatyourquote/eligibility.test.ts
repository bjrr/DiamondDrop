import { describe, expect, it } from "vitest";

import {
  BEAT_QUOTE_GUARANTEE_WINDOW_CALENDAR_DAYS,
  calendarDaysBetween,
  classifyBeatQuoteSubmission,
  InvalidBeatQuoteDateError,
} from "./eligibility";

/**
 * Built from the LOCKED acceptance cases, which the amendment calls
 * controlling. Amendment §4 cases 1-4 and original §"Acceptance Cases" 1-4 and
 * 9 are each named in the test they pin, so a failure points at the clause it
 * violates rather than at an abstraction.
 */

const SUBMITTED = "2026-10-08";

function on(daysBefore: number): string {
  const d = new Date(Date.parse(`${SUBMITTED}T00:00:00.000Z`) - daysBefore * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe("the 7-day boundary — amendment §4 cases 1 and 2", () => {
  it("case 1: a verified custom quote on DAY 7 is guarantee eligible", () => {
    const result = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(7),
      submittedOn: SUBMITTED,
      verification: "verified",
    });
    expect(result.quoteAgeInCalendarDays).toBe(7);
    expect(result.treatment).toBe("guarantee");
    expect(result.guaranteeEligible).toBe(true);
    expect(result.reason).toBe("recent_verified_custom_quote");
  });

  it("case 2: the SAME quote one day older is review-only — no guarantee, no fallback", () => {
    // The whole difference between a guaranteed match-or-beat plus a $100
    // benefit and a discretionary review is this one day, so it is pinned from
    // both sides rather than once.
    const result = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(8),
      submittedOn: SUBMITTED,
      verification: "verified",
    });
    expect(result.quoteAgeInCalendarDays).toBe(8);
    expect(result.treatment).toBe("review_only");
    expect(result.guaranteeEligible).toBe(false);
    expect(result.reason).toBe("custom_quote_older_than_window");
  });

  it("every day from 0 to 7 qualifies and every day from 8 to 30 does not", () => {
    // Swept rather than sampled: an off-by-one that only shows at one age is
    // exactly the defect this boundary invites.
    for (let age = 0; age <= 30; age++) {
      const result = classifyBeatQuoteSubmission({
        kind: "custom_quote",
        quoteIssuedOn: on(age),
        submittedOn: SUBMITTED,
        verification: "verified",
      });
      expect(result.guaranteeEligible, `age ${age} days`).toBe(age <= BEAT_QUOTE_GUARANTEE_WINDOW_CALENDAR_DAYS);
    }
  });

  it("case 3 (original): a 14-day-old legitimate quote is still accepted for review", () => {
    // "There is no need to reject an older quote solely because of age."
    const result = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(14),
      submittedOn: SUBMITTED,
      verification: "verified",
    });
    expect(result.treatment).toBe("review_only");
    // Reviewable, not rejected — a distinct outcome from "not eligible at all".
    expect(result.reason).toBe("custom_quote_older_than_window");
  });
});

describe("the amendment supersedes the original on online listings — §1 and §5", () => {
  it("case 3 (amendment): an active online listing is review-only regardless of verification", () => {
    // The ORIGINAL spec §2 is titled "Active Online Listed Item — Guarantee
    // Eligible When Qualified" and promises the fallback. Amendment §1
    // supersedes it entirely. This test is the guard against someone
    // implementing from the original document.
    for (const verification of ["pending", "verified", "rejected"] as const) {
      const result = classifyBeatQuoteSubmission({
        kind: "online_listing",
        submittedOn: SUBMITTED,
        verification,
      });
      expect(result.treatment, `verification=${verification}`).toBe("review_only");
      expect(result.guaranteeEligible).toBe(false);
      expect(result.reason).toBe("online_listing_review_only");
    }
  });

  it("an online listing has NO age rule at all", () => {
    // Amendment §1: "There is no 7-day age rule for an active online listing
    // because the listing is review-only."
    const result = classifyBeatQuoteSubmission({
      kind: "online_listing",
      quoteIssuedOn: on(3),
      submittedOn: SUBMITTED,
      verification: "verified",
    });
    expect(result.quoteAgeInCalendarDays).toBeNull();
    expect(result.guaranteeEligible).toBe(false);
  });
});

describe("case 4: a competing Group Buy is review-only", () => {
  it("never carries the guarantee, at any verification state", () => {
    for (const verification of ["pending", "verified", "rejected"] as const) {
      const result = classifyBeatQuoteSubmission({
        kind: "competing_group_buy",
        submittedOn: SUBMITTED,
        verification,
      });
      expect(result.treatment).toBe("review_only");
      expect(result.guaranteeEligible).toBe(false);
      expect(result.reason).toBe("competing_group_buy_review_only");
    }
  });
});

describe("verification is a separate gate from age", () => {
  it("a recent quote that is NOT YET verified is not guarantee eligible", () => {
    // `pending` is the initial state. Treating "not yet checked" as eligible is
    // how an unverifiable quote earns a benefit.
    const result = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(1),
      submittedOn: SUBMITTED,
      verification: "pending",
    });
    expect(result.guaranteeEligible).toBe(false);
    expect(result.reason).toBe("custom_quote_not_verified");
  });

  it("case 6: a rejected (fake/altered/AI-generated) recent quote earns nothing", () => {
    const result = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(0),
      submittedOn: SUBMITTED,
      verification: "rejected",
    });
    expect(result.guaranteeEligible).toBe(false);
    expect(result.reason).toBe("custom_quote_not_verified");
  });

  it("the reason distinguishes 'too old' from 'not verified'", () => {
    // Different remedies: one the customer cannot fix, the other staff can.
    // A single "not eligible" would tell a reviewer nothing.
    const old = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(9),
      submittedOn: SUBMITTED,
      verification: "verified",
    });
    const unverified = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: on(1),
      submittedOn: SUBMITTED,
      verification: "pending",
    });
    expect(old.reason).not.toBe(unverified.reason);
  });
});

describe("incoherent dates are not guarantees", () => {
  it("a quote dated AFTER submission is review-only, not a negative age sailing through", () => {
    // `age <= 7` would happily accept -3. A quote from the future is bad
    // evidence, and a reviewer should see it rather than a guarantee.
    const result = classifyBeatQuoteSubmission({
      kind: "custom_quote",
      quoteIssuedOn: "2026-10-11",
      submittedOn: SUBMITTED,
      verification: "verified",
    });
    expect(result.quoteAgeInCalendarDays).toBe(-3);
    expect(result.guaranteeEligible).toBe(false);
  });

  it("a custom quote with no issue date is refused outright, not treated as age zero", () => {
    expect(() =>
      classifyBeatQuoteSubmission({ kind: "custom_quote", submittedOn: SUBMITTED, verification: "verified" })
    ).toThrow(InvalidBeatQuoteDateError);
  });
});

describe("calendarDaysBetween", () => {
  it("counts calendar days exactly, including across a month and year boundary", () => {
    expect(calendarDaysBetween("2026-10-01", "2026-10-08")).toBe(7);
    expect(calendarDaysBetween("2026-10-08", "2026-10-08")).toBe(0);
    expect(calendarDaysBetween("2026-01-25", "2026-02-01")).toBe(7);
    expect(calendarDaysBetween("2025-12-28", "2026-01-04")).toBe(7);
  });

  it("counts a leap day as a day", () => {
    // 2028 is a leap year; 2026 is not. A naive month-arithmetic
    // implementation gets one of these wrong.
    expect(calendarDaysBetween("2028-02-25", "2028-03-03")).toBe(7);
    expect(calendarDaysBetween("2026-02-25", "2026-03-03")).toBe(6);
  });

  it("is unaffected by the machine's timezone, because it never reads one", () => {
    // The boundary must not move with the server's offset. Both operands are
    // parsed as UTC midnight, so this holds wherever it runs — asserted as a
    // property rather than left to a comment.
    expect(calendarDaysBetween("2026-03-07", "2026-03-09")).toBe(2);
    // A US DST transition weekend (2026-03-08). A local-time implementation
    // would compute 1.958… days here and truncate to 1.
    expect(calendarDaysBetween("2026-03-08", "2026-03-09")).toBe(1);
  });

  it("rejects anything that is not a plain calendar date", () => {
    for (const bad of ["2026-10-8", "10/08/2026", "2026-10-08T00:00:00Z", "", "not-a-date"]) {
      expect(() => calendarDaysBetween(bad, SUBMITTED), bad).toThrow(InvalidBeatQuoteDateError);
    }
  });

  it("rejects a well-shaped but impossible date", () => {
    // `2026-02-30` matches the pattern. Date.parse returns NaN for it in a
    // spec-compliant engine, and the guard turns that into a named error
    // rather than a NaN age that compares false against everything.
    expect(() => calendarDaysBetween("2026-02-30", SUBMITTED)).toThrow(InvalidBeatQuoteDateError);
  });
});
