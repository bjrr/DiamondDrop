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
  prongSetToleranceEligible: false,
};

const ROUND_6: ReadySettingCompatibility = {
  shopifyVariantGid: "gid://shopify/ProductVariant/2",
  shape: "round",
  nominalLengthUm: 6_000,
  nominalWidthUm: 6_000,
  eligibleForSetYourOwnStone: true,
  prongSetToleranceEligible: false,
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
    // The strong phrasing: an exact nominal hit cannot read less confident
    // than the +/-0.3 mm case the owner assigned "Matches your stone size".
    expect(labelFor(r)).toBe(COMPATIBILITY_LABELS.matches);
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

describe("the owner's prong-setting tolerance (decision 2026-10-31)", () => {
  /** The policy actually in force. Kept in step with `policy.server.ts` by
   *  the parity test at the bottom of this file, so this cannot drift into
   *  testing a tolerance we do not ship. */
  const LOCKED: MatchingPolicy = {
    approvedToleranceUmByShape: {},
    prongSetToleranceUm: 300,
    reviewBandUm: 1_000,
  };

  /** Same 10 x 7 mm oval mounting, declared prong-set adjustable. */
  const PRONG_10x7: ReadySettingCompatibility = {
    ...OVAL_10x7,
    prongSetToleranceEligible: true,
  };

  // ---------------------------------------------------------------- the three
  // worked examples from the decision, verbatim. These are the acceptance
  // criteria, so they are written as the owner wrote them.

  it("10.2 x 7.1 against 10 x 7 may be shown as matching", () => {
    const r = classify(oval(10_200, 7_100), PRONG_10x7, LOCKED);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("prong_set_tolerance");
  });

  it("10.3 x 7.3 against 10 x 7 still qualifies — the tolerance is inclusive at 0.3", () => {
    // Exactly on the bound in BOTH dimensions. An exclusive comparison here
    // would fail the owner's own example, and 0.3 mm was stated as the
    // allowance, not as the first value outside it.
    const r = classify(oval(10_300, 7_300), PRONG_10x7, LOCKED);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("prong_set_tolerance");
  });

  it("10.5 x 7.4 against 10 x 7 is Review Required, not a match", () => {
    const r = classify(oval(10_500, 7_400), PRONG_10x7, LOCKED);
    expect(r.status).toBe("review_required");
    expect(r.rule).toBe("review_band");
    expect(labelFor(r)).toBe(COMPATIBILITY_LABELS.review);
  });

  it("one micrometre past the tolerance drops to review, not match", () => {
    // The boundary is the whole point of an integer representation: 0.301 mm
    // is outside, unambiguously, with no floating-point argument about it.
    const r = classify(oval(10_301, 7_000), PRONG_10x7, LOCKED);
    expect(r.status).toBe("review_required");
  });

  // ------------------------------------------------------- the two exclusions

  it("does NOT apply to a mounting that is not prong-set adjustable", () => {
    // Same stone, same numbers, same policy — only the mounting's setting
    // style differs. A bezel or channel setting must not inherit a prong
    // allowance, because the bench cannot absorb the difference and the
    // customer's own diamond is already in the post by the time anyone knows.
    const r = classify(oval(10_200, 7_100), OVAL_10x7, LOCKED);
    expect(r.status).not.toBe("automatic");
    expect(r.rule).not.toBe("prong_set_tolerance");
  });

  it("does NOT override an explicit vendor restriction", () => {
    // The vendor caps length at 10.1 mm. A 10.25 mm stone is inside OUR
    // 0.3 mm allowance and outside THEIRS, and the manufacturer wins — a
    // general rule about prong work cannot overrule a specific published
    // limit on a specific mounting.
    const restricted: ReadySettingCompatibility = {
      ...PRONG_10x7,
      minLengthUm: 9_900,
      maxLengthUm: 10_100,
      minWidthUm: 6_900,
      maxWidthUm: 7_100,
    };
    const r = classify(oval(10_250, 7_000), restricted, LOCKED);
    expect(r.status).toBe("no_match");
    expect(r.rule).toBe("vendor_range_outside");
  });

  it("a WIDER vendor range still wins, and grants more than our tolerance would", () => {
    // Precedence is not "whichever is stricter" — it is the vendor's range,
    // full stop. Here theirs is more generous and a 0.45 mm difference
    // matches on their authority, which our 0.3 mm rule would have refused.
    const generous: ReadySettingCompatibility = {
      ...PRONG_10x7,
      minLengthUm: 9_000,
      maxLengthUm: 11_000,
      minWidthUm: 6_500,
      maxWidthUm: 7_500,
    };
    const r = classify(oval(10_450, 7_200), generous, LOCKED);
    expect(r.status).toBe("automatic");
    expect(r.rule).toBe("vendor_range_inside");
  });

  it("still refuses a wrong-shape mounting at a tolerable distance", () => {
    // Shape is checked before any measuring, so the tolerance never becomes a
    // way in for the wrong outline.
    const prongRound: ReadySettingCompatibility = { ...ROUND_6, prongSetToleranceEligible: true };
    const r = classify({ shape: "oval", lengthUm: 6_100, widthUm: 6_100 }, prongRound, LOCKED);
    expect(r.rule).toBe("shape_mismatch");
  });

  it("is off by default, so it only ever applies because someone decided it", () => {
    expect(DEFAULT_MATCHING_POLICY.prongSetToleranceUm).toBe(0);
    expect(classify(oval(10_200, 7_100), PRONG_10x7).status).toBe("no_match");
  });

  it("never produces the forbidden phrasing", () => {
    const r = classify(oval(10_200, 7_100), PRONG_10x7, LOCKED);
    expect(labelFor(r)).not.toMatch(/guarantee/i);
    // Named by the owner decision verbatim.
    expect(labelFor(r)).toBe(COMPATIBILITY_LABELS.matches);
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
