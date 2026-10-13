import { describe, expect, it } from "vitest";

import {
  EXCLUDE_ARCHIVED_CAMPAIGNS,
  EXCLUDE_TEST_FIXTURE_CAMPAIGNS,
  PUBLIC_PAST_GROUP_BUY_CAMPAIGNS,
  STAFF_ARCHIVED_ONLY,
  STAFF_OPERATIONAL_CAMPAIGNS,
} from "./campaignVisibility";

/**
 * THE DISTINCTION THESE TESTS EXIST FOR (owner-locked 2026-10-05):
 * internal staff archiving and the public Past Group Buys archive are
 * different questions. A completed customer campaign may belong in public
 * history even after staff archive it internally; a test campaign must never
 * appear there, archived or not.
 */
describe("campaign visibility keeps staff archiving separate from the public archive", () => {
  it("the public archive does NOT filter on archivedAt — staff tidying must not erase public history", () => {
    // The single most important assertion in this file. If `archivedAt` ever
    // appears here, archiving a campaign for dashboard hygiene would silently
    // remove a real completed Group Buy from what customers can see.
    expect(Object.keys(PUBLIC_PAST_GROUP_BUY_CAMPAIGNS)).not.toContain("archivedAt");
  });

  it("the public archive excludes fixtures unconditionally", () => {
    expect(PUBLIC_PAST_GROUP_BUY_CAMPAIGNS).toMatchObject(EXCLUDE_TEST_FIXTURE_CAMPAIGNS);
  });

  it("the public archive is closed campaigns only — 'past' means past", () => {
    expect(PUBLIC_PAST_GROUP_BUY_CAMPAIGNS.status).toBe("closed");
  });

  it("the default staff view hides both fixtures and archived campaigns", () => {
    expect(STAFF_OPERATIONAL_CAMPAIGNS).toMatchObject(EXCLUDE_TEST_FIXTURE_CAMPAIGNS);
    expect(STAFF_OPERATIONAL_CAMPAIGNS).toMatchObject(EXCLUDE_ARCHIVED_CAMPAIGNS);
  });

  it("the archived view is the exact complement of the archive exclusion", () => {
    // Together they must partition every campaign: nothing may be invisible in
    // BOTH views, or archiving would make history unreachable to staff —
    // which the owner explicitly forbade.
    expect(EXCLUDE_ARCHIVED_CAMPAIGNS).toEqual({ archivedAt: null });
    expect(STAFF_ARCHIVED_ONLY).toEqual({ archivedAt: { not: null } });
  });

  it("archive exclusion says nothing about the campaign code, and fixture exclusion nothing about archiving", () => {
    // Kept orthogonal on purpose. Folding them into one "visible" flag is how
    // a future surface would get the public-archive question wrong.
    expect(Object.keys(EXCLUDE_ARCHIVED_CAMPAIGNS)).toEqual(["archivedAt"]);
    expect(Object.keys(EXCLUDE_TEST_FIXTURE_CAMPAIGNS)).toEqual(["code"]);
  });
});
