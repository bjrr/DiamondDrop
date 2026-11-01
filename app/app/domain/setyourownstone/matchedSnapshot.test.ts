/**
 * The historical compatibility record.
 *
 * What these tests protect: that the snapshot captures enough to re-derive the
 * decision from scratch, including the policy figures in force at the time.
 * Without those, a later change to the ±0.3 mm allowance would make every past
 * verdict look unjustified even though it was correct when made.
 */
import { describe, expect, it } from "vitest";

import { buildMatchedSnapshot, MATCHED_SNAPSHOT_VERSION } from "./matchedSnapshot";
import { classify, type ReadySettingCompatibility } from "./matching";

const PRODUCT = "gid://shopify/Product/111";
const DECIDED = new Date("2026-11-01T12:34:56.000Z");
const POLICY = { prongSetToleranceUm: 300, reviewBandUm: 1_000 };

const PRONG_PEAR: ReadySettingCompatibility = {
  shopifyVariantGid: "gid://shopify/ProductVariant/222",
  shape: "pear",
  nominalLengthUm: 10_000,
  nominalWidthUm: 7_000,
  nominalDepthUm: 4_200,
  eligibleForSetYourOwnStone: true,
  prongSetToleranceEligible: true,
};

function snapshotFor(
  setting: ReadySettingCompatibility,
  stone: { lengthUm: number; widthUm: number }
) {
  const result = classify(
    { shape: "pear", lengthUm: stone.lengthUm, widthUm: stone.widthUm },
    setting,
    POLICY
  );
  return buildMatchedSnapshot({
    result,
    shopifyProductGid: PRODUCT,
    centerSizeOptionValueId: "gid://shopify/ProductOptionValue/9",
    centerSizeProfileId: "gid://shopify/Metaobject/55",
    policy: POLICY,
    decidedAt: DECIDED,
  });
}

describe("every field the owner listed is present", () => {
  const snap = snapshotFor(PRONG_PEAR, { lengthUm: 10_200, widthUm: 7_100 });

  it("records both Shopify identities and the option value", () => {
    expect(snap.shopifyProductGid).toBe(PRODUCT);
    expect(snap.shopifyVariantGid).toBe("gid://shopify/ProductVariant/222");
    expect(snap.centerSizeOptionValueId).toBe("gid://shopify/ProductOptionValue/9");
  });

  it("records which shared profile supplied the dimensions", () => {
    expect(snap.centerSizeProfileId).toBe("gid://shopify/Metaobject/55");
  });

  it("records shape and the nominal dimensions actually used", () => {
    expect(snap.shape).toBe("pear");
    expect(snap.nominalLengthUm).toBe(10_000);
    expect(snap.nominalWidthUm).toBe(7_000);
    expect(snap.nominalDepthUm).toBe(4_200);
  });

  it("records prong eligibility, the verdict and the rule", () => {
    expect(snap.prongSetToleranceEligible).toBe(true);
    expect(snap.status).toBe("automatic");
    expect(snap.rule).toBe("prong_set_tolerance");
  });

  it("records the exact decision time, not the write time", () => {
    expect(snap.decidedAt).toBe("2026-11-01T12:34:56.000Z");
  });

  it("carries a version from the very first row", () => {
    // Without it, "field absent" and "field not yet invented" are
    // indistinguishable forever.
    expect(snap.version).toBe(MATCHED_SNAPSHOT_VERSION);
  });
});

describe("the policy in force is part of the evidence", () => {
  it("records the figures the decision was made under", () => {
    // If the allowance later moves to 0.2 mm, a past 0.28 mm match must still
    // read as justified rather than as a bug.
    const snap = snapshotFor(PRONG_PEAR, { lengthUm: 10_280, widthUm: 7_000 });
    expect(snap.rule).toBe("prong_set_tolerance");
    expect(snap.policy).toEqual({ prongSetToleranceUm: 300, reviewBandUm: 1_000 });
  });

  it("copies the policy rather than holding a reference to it", () => {
    const mutable = { prongSetToleranceUm: 300, reviewBandUm: 1_000 };
    const snap = buildMatchedSnapshot({
      result: classify({ shape: "pear", lengthUm: 10_000, widthUm: 7_000 }, PRONG_PEAR, mutable),
      shopifyProductGid: PRODUCT,
      centerSizeOptionValueId: null,
      centerSizeProfileId: null,
      policy: mutable,
      decidedAt: DECIDED,
    });

    mutable.prongSetToleranceUm = 999;
    expect(snap.policy.prongSetToleranceUm).toBe(300);
  });
});

describe("millimetres are stored alongside micrometres", () => {
  it("renders the figures a person reads without dividing by a thousand", () => {
    const snap = snapshotFor(
      { ...PRONG_PEAR, nominalLengthUm: 10_250, nominalWidthUm: 7_080, nominalDepthUm: undefined },
      { lengthUm: 10_250, widthUm: 7_080 }
    );
    expect(snap.nominalLengthMm).toBe("10.25");
    expect(snap.nominalWidthMm).toBe("7.08");
    expect(snap.nominalDepthMm).toBeNull();
  });

  it("keeps the micrometres as the authoritative pair", () => {
    // The micrometres are what the decision was computed from, so they are
    // the evidence; the millimetres are for reading.
    const snap = snapshotFor(PRONG_PEAR, { lengthUm: 10_000, widthUm: 7_000 });
    expect(snap.nominalLengthUm).toBe(10_000);
    expect(snap.nominalLengthMm).toBe("10");
  });
});

describe("a vendor range is recorded whenever one existed", () => {
  const ranged: ReadySettingCompatibility = {
    ...PRONG_PEAR,
    minLengthUm: 9_900,
    maxLengthUm: 10_100,
    minWidthUm: 6_900,
    maxWidthUm: 7_100,
  };

  it("captures the bounds for a match made inside the range", () => {
    const snap = snapshotFor(ranged, { lengthUm: 10_000, widthUm: 7_000 });
    expect(snap.rule).toBe("vendor_range_inside");
    expect(snap.vendorRange).toMatchObject({
      minLengthUm: 9_900,
      maxLengthUm: 10_100,
      minWidthUm: 6_900,
      maxWidthUm: 7_100,
    });
  });

  it("captures them for a REFUSAL too, which is the harder case to explain", () => {
    // A stone inside our 0.3 mm allowance but outside the vendor's range. The
    // range's mere existence is what stopped the allowance being consulted, so
    // it is the evidence for why the answer was no.
    const snap = snapshotFor(ranged, { lengthUm: 10_250, widthUm: 7_000 });
    expect(snap.rule).toBe("vendor_range_outside");
    expect(snap.status).toBe("no_match");
    expect(snap.vendorRange).not.toBeNull();
    expect(snap.prongSetToleranceEligible).toBe(true);
  });

  it("is null when no range applied", () => {
    expect(snapshotFor(PRONG_PEAR, { lengthUm: 10_000, widthUm: 7_000 }).vendorRange).toBeNull();
  });

  it("ignores a half-specified range, exactly as the matcher does", () => {
    const half = { ...PRONG_PEAR, minLengthUm: 9_900, maxLengthUm: 10_100 };
    expect(snapshotFor(half, { lengthUm: 10_000, widthUm: 7_000 }).vendorRange).toBeNull();
  });
});

describe("the review and no-match verdicts are recorded as faithfully as matches", () => {
  it("records a review-required decision", () => {
    const snap = snapshotFor(PRONG_PEAR, { lengthUm: 10_500, widthUm: 7_400 });
    expect(snap.status).toBe("review_required");
    expect(snap.rule).toBe("review_band");
  });

  it("records a beyond-the-band refusal", () => {
    const snap = snapshotFor(PRONG_PEAR, { lengthUm: 12_000, widthUm: 7_000 });
    expect(snap.status).toBe("no_match");
    expect(snap.rule).toBe("outside_all_rules");
  });

  it("records a mounting that was not prong-adjustable", () => {
    const bezel = { ...PRONG_PEAR, prongSetToleranceEligible: false };
    const snap = snapshotFor(bezel, { lengthUm: 10_200, widthUm: 7_100 });
    expect(snap.prongSetToleranceEligible).toBe(false);
    expect(snap.status).not.toBe("automatic");
  });
});

describe("the snapshot is serialisable, because it is stored as JSON", () => {
  it("survives a JSON round trip unchanged", () => {
    const snap = snapshotFor(PRONG_PEAR, { lengthUm: 10_200, widthUm: 7_100 });
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("holds no Date objects, which would become strings asymmetrically", () => {
    const snap = snapshotFor(PRONG_PEAR, { lengthUm: 10_000, widthUm: 7_000 });
    expect(typeof snap.decidedAt).toBe("string");
  });
});
