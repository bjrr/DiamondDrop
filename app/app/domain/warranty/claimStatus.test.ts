import { describe, expect, it } from "vitest";

import {
  decideWarrantyClaimTransition,
  mayIssueInboundShippingInstructions,
  type WarrantyClaimAction,
  type WarrantyClaimStatus,
  type WarrantyClaimTransitionState,
} from "./claimStatus";

function state(overrides: Partial<WarrantyClaimTransitionState> = {}): WarrantyClaimTransitionState {
  return {
    status: "submitted",
    pausedFromStatus: null,
    receivedAt: null,
    ...overrides,
  };
}

describe("decideWarrantyClaimTransition — every legal transition", () => {
  it("submitted -> under_review via start_review", () => {
    const result = decideWarrantyClaimTransition(state({ status: "submitted" }), { type: "start_review" });
    expect(result).toEqual({ ok: true, nextStatus: "under_review", nextPausedFromStatus: null });
  });

  it("under_review -> more_information_requested via request_more_information, recording the pause origin", () => {
    const result = decideWarrantyClaimTransition(state({ status: "under_review" }), {
      type: "request_more_information",
    });
    expect(result).toEqual({ ok: true, nextStatus: "more_information_requested", nextPausedFromStatus: "under_review" });
  });

  it("more_information_requested (paused from under_review) resumes to under_review", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "more_information_requested", pausedFromStatus: "under_review" }),
      { type: "resume_after_more_information" }
    );
    expect(result).toEqual({ ok: true, nextStatus: "under_review", nextPausedFromStatus: null });
  });

  it("under_review -> authorized_for_inspection via authorize_for_inspection", () => {
    const result = decideWarrantyClaimTransition(state({ status: "under_review" }), {
      type: "authorize_for_inspection",
    });
    expect(result).toEqual({ ok: true, nextStatus: "authorized_for_inspection", nextPausedFromStatus: null });
  });

  it("authorized_for_inspection -> in_transit_to_carat_for_us via mark_in_transit", () => {
    const result = decideWarrantyClaimTransition(state({ status: "authorized_for_inspection" }), {
      type: "mark_in_transit",
    });
    expect(result).toEqual({ ok: true, nextStatus: "in_transit_to_carat_for_us", nextPausedFromStatus: null });
  });

  it("in_transit_to_carat_for_us -> received_inspection_pending via record_receipt", () => {
    const result = decideWarrantyClaimTransition(state({ status: "in_transit_to_carat_for_us" }), {
      type: "record_receipt",
    });
    expect(result).toEqual({ ok: true, nextStatus: "received_inspection_pending", nextPausedFromStatus: null });
  });

  it("received_inspection_pending -> more_information_requested, recording that pause origin too", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date("2026-09-01T00:00:00Z") }),
      { type: "request_more_information" }
    );
    expect(result).toEqual({
      ok: true,
      nextStatus: "more_information_requested",
      nextPausedFromStatus: "received_inspection_pending",
    });
  });

  it("more_information_requested (paused from received_inspection_pending) resumes there, not to under_review", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "more_information_requested", pausedFromStatus: "received_inspection_pending" }),
      { type: "resume_after_more_information" }
    );
    expect(result).toEqual({
      ok: true,
      nextStatus: "received_inspection_pending",
      nextPausedFromStatus: null,
    });
  });

  it("received_inspection_pending -> approved_covered via decide_coverage(covered), with receivedAt recorded", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date("2026-09-01T00:00:00Z") }),
      { type: "decide_coverage", decision: "covered" }
    );
    expect(result).toEqual({ ok: true, nextStatus: "approved_covered", nextPausedFromStatus: null });
  });

  it("received_inspection_pending -> denied_not_covered via decide_coverage(not_covered) with a reason", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date("2026-09-01T00:00:00Z") }),
      { type: "decide_coverage", decision: "not_covered", reason: "wear consistent with normal use, not a defect" }
    );
    expect(result).toEqual({ ok: true, nextStatus: "denied_not_covered", nextPausedFromStatus: null });
  });

  it("approved_covered -> remedy_in_progress via begin_remedy", () => {
    const result = decideWarrantyClaimTransition(state({ status: "approved_covered" }), { type: "begin_remedy" });
    expect(result).toEqual({ ok: true, nextStatus: "remedy_in_progress", nextPausedFromStatus: null });
  });

  it("remedy_in_progress -> resolved via resolve", () => {
    const result = decideWarrantyClaimTransition(state({ status: "remedy_in_progress" }), { type: "resolve" });
    expect(result).toEqual({ ok: true, nextStatus: "resolved", nextPausedFromStatus: null });
  });

  it("denied_not_covered -> resolved via resolve (no remedy required for a denial)", () => {
    const result = decideWarrantyClaimTransition(state({ status: "denied_not_covered" }), { type: "resolve" });
    expect(result).toEqual({ ok: true, nextStatus: "resolved", nextPausedFromStatus: null });
  });

  it("resolved -> closed via close", () => {
    const result = decideWarrantyClaimTransition(state({ status: "resolved" }), { type: "close" });
    expect(result).toEqual({ ok: true, nextStatus: "closed", nextPausedFromStatus: null });
  });
});

describe("decideWarrantyClaimTransition — criterion 159: no coverage decision without a recorded receipt", () => {
  it("refuses decide_coverage from any status other than received_inspection_pending", () => {
    const nonReceivedStatuses: WarrantyClaimStatus[] = [
      "submitted",
      "under_review",
      "more_information_requested",
      "authorized_for_inspection",
      "in_transit_to_carat_for_us",
      "approved_covered",
      "denied_not_covered",
      "remedy_in_progress",
      "resolved",
      "closed",
    ];
    for (const status of nonReceivedStatuses) {
      const result = decideWarrantyClaimTransition(state({ status }), { type: "decide_coverage", decision: "covered" });
      expect(result.ok, `expected decide_coverage to be refused from ${status}`).toBe(false);
    }
  });

  it("refuses decide_coverage from received_inspection_pending with no recorded receivedAt (defensive, belt-and-suspenders)", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "received_inspection_pending", receivedAt: null }),
      { type: "decide_coverage", decision: "covered" }
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("receivedAt is null") });
  });

  it("cannot reach received_inspection_pending except through record_receipt — more_information_requested does not shortcut it", () => {
    // Paused from under_review (i.e. never received), resuming must go back
    // to under_review, never to received_inspection_pending.
    const resumed = decideWarrantyClaimTransition(
      state({ status: "more_information_requested", pausedFromStatus: "under_review" }),
      { type: "resume_after_more_information" }
    );
    expect(resumed.ok && resumed.nextStatus).toBe("under_review");
  });
});

describe("decideWarrantyClaimTransition — criterion 160: a denial without a reason is not a valid state", () => {
  it("refuses decide_coverage(not_covered) with a whitespace-only reason", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date() }),
      { type: "decide_coverage", decision: "not_covered", reason: "   " }
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("non-empty reason") });
  });

  // A `not_covered` decision with NO reason at all does not typecheck —
  // `reason` is required in that branch of the discriminated union. That is
  // the type-level half of this criterion; the runtime check above covers
  // what the type system cannot (an empty string is a valid `string`).
});

describe("decideWarrantyClaimTransition — criterion 168: resolved cannot precede decided", () => {
  it("refuses resolve from every status except remedy_in_progress and denied_not_covered", () => {
    const otherStatuses: WarrantyClaimStatus[] = [
      "submitted",
      "under_review",
      "more_information_requested",
      "authorized_for_inspection",
      "in_transit_to_carat_for_us",
      "received_inspection_pending",
      "approved_covered",
      "resolved",
      "closed",
    ];
    for (const status of otherStatuses) {
      const result = decideWarrantyClaimTransition(state({ status }), { type: "resolve" });
      expect(result.ok, `expected resolve to be refused from ${status}`).toBe(false);
    }
  });

  it("refuses begin_remedy from anywhere except approved_covered — a claim cannot start a remedy undecided", () => {
    const result = decideWarrantyClaimTransition(state({ status: "received_inspection_pending" }), {
      type: "begin_remedy",
    });
    expect(result.ok).toBe(false);
  });
});

describe("decideWarrantyClaimTransition — a representative set of other illegal transitions are refused, not recorded", () => {
  const illegal: ReadonlyArray<{ status: WarrantyClaimStatus; action: WarrantyClaimAction }> = [
    { status: "submitted", action: { type: "authorize_for_inspection" } },
    { status: "submitted", action: { type: "request_more_information" } },
    { status: "closed", action: { type: "start_review" } },
    { status: "closed", action: { type: "close" } },
    { status: "authorized_for_inspection", action: { type: "record_receipt" } },
    { status: "denied_not_covered", action: { type: "begin_remedy" } },
    { status: "approved_covered", action: { type: "resolve" } },
    { status: "resolved", action: { type: "resolve" } },
  ];

  for (const { status, action } of illegal) {
    it(`refuses ${action.type} from ${status}`, () => {
      const result = decideWarrantyClaimTransition(state({ status }), action);
      expect(result.ok).toBe(false);
    });
  }

  it("resume_after_more_information refuses when not currently paused", () => {
    const result = decideWarrantyClaimTransition(state({ status: "under_review" }), {
      type: "resume_after_more_information",
    });
    expect(result.ok).toBe(false);
  });

  it("resume_after_more_information refuses a data-integrity gap (paused with no recorded origin) rather than guessing", () => {
    const result = decideWarrantyClaimTransition(
      state({ status: "more_information_requested", pausedFromStatus: null }),
      { type: "resume_after_more_information" }
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no recorded pausedFromStatus") });
  });
});

describe("mayIssueInboundShippingInstructions — criterion 156", () => {
  it("is false before authorization", () => {
    expect(mayIssueInboundShippingInstructions({ authorizedAt: null })).toBe(false);
  });

  it("is true once authorizedAt is recorded", () => {
    expect(mayIssueInboundShippingInstructions({ authorizedAt: new Date("2026-09-01T00:00:00Z") })).toBe(true);
  });
});
