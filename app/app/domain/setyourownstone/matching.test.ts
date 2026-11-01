/**
 * Set Your Own Stone matching — the cases docs/SET-YOUR-OWN-STONE.md §11
 * names explicitly, plus the ones that would be embarrassing to get wrong.
 *
 * The headline test is `carat alone never matches`: two stones of identical
 * carat weight and different millimetres must reach opposite verdicts. It is
 * the acceptance criterion (§15.5) that the whole feature exists to satisfy,
 * and the easiest one to regress by "helpfully" adding carat to a filter.
 */
import { describe, expect, it } from "vitest";

import {
  COMPATIBILITY_LABELS,
  DEFAULT_MATCHING_POLICY,
  classify,
  labelFor,
  matchSettings,
  micrometresToMm,
  mmToMicrometres,
  type MatchingPolicy,
  type ReadySettingCompatibility,
  type StoneDimensions,
} from "./matching";

/** An oval mounting nominally for a 10 x 7 mm centre. */
const OVAL_10x7: ReadySettingCompatibility = {
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  shape: "oval",
  nominalLengthUm: 10_000,
  nominalWidthUm: 7_000,
  eligibleForSetYourOwnStone: true,
};

const ROUND_6: ReadySettingCompatibility = {
  shopifyVariantGid: "gid://shopify/ProductVariant/2",
  shape: "round",
  nominalLengthUm: 6_000,
  nominalWidthUm: 6_000,
  eligibleForSetYourOwnStone: true,
};

const oval = (lengthUm: number, widthUm: number): StoneDimensions => ({
  shape: "oval",
  lengthUm,
  widthUm,
});

describe("eligibility and shape — the two gates before any measuring", () => {
  it("excludes a setting that is not enrolled in Set Your Own Stone", () => {
    const r = classify(oval(10_000, 7_000), { ...OVAL_10x7, eligibleForSetYourOwnStone: false });
    expect(r.status).toBe("no_match");
    expect(r.rule).toBe("not_eligible");
  });

  it("never offers a wrong-shape setting as an automatic match, even at identical dimensions (§15.6)", () => {
    // A 6.00 x 6.00 stone against a 6.00 x 6.00 ROUND mounting: the numbers
    // agree perfectly and the shape does not, which must still be a no.
    const squareishOval: StoneDimensions = { shape: "oval", lengthUm: 6_000, widthUm: 6_000 };
    const r = classify(squareishOval, ROUND_6);
    expect(r.status).toBe("no_match");
    expect(r.rule).toBe("shape_mismatch");
  });
});

describe("exact nominal match (§15.7)", () => {
  it("matches a stone whose dimensions equal the nominal size", () => {
    const r = classify(oval(10_000, 7_000), OVAL_10x7);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("exact_nominal");
    expect(labelFor(r)).toBe(COMPATIBILITY_LABELS.recommended);
  });

  it("does NOT match one micrometre away, with no tolerance configured (§15.9)", () => {
    // 10.001 x 7.00 — visually identical, and still not an automatic match,
    // because no approved rule says it is.
    const r = classify(oval(10_001, 7_000), OVAL_10x7);
    expect(r.status).toBe("no_match");
    expect(r.rule).toBe("outside_all_rules");
  });
});

describe("explicit vendor range (§15.8)", () => {
  const ranged: ReadySettingCompatibility = {
    ...OVAL_10x7,
    minLengthUm: 9_800,
    maxLengthUm: 10_300,
    minWidthUm: 6_800,
    maxWidthUm: 7_200,
  };

  it("matches inside the range and says so with the stronger phrasing", () => {
    const r = classify(oval(10_120, 7_080), ranged);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("vendor_range_inside");
    expect(labelFor(r)).toBe(COMPATIBILITY_LABELS.matches);
  });

  it("treats the bounds as inclusive", () => {
    expect(classify(oval(9_800, 6_800), ranged).status).toBe("automatic");
    expect(classify(oval(10_300, 7_200), ranged).status).toBe("automatic");
  });

  it("outside the vendor range is a real no, not a maybe — even inside the review band", () => {
    // The manufacturer published a range; a display threshold of ours must
    // not quietly overrule it.
    const policy: MatchingPolicy = { reviewBandUm: 500 };
    const r = classify(oval(10_400, 7_000), ranged, policy);
    expect(r.status).toBe("no_match");
    expect(r.rule).toBe("vendor_range_outside");
  });

  it("treats null bounds as absent, not as a range of zero", () => {
    // Prisma spells "no value" as null; the domain spells it undefined, and
    // the repository converts between them. If a null ever reaches here —
    // one future caller handing a raw row straight through — reading it as a
    // PRESENT bound makes `length <= null` false and turns an exact-size
    // match into a confident `vendor_range_outside`. Silent, and wrong in
    // the worst direction. So nulls fall through to the nominal rules.
    const nulled = {
      ...OVAL_10x7,
      minLengthUm: null,
      maxLengthUm: null,
      minWidthUm: null,
      maxWidthUm: null,
    } as unknown as ReadySettingCompatibility;

    const r = classify(oval(10_000, 7_000), nulled);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("exact_nominal");
  });

  it("ignores a half-specified range rather than guessing the missing half", () => {
    const half: ReadySettingCompatibility = { ...OVAL_10x7, minLengthUm: 9_800, maxLengthUm: 10_300 };
    // Falls through to exact-nominal, which this stone does not satisfy.
    expect(classify(oval(10_120, 7_080), half).rule).toBe("outside_all_rules");
    expect(classify(oval(10_000, 7_000), half).rule).toBe("exact_nominal");
  });
});

describe("owner-approved tolerance (§6.2)", () => {
  const policy: MatchingPolicy = { approvedToleranceUmByShape: { oval: 150 } };

  it("matches inside an approved per-shape tolerance", () => {
    const r = classify(oval(10_120, 7_080), OVAL_10x7, policy);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("approved_tolerance");
  });

  it("does not leak the tolerance to a shape it was not approved for", () => {
    const round = (l: number, w: number): StoneDimensions => ({ shape: "round", lengthUm: l, widthUm: w });
    expect(classify(round(6_100, 6_100), ROUND_6, policy).status).toBe("no_match");
  });
});

describe("the review band is not a fit tolerance", () => {
  it("defaults to zero, so nothing is surfaced on an invented tolerance (§15.9)", () => {
    expect(DEFAULT_MATCHING_POLICY.reviewBandUm).toBe(0);
    const r = classify(oval(10_050, 7_020), OVAL_10x7);
    expect(r.status).toBe("no_match");
  });

  it("when opened, yields review-required and never an automatic match (§15.10)", () => {
    const r = classify(oval(10_050, 7_020), OVAL_10x7, { reviewBandUm: 100 });
    expect(r.status).toBe("review_required");
    expect(r.rule).toBe("review_band");
    expect(labelFor(r)).toBe(COMPATIBILITY_LABELS.review);
  });

  it("cannot be widened into a match by any amount", () => {
    for (const band of [50, 500, 5_000, 50_000]) {
      const r = classify(oval(10_900, 7_900), OVAL_10x7, { reviewBandUm: band });
      expect(r.status).not.toBe("automatic");
    }
  });
});

describe("carat weight can never decide compatibility (§15.5)", () => {
  it("two stones of the SAME carat and different millimetres reach opposite verdicts", () => {
    // Both are plausibly ~2.34ct ovals. One is cut long and narrow, the other
    // shallow and wide. Only the millimetres differ, and only the millimetres
    // may decide.
    const longNarrow = oval(10_000, 7_000); // equals nominal
    const shortWide = oval(8_900, 7_900); // same carat, different cut

    expect(classify(longNarrow, OVAL_10x7).status).toBe("automatic");
    expect(classify(shortWide, OVAL_10x7).status).toBe("no_match");
  });

  it("the matcher has no way to be told a carat weight at all", () => {
    // Structural, not behavioural: StoneDimensions carries shape and
    // millimetres only. If carat is ever added to that type this fails to
    // compile, which is the point.
    const stone: StoneDimensions = oval(10_000, 7_000);
    expect(Object.keys(stone).sort()).toEqual(["lengthUm", "shape", "widthUm"]);
  });
});

describe("matchSettings — what reaches the storefront", () => {
  const catalogue: ReadySettingCompatibility[] = [
    OVAL_10x7,
    ROUND_6,
    { ...OVAL_10x7, shopifyVariantGid: "gid://shopify/ProductVariant/3", nominalLengthUm: 10_050, nominalWidthUm: 7_020 },
    { ...OVAL_10x7, shopifyVariantGid: "gid://shopify/ProductVariant/4", eligibleForSetYourOwnStone: false },
  ];

  it("returns only qualifying candidates — non-matches never reach the view (§6.4)", () => {
    const s = matchSettings(oval(10_000, 7_000), catalogue);
    expect(s.automatic.map((r) => r.setting.shopifyVariantGid)).toEqual([
      "gid://shopify/ProductVariant/1",
    ]);
    expect(s.reviewRequired).toHaveLength(0);
    expect(s.customRecommended).toBe(false);
  });

  it("flags custom-recommended when nothing qualifies (§15.11)", () => {
    const s = matchSettings(oval(14_000, 9_000), catalogue);
    expect(s.automatic).toHaveLength(0);
    expect(s.customRecommended).toBe(true);
  });

  it("an empty catalogue is a clean custom recommendation, not an error", () => {
    // This is the launch state: no ready settings exist yet.
    const s = matchSettings(oval(10_000, 7_000), []);
    expect(s.automatic).toHaveLength(0);
    expect(s.reviewRequired).toHaveLength(0);
    expect(s.customRecommended).toBe(true);
  });

  it("orders closest-to-nominal first and is stable between runs", () => {
    // Stone 10.02 x 7.01.
    //   variant 1 (nominal 10.00 x 7.00) is 20 + 10 = 30um away
    //   variant 3 (nominal 10.05 x 7.02) is 30 + 10 = 40um away
    // so variant 1 leads.
    const s = matchSettings(oval(10_020, 7_010), catalogue, { reviewBandUm: 100 });
    const ids = s.reviewRequired.map((r) => r.setting.shopifyVariantGid);
    expect(ids).toEqual(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/3"]);

    // Same inputs, same order — no incidental dependence on object identity
    // or insertion order.
    const again = matchSettings(oval(10_020, 7_010), [...catalogue].reverse(), { reviewBandUm: 100 });
    expect(again.reviewRequired.map((r) => r.setting.shopifyVariantGid)).toEqual(ids);
  });
});

describe("millimetre conversion keeps floats out of the comparison path", () => {
  it("converts the spec's own example exactly", () => {
    expect(mmToMicrometres("10.12")).toBe(10_120);
    expect(mmToMicrometres("7.08")).toBe(7_080);
  });

  it("handles integers, trailing zeros and three decimals", () => {
    expect(mmToMicrometres("6")).toBe(6_000);
    expect(mmToMicrometres("6.0")).toBe(6_000);
    expect(mmToMicrometres("6.005")).toBe(6_005);
  });

  it("survives a value that is not exactly representable as a float", () => {
    // 0.1 + 0.2 territory. Via integers there is nothing to go wrong.
    expect(mmToMicrometres("8.30") + mmToMicrometres("0.10")).toBe(8_400);
  });

  it("rejects malformed input rather than coercing it", () => {
    for (const bad of ["", " ", "abc", "-5", "1e3", "10.1234", "10,12", "Infinity", "10.12mm"]) {
      expect(() => mmToMicrometres(bad)).toThrow(RangeError);
    }
  });

  it("round-trips for display", () => {
    expect(micrometresToMm(10_120)).toBe("10.12");
    expect(micrometresToMm(6_000)).toBe("6");
    expect(micrometresToMm(6_005)).toBe("6.005");
  });
});

describe("customer-facing vocabulary is fixed by the spec (§6.3)", () => {
  it("offers only the four approved phrasings", () => {
    expect(Object.values(COMPATIBILITY_LABELS).sort()).toEqual([
      "Custom setting recommended",
      "Matches your stone size",
      "May work — review required",
      "Recommended size match",
    ]);
  });

  it("never produces the forbidden phrase", () => {
    const all = Object.values(COMPATIBILITY_LABELS).join(" ").toLowerCase();
    expect(all).not.toContain("guarantee");
  });
});
