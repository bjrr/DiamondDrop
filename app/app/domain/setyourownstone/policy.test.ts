/**
 * The matching policy actually in force.
 *
 * `matching.test.ts` proves the RULES behave correctly for a policy handed to
 * them. This file proves the policy we hand them is the one the owner locked
 * on 2026-10-31 — the gap between "the tolerance works" and "the tolerance is
 * 0.3 mm" is exactly where a decision gets quietly lost.
 */
import { describe, expect, it } from "vitest";

import { classify, type ReadySettingCompatibility } from "./matching";
import { resolveMatchingPolicy } from "./policy.server";

const PRONG_OVAL_10x7: ReadySettingCompatibility = {
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  shape: "oval",
  nominalLengthUm: 10_000,
  nominalWidthUm: 7_000,
  eligibleForSetYourOwnStone: true,
  prongSetToleranceEligible: true,
};

describe("the locked matching policy (owner decision 2026-10-31)", () => {
  it("sets the prong-setting tolerance to exactly 0.3 mm", () => {
    // In micrometres, because a fit allowance measured in floats is a
    // rounding argument waiting to happen.
    return resolveMatchingPolicy().then((p) => {
      expect(p.prongSetToleranceUm).toBe(300);
    });
  });

  it("leaves the per-shape tolerance empty", () => {
    // The approved allowance is a property of the MOUNTING's setting style,
    // not of the stone's shape. Populating the per-shape map with 300 would
    // hand the same allowance to bezel and channel mountings, which is the
    // one thing the decision explicitly excludes.
    return resolveMatchingPolicy().then((p) => {
      expect(p.approvedToleranceUmByShape).toEqual({});
    });
  });

  it("opens a review band wide enough for the owner's own Review Required example", () => {
    // The decision's third example — 10.5 x 7.4 against 10 x 7, so 0.5 mm
    // and 0.4 mm out — must read Review Required. That fixes a floor of
    // 0.5 mm on the band; anything narrower would call the owner's example a
    // no-match.
    return resolveMatchingPolicy().then((p) => {
      expect(p.reviewBandUm).toBeGreaterThanOrEqual(500);
    });
  });

  it("keeps the review band bounded, so irrelevant mountings are never offered", () => {
    // §6.4 forbids showing irrelevant mountings as if compatible. An
    // open-ended band would label a 10 x 7 mounting "may work" for a 15 x 9
    // stone.
    return resolveMatchingPolicy().then((p) => {
      expect(p.reviewBandUm).toBeLessThan(5_000);
    });
  });

  it("reproduces all three of the decision's worked examples through the real policy", async () => {
    const policy = await resolveMatchingPolicy();

    // 10.2 x 7.1 -> matches
    expect(classify({ shape: "oval", lengthUm: 10_200, widthUm: 7_100 }, PRONG_OVAL_10x7, policy))
      .toMatchObject({ status: "automatic", rule: "prong_set_tolerance" });

    // 10.3 x 7.3 -> still qualifies
    expect(classify({ shape: "oval", lengthUm: 10_300, widthUm: 7_300 }, PRONG_OVAL_10x7, policy))
      .toMatchObject({ status: "automatic", rule: "prong_set_tolerance" });

    // 10.5 x 7.4 -> Review Required
    expect(classify({ shape: "oval", lengthUm: 10_500, widthUm: 7_400 }, PRONG_OVAL_10x7, policy))
      .toMatchObject({ status: "review_required" });
  });

  it("grants nothing to a mounting that has not been assessed as prong-set", async () => {
    const policy = await resolveMatchingPolicy();
    const unassessed = { ...PRONG_OVAL_10x7, prongSetToleranceEligible: false };

    // The database column defaults to false, so this is the state every
    // existing and newly imported row starts in. It must be safe.
    const r = classify({ shape: "oval", lengthUm: 10_200, widthUm: 7_100 }, unassessed, policy);
    expect(r.status).not.toBe("automatic");
  });
});
