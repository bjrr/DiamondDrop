import { describe, expect, it } from "vitest";

import { businessCalendarDate } from "./shopTimezone.server";

/**
 * The business-calendar boundary.
 *
 * This is the function the 7-day eligibility window is measured from, so a
 * one-day error here moves the line between a guaranteed match-or-beat plus a
 * $100 benefit and a discretionary review. The cases below are the three the
 * owner named: the last minute of a local day, the first minute of the next,
 * and the two DST transitions where a naive implementation drifts.
 *
 * `America/New_York` is the store's actual configured zone (verified against
 * Shopify's `shop.ianaTimezone` on 2026-10-10), and these tests use it as a
 * REAL example rather than as a constant the production code depends on — the
 * route resolves the zone from the store. The same cases are repeated for a
 * second zone, so a change of store timezone is a change of data and not a
 * rewrite of these expectations.
 */

const NY = "America/New_York";
const CHICAGO = "America/Chicago";

describe("the local-midnight boundary", () => {
  it("23:59 local is still the SAME calendar day", () => {
    // 2026-10-09 23:59 EDT is 2026-10-10 03:59 UTC. A UTC-based derivation
    // would call this the 10th and silently cost the customer a day of their
    // window.
    expect(businessCalendarDate(new Date("2026-10-10T03:59:00.000Z"), NY)).toBe("2026-10-09");
  });

  it("00:00 local is the NEXT calendar day", () => {
    // One minute later: 2026-10-10 00:00 EDT = 04:00 UTC.
    expect(businessCalendarDate(new Date("2026-10-10T04:00:00.000Z"), NY)).toBe("2026-10-10");
  });

  it("the minute either side of local midnight differs by exactly one day", () => {
    const before = businessCalendarDate(new Date("2026-10-10T03:59:59.999Z"), NY);
    const after = businessCalendarDate(new Date("2026-10-10T04:00:00.000Z"), NY);
    expect(before).toBe("2026-10-09");
    expect(after).toBe("2026-10-10");
  });

  it("a UTC reading of the same instant would disagree — which is the whole point", () => {
    // Stated as an assertion rather than a comment so the motivation cannot
    // quietly stop being true.
    const lateEvening = new Date("2026-10-10T03:59:00.000Z");
    expect(businessCalendarDate(lateEvening, NY)).toBe("2026-10-09");
    expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-10-10");
  });
});

describe("DST transitions", () => {
  it("spring forward: the day 02:00 never happens still resolves correctly", () => {
    // 2026-03-08 is the US spring-forward date. 01:59 EST = 06:59 UTC, and
    // 03:00 EDT = 07:00 UTC — the local hour 02:00 does not exist. Both
    // instants are the same calendar day.
    expect(businessCalendarDate(new Date("2026-03-08T06:59:00.000Z"), NY)).toBe("2026-03-08");
    expect(businessCalendarDate(new Date("2026-03-08T07:00:00.000Z"), NY)).toBe("2026-03-08");
  });

  it("spring forward: midnight either side of the transition day", () => {
    // 2026-03-08 00:00 EST = 05:00 UTC; 2026-03-09 00:00 EDT = 04:00 UTC.
    // Note the UTC offsets DIFFER — a fixed-offset implementation gets one of
    // these wrong.
    expect(businessCalendarDate(new Date("2026-03-08T05:00:00.000Z"), NY)).toBe("2026-03-08");
    expect(businessCalendarDate(new Date("2026-03-09T04:00:00.000Z"), NY)).toBe("2026-03-09");
    // And one minute before each is the previous day.
    expect(businessCalendarDate(new Date("2026-03-08T04:59:59.999Z"), NY)).toBe("2026-03-07");
    expect(businessCalendarDate(new Date("2026-03-09T03:59:59.999Z"), NY)).toBe("2026-03-08");
  });

  it("fall back: the hour that happens TWICE lands on the right day both times", () => {
    // 2026-11-01 is the US fall-back date. 01:30 occurs twice: once at
    // 05:30 UTC (EDT) and again at 06:30 UTC (EST). Both are 2026-11-01.
    expect(businessCalendarDate(new Date("2026-11-01T05:30:00.000Z"), NY)).toBe("2026-11-01");
    expect(businessCalendarDate(new Date("2026-11-01T06:30:00.000Z"), NY)).toBe("2026-11-01");
  });

  it("fall back: the boundary into the transition day, at the pre-transition offset", () => {
    // 2026-11-01 00:00 EDT = 04:00 UTC. The day STARTS on the summer offset
    // and ends on the winter one.
    expect(businessCalendarDate(new Date("2026-11-01T03:59:59.999Z"), NY)).toBe("2026-10-31");
    expect(businessCalendarDate(new Date("2026-11-01T04:00:00.000Z"), NY)).toBe("2026-11-01");
    // And out of it, at the POST-transition offset: 2026-11-02 00:00 EST =
    // 05:00 UTC.
    expect(businessCalendarDate(new Date("2026-11-02T04:59:59.999Z"), NY)).toBe("2026-11-01");
    expect(businessCalendarDate(new Date("2026-11-02T05:00:00.000Z"), NY)).toBe("2026-11-02");
  });
});

describe("the derivation follows the zone it is given, not the host's", () => {
  it("one instant resolves to different days in different store timezones", () => {
    // The reason the zone is resolved from the store and PERSISTED with each
    // submission: the same instant is a different business day depending on the
    // configuration, so a later store-timezone change must not reinterpret
    // history.
    const instant = new Date("2026-10-10T04:30:00.000Z");
    expect(businessCalendarDate(instant, NY)).toBe("2026-10-10"); // 00:30 EDT
    expect(businessCalendarDate(instant, CHICAGO)).toBe("2026-10-09"); // 23:30 CDT
  });

  it("the same boundary cases hold for a second zone", () => {
    // Chicago's midnight is an hour later in UTC than New York's, so these are
    // genuinely different instants rather than the same numbers relabelled.
    expect(businessCalendarDate(new Date("2026-10-10T04:59:59.999Z"), CHICAGO)).toBe("2026-10-09");
    expect(businessCalendarDate(new Date("2026-10-10T05:00:00.000Z"), CHICAGO)).toBe("2026-10-10");
  });

  it("works for a zone with a half-hour offset and a southern-hemisphere DST", () => {
    // Guards against anything that assumes whole-hour offsets or northern DST
    // dates. Kolkata is UTC+05:30 year round; Auckland's DST runs opposite to
    // the US.
    expect(businessCalendarDate(new Date("2026-10-09T18:29:59.999Z"), "Asia/Kolkata")).toBe("2026-10-09");
    expect(businessCalendarDate(new Date("2026-10-09T18:30:00.000Z"), "Asia/Kolkata")).toBe("2026-10-10");
    expect(businessCalendarDate(new Date("2026-01-14T10:59:59.999Z"), "Pacific/Auckland")).toBe("2026-01-14");
    expect(businessCalendarDate(new Date("2026-01-14T11:00:00.000Z"), "Pacific/Auckland")).toBe("2026-01-15");
  });

  it("always returns YYYY-MM-DD, which is what the eligibility domain requires", () => {
    for (const zone of [NY, CHICAGO, "Asia/Kolkata", "Pacific/Auckland", "UTC"]) {
      expect(businessCalendarDate(new Date("2026-06-15T12:00:00.000Z"), zone), zone).toMatch(
        /^\d{4}-\d{2}-\d{2}$/
      );
    }
  });
});
