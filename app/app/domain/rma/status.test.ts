import { describe, expect, it } from "vitest";
import { decideRmaTransition, mayIssueReturnInstructions, type RmaTransitionState } from "./status";

function state(overrides: Partial<RmaTransitionState> = {}): RmaTransitionState {
  return { status: "submitted", receivedAt: null, ...overrides };
}

describe("decideRmaTransition — the happy path, end to end", () => {
  it("submitted -> approved -> return_shipped -> received_inspection_pending -> inspection_passed -> remedy_in_progress -> resolved -> closed", () => {
    let current = state();

    let result = decideRmaTransition(current, { type: "approve" });
    expect(result).toEqual({ ok: true, nextStatus: "approved" });
    current = state({ status: "approved" });

    result = decideRmaTransition(current, { type: "mark_return_shipped" });
    expect(result).toEqual({ ok: true, nextStatus: "return_shipped" });
    current = state({ status: "return_shipped" });

    result = decideRmaTransition(current, { type: "record_receipt" });
    expect(result).toEqual({ ok: true, nextStatus: "received_inspection_pending" });
    current = state({ status: "received_inspection_pending", receivedAt: new Date() });

    result = decideRmaTransition(current, { type: "decide_condition", decision: "accepted" });
    expect(result).toEqual({ ok: true, nextStatus: "inspection_passed" });
    current = state({ status: "inspection_passed", receivedAt: new Date() });

    result = decideRmaTransition(current, { type: "begin_remedy" });
    expect(result).toEqual({ ok: true, nextStatus: "remedy_in_progress" });
    current = state({ status: "remedy_in_progress", receivedAt: new Date() });

    result = decideRmaTransition(current, { type: "resolve" });
    expect(result).toEqual({ ok: true, nextStatus: "resolved" });
    current = state({ status: "resolved", receivedAt: new Date() });

    result = decideRmaTransition(current, { type: "close" });
    expect(result).toEqual({ ok: true, nextStatus: "closed" });
  });

  it("record_receipt is also legal directly from approved, skipping return_shipped", () => {
    const result = decideRmaTransition(state({ status: "approved" }), { type: "record_receipt" });
    expect(result).toEqual({ ok: true, nextStatus: "received_inspection_pending" });
  });
});

describe("deny — criterion 202-sibling reasoning", () => {
  it("submitted -> denied with a reason succeeds", () => {
    const result = decideRmaTransition(state(), { type: "deny", reason: "requires claim workflow" });
    expect(result).toEqual({ ok: true, nextStatus: "denied" });
  });

  it("an empty-string reason is refused", () => {
    const result = decideRmaTransition(state(), { type: "deny", reason: "   " });
    expect(result.ok).toBe(false);
  });

  it("deny is not legal once approved", () => {
    const result = decideRmaTransition(state({ status: "approved" }), { type: "deny", reason: "whatever" });
    expect(result.ok).toBe(false);
  });
});

describe("expire — criterion 198", () => {
  it("approved -> expired is legal when nothing was ever received", () => {
    const result = decideRmaTransition(state({ status: "approved" }), { type: "expire" });
    expect(result).toEqual({ ok: true, nextStatus: "expired" });
  });

  it("return_shipped -> expired is legal", () => {
    const result = decideRmaTransition(state({ status: "return_shipped" }), { type: "expire" });
    expect(result).toEqual({ ok: true, nextStatus: "expired" });
  });

  it("expire is refused once a receipt has been recorded", () => {
    const result = decideRmaTransition(state({ status: "approved", receivedAt: new Date() }), { type: "expire" });
    expect(result.ok).toBe(false);
  });

  it("expire is not legal from submitted", () => {
    const result = decideRmaTransition(state(), { type: "expire" });
    expect(result.ok).toBe(false);
  });
});

describe("decide_condition ordering — criterion 202", () => {
  it("cannot precede a recorded receipt (wrong status)", () => {
    const result = decideRmaTransition(state({ status: "approved" }), {
      type: "decide_condition",
      decision: "accepted",
    });
    expect(result.ok).toBe(false);
  });

  it("cannot precede a recorded receipt (right status, no receivedAt — defense in depth)", () => {
    const result = decideRmaTransition(state({ status: "received_inspection_pending", receivedAt: null }), {
      type: "decide_condition",
      decision: "accepted",
    });
    expect(result.ok).toBe(false);
  });

  it("a rejected decision without a reason is refused", () => {
    const result = decideRmaTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date() }),
      { type: "decide_condition", decision: "rejected", reason: "" }
    );
    expect(result.ok).toBe(false);
  });

  it("a rejected decision with a reason succeeds, landing on inspection_failed", () => {
    const result = decideRmaTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date() }),
      { type: "decide_condition", decision: "rejected", reason: "item shows wear beyond try-on" }
    );
    expect(result).toEqual({ ok: true, nextStatus: "inspection_failed" });
  });
});

describe("resolve cannot be reached without a decision — criterion 202's second ordering", () => {
  it("resolve is not legal from received_inspection_pending", () => {
    const result = decideRmaTransition(
      state({ status: "received_inspection_pending", receivedAt: new Date() }),
      { type: "resolve" }
    );
    expect(result.ok).toBe(false);
  });

  it("resolve IS legal from inspection_failed", () => {
    const result = decideRmaTransition(state({ status: "inspection_failed", receivedAt: new Date() }), {
      type: "resolve",
    });
    expect(result).toEqual({ ok: true, nextStatus: "resolved" });
  });

  it("resolve is not legal from submitted", () => {
    const result = decideRmaTransition(state(), { type: "resolve" });
    expect(result.ok).toBe(false);
  });
});

describe("close", () => {
  it("close is only legal from resolved", () => {
    expect(decideRmaTransition(state({ status: "resolved" }), { type: "close" }).ok).toBe(true);
    expect(decideRmaTransition(state({ status: "remedy_in_progress" }), { type: "close" }).ok).toBe(false);
  });
});

describe("mayIssueReturnInstructions — criterion 199", () => {
  it("false before approval", () => {
    expect(mayIssueReturnInstructions({ approvedAt: null })).toBe(false);
  });

  it("true once approved", () => {
    expect(mayIssueReturnInstructions({ approvedAt: new Date() })).toBe(true);
  });

  it("stays true even once the request has moved past approved — approval is never revoked by a later status", () => {
    // The function only ever looks at approvedAt, which a later status transition never clears.
    expect(mayIssueReturnInstructions({ approvedAt: new Date("2026-01-01") })).toBe(true);
  });
});
