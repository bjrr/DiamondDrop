import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  calendarDaysSinceDelivery,
  classifyReturnWindow,
  computeLateReceiveByDeadline,
  computeReceiveByDeadline,
  computeStandardReceiveByDeadline,
  isReceivedWithinDeadline,
  RmaWindowError,
  validateRequestedRemedy,
} from "./window";

describe("calendarDaysBetween / calendarDaysSinceDelivery", () => {
  it("counts whole calendar days, discarding time-of-day", () => {
    const delivery = new Date("2026-01-01T23:00:00Z");
    const requested = new Date("2026-01-08T01:00:00Z");
    expect(calendarDaysBetween(delivery, requested)).toBe(7);
  });

  it("is zero on the delivery day itself", () => {
    const delivery = new Date("2026-01-01T00:00:00Z");
    expect(calendarDaysSinceDelivery(delivery, new Date("2026-01-01T18:00:00Z"))).toBe(0);
  });

  it("throws if the request precedes delivery — a data error, not '0 days early'", () => {
    const delivery = new Date("2026-01-10T00:00:00Z");
    const requested = new Date("2026-01-01T00:00:00Z");
    expect(() => calendarDaysSinceDelivery(delivery, requested)).toThrow(RmaWindowError);
  });
});

describe("classifyReturnWindow — criterion 185", () => {
  it("day 0 is standard", () => {
    expect(classifyReturnWindow(0)).toBe("standard");
  });

  it("day 7 is standard (the boundary)", () => {
    expect(classifyReturnWindow(7)).toBe("standard");
  });

  it("day 8 is late (the boundary)", () => {
    expect(classifyReturnWindow(8)).toBe("late");
  });

  it("day 30 is late (the boundary)", () => {
    expect(classifyReturnWindow(30)).toBe("late");
  });

  it("day 31 is ineligible (the boundary)", () => {
    expect(classifyReturnWindow(31)).toBe("ineligible");
  });

  it("day 90 is ineligible", () => {
    expect(classifyReturnWindow(90)).toBe("ineligible");
  });

  it("rejects a negative day count", () => {
    expect(() => classifyReturnWindow(-1)).toThrow(RmaWindowError);
  });

  it("rejects a non-integer day count", () => {
    expect(() => classifyReturnWindow(3.5)).toThrow(RmaWindowError);
  });
});

describe("validateRequestedRemedy — criterion 188", () => {
  it("standard window with no remedy chosen is valid", () => {
    expect(validateRequestedRemedy("standard", null)).toEqual({ ok: true });
  });

  it("standard window with a remedy chosen is refused", () => {
    const result = validateRequestedRemedy("standard", "refund_original_payment");
    expect(result.ok).toBe(false);
  });

  it("late window with refund_original_payment chosen is valid", () => {
    expect(validateRequestedRemedy("late", "refund_original_payment")).toEqual({ ok: true });
  });

  it("late window with merchandise_credit chosen is valid", () => {
    expect(validateRequestedRemedy("late", "merchandise_credit")).toEqual({ ok: true });
  });

  it("late window with no remedy chosen is refused", () => {
    const result = validateRequestedRemedy("late", null);
    expect(result.ok).toBe(false);
  });
});

describe("receive-by deadlines — criterion 198", () => {
  it("standard deadline is delivery + 14 calendar days", () => {
    const delivery = new Date("2026-03-01T00:00:00Z");
    const deadline = computeStandardReceiveByDeadline(delivery);
    expect(deadline.toISOString().slice(0, 10)).toBe("2026-03-15");
  });

  it("late deadline is approval + 10 calendar days", () => {
    const approvedAt = new Date("2026-03-01T12:00:00Z");
    const deadline = computeLateReceiveByDeadline(approvedAt);
    expect(deadline.toISOString().slice(0, 10)).toBe("2026-03-11");
  });

  it("computeReceiveByDeadline dispatches on windowKind", () => {
    const delivery = new Date("2026-03-01T00:00:00Z");
    const approvedAt = new Date("2026-03-05T00:00:00Z");
    expect(computeReceiveByDeadline("standard", delivery, approvedAt).toISOString().slice(0, 10)).toBe("2026-03-15");
    expect(computeReceiveByDeadline("late", delivery, approvedAt).toISOString().slice(0, 10)).toBe("2026-03-15");
  });

  it("received exactly on the deadline day still qualifies — 'no later than' is inclusive", () => {
    const deadline = new Date("2026-03-15T00:00:00Z");
    const receivedAt = new Date("2026-03-15T23:59:00Z");
    expect(isReceivedWithinDeadline(receivedAt, deadline)).toBe(true);
  });

  it("received one day after the deadline does not qualify", () => {
    const deadline = new Date("2026-03-15T00:00:00Z");
    const receivedAt = new Date("2026-03-16T00:01:00Z");
    expect(isReceivedWithinDeadline(receivedAt, deadline)).toBe(false);
  });

  it("received before the deadline qualifies", () => {
    const deadline = new Date("2026-03-15T00:00:00Z");
    const receivedAt = new Date("2026-03-10T00:00:00Z");
    expect(isReceivedWithinDeadline(receivedAt, deadline)).toBe(true);
  });
});
