/**
 * Set Your Own Stone — ready-setting compatibility matching.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §6 and §11.
 *
 * PURE. No I/O, no Prisma, no Shopify. The caller loads the candidate
 * records and hands them in; this file only decides. That is what makes
 * §11's "testable independently from the storefront UI" true rather than
 * aspirational.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES THAT ARE EASY TO BREAK AND EXPENSIVE TO GET WRONG
 * ---------------------------------------------------------------------------
 *
 * 1. CARAT IS NEVER AN INPUT. It is not a parameter of this function and must
 *    never become one. Two stones of identical carat weight can differ by
 *    millimetres, and a mounting fits millimetres. §4 and §15.5. Carat travels
 *    with the session for display and staff review only.
 *
 * 2. DIMENSIONS ARE INTEGER MICROMETRES. Never float millimetres. §11 asks for
 *    "no floating-point surprises"; 10.12 mm is 10120, and equality means
 *    equality. CLAUDE.md rule 6 already forbids float money for exactly this
 *    reason and a 0.01 mm comparison deserves the same treatment.
 *
 * 3. THE REVIEW BAND IS NOT A FIT TOLERANCE. §6.2 forbids inventing a
 *    universal jewelry-fit tolerance, and this does not invent one: the band
 *    decides only what a HUMAN IS ASKED TO LOOK AT, can never produce an
 *    automatic match, and defaults to zero so that nothing is surfaced on its
 *    strength unless an owner deliberately opens it. A vendor's own range is a
 *    different thing entirely — that is an authority, and falling outside it
 *    is a real no rather than a maybe.
 */

/** Integer micrometres. 10.12 mm === 10_120. */
export type Micrometres = number;

export type StoneShape =
  | "round"
  | "oval"
  | "cushion"
  | "princess"
  | "emerald"
  | "radiant"
  | "pear"
  | "marquise"
  | "asscher"
  | "heart";

/**
 * What the customer told us about their stone. Deliberately does NOT include
 * carat weight — see rule 1 above. If you find yourself wanting it here, the
 * thing you actually want is a dimension.
 */
export interface StoneDimensions {
  readonly shape: StoneShape;
  readonly lengthUm: Micrometres;
  readonly widthUm: Micrometres;
  readonly depthUm?: Micrometres;
}

/**
 * One ready setting's structured compatibility record (§5). Loaded from the
 * app database, which is the system of record; the Shopify metafield mirror
 * is presentation only and never reaches this function.
 */
export interface ReadySettingCompatibility {
  readonly shopifyVariantGid: string;
  readonly shape: StoneShape;
  /** Vendor's nominal/recommended centre size. */
  readonly nominalLengthUm: Micrometres;
  readonly nominalWidthUm: Micrometres;
  readonly nominalDepthUm?: Micrometres;
  /**
   * An explicit accepted range, when the manufacturer published one. All four
   * bounds must be present to be usable — a half-specified range is not a
   * range, and guessing the missing half would be inventing a tolerance.
   */
  readonly minLengthUm?: Micrometres;
  readonly maxLengthUm?: Micrometres;
  readonly minWidthUm?: Micrometres;
  readonly maxWidthUm?: Micrometres;
  readonly eligibleForSetYourOwnStone: boolean;
  /**
   * Whether this mounting's setting style is reasonably adjustable by prong
   * setting, and so qualifies for the owner's ±0.3 mm accommodation
   * (decision 2026-10-31).
   *
   * NOT A DEFAULT-ON FLAG. The decision says a design "not reasonably
   * adjustable by prong setting" must not get the rule automatically, and the
   * only way to honour that is for silence to mean no. A bezel, channel or
   * tension setting that inherited an on-by-default tolerance would be shown
   * as a size match to a stone a bench cannot actually set — which is the
   * expensive direction to be wrong in, since the customer's own diamond is
   * already in the post by the time anyone finds out.
   */
  readonly prongSetToleranceEligible: boolean;
}

/**
 * Owner-configurable policy. Every dial defaults to ZERO, which is the
 * strictest reading of §6.2: with no configuration, nothing is matched or
 * surfaced on the strength of a tolerance this system made up.
 *
 * The owner's locked decision of 2026-10-31 populates these; see
 * `policy.server.ts` for the values actually in force and their derivation.
 */
export interface MatchingPolicy {
  /**
   * Per-shape approved fit tolerance, in micrometres. A candidate inside this
   * band of the nominal size becomes an AUTOMATIC match. Only an owner
   * decision may populate this (§6.2 "where an owner-approved compatibility
   * tolerance is configured, use it").
   *
   * Retained alongside `prongSetToleranceUm` because the two answer different
   * questions: this one is "does this SHAPE tolerate more or less", the other
   * is "is this MOUNTING adjustable at all". A future shape-specific decision
   * lands here without disturbing the prong rule.
   */
  readonly approvedToleranceUmByShape?: Partial<Record<StoneShape, Micrometres>>;
  /**
   * The owner's prong-setting accommodation, in micrometres — 300 (±0.3 mm)
   * under the 2026-10-31 decision.
   *
   * APPLIES ONLY TO MOUNTINGS FLAGGED `prongSetToleranceEligible`. The
   * decision is explicit that a design not reasonably adjustable by prong
   * setting does not get this rule automatically, so the tolerance is a
   * property of the policy AND the mounting, never of the policy alone.
   */
  readonly prongSetToleranceUm?: Micrometres;
  /**
   * How far from nominal a candidate may sit and still be shown to the
   * customer as "review required". NOT a fit claim. Zero disables it.
   */
  readonly reviewBandUm?: Micrometres;
}

export const DEFAULT_MATCHING_POLICY: MatchingPolicy = {
  approvedToleranceUmByShape: {},
  prongSetToleranceUm: 0,
  reviewBandUm: 0,
};

/**
 * The classification. `automatic` means the data supports surfacing it as a
 * size match; it never means the ring will physically fit, which only a
 * person checking the stone can say.
 */
export type CompatibilityStatus = "automatic" | "review_required" | "no_match";

/** Which rule produced the verdict. Persisted, because §10 requires recording
 *  the "rule/data used to derive" a compatibility status — six months later,
 *  "why was this shown to the customer" needs an answer. */
export type CompatibilityRule =
  | "not_eligible"
  | "shape_mismatch"
  | "vendor_range_inside"
  | "vendor_range_outside"
  | "exact_nominal"
  | "approved_tolerance"
  /** The owner's ±0.3 mm prong-setting accommodation (decision 2026-10-31).
   *  Recorded distinctly from `approved_tolerance` so that if the decision is
   *  ever revisited, the matches it produced can be found. */
  | "prong_set_tolerance"
  | "review_band"
  | "outside_all_rules";

export interface MatchResult {
  readonly setting: ReadySettingCompatibility;
  readonly status: CompatibilityStatus;
  readonly rule: CompatibilityRule;
}

/**
 * Customer-facing wording for a status (§6.3).
 *
 * Centralised so the storefront cannot improvise. The allowed vocabulary is
 * fixed by the spec and "Guaranteed fit" is forbidden outright; a fence test
 * pins that the phrase appears nowhere in the codebase.
 */
export const COMPATIBILITY_LABELS = {
  matches: "Matches your stone size",
  recommended: "Recommended size match",
  review: "May work — review required",
  custom: "Custom setting recommended",
} as const;

/** The qualifier that must accompany every automatic match (§6.3). */
export const COMPATIBILITY_QUALIFIER =
  "We confirm compatibility before you send your stone.";

export function labelFor(result: MatchResult): string {
  if (result.status === "review_required") return COMPATIBILITY_LABELS.review;
  if (result.status === "no_match") return COMPATIBILITY_LABELS.custom;
  // An explicit vendor range is a stronger statement than our nominal
  // bookkeeping, so it gets the stronger of the two allowed phrasings.
  return result.rule === "vendor_range_inside"
    ? COMPATIBILITY_LABELS.matches
    : COMPATIBILITY_LABELS.recommended;
}

/** True only when all four bounds are present — see the interface comment. */
function hasCompleteVendorRange(s: ReadySettingCompatibility): boolean {
  // `!= null` deliberately, catching null as well as undefined.
  //
  // The repository converts Prisma's nulls to undefined before the domain
  // ever sees them, so this is belt-and-braces. But the failure it prevents
  // is a bad one and completely silent: a null bound read as PRESENT makes
  // `length <= null` false, which returns `vendor_range_outside` — turning
  // an exact-size match into a confident no with no error anywhere. Being
  // strict about undefined buys nothing here and costs that.
  return (
    s.minLengthUm != null &&
    s.maxLengthUm != null &&
    s.minWidthUm != null &&
    s.maxWidthUm != null
  );
}

function withinVendorRange(stone: StoneDimensions, s: ReadySettingCompatibility): boolean {
  return (
    stone.lengthUm >= (s.minLengthUm as number) &&
    stone.lengthUm <= (s.maxLengthUm as number) &&
    stone.widthUm >= (s.minWidthUm as number) &&
    stone.widthUm <= (s.maxWidthUm as number)
  );
}

function withinBand(stone: StoneDimensions, s: ReadySettingCompatibility, band: Micrometres): boolean {
  return (
    Math.abs(stone.lengthUm - s.nominalLengthUm) <= band &&
    Math.abs(stone.widthUm - s.nominalWidthUm) <= band
  );
}

/**
 * Classify one candidate. Order matters and is the order in the plan:
 * eligibility, then shape, then vendor authority, then exact nominal, then an
 * owner-approved tolerance, then the review band.
 */
export function classify(
  stone: StoneDimensions,
  setting: ReadySettingCompatibility,
  policy: MatchingPolicy = DEFAULT_MATCHING_POLICY
): MatchResult {
  const no = (rule: CompatibilityRule): MatchResult => ({ setting, status: "no_match", rule });

  if (!setting.eligibleForSetYourOwnStone) return no("not_eligible");
  if (setting.shape !== stone.shape) return no("shape_mismatch");

  // A vendor range is an authority. Inside it is a match; OUTSIDE IT IS A
  // REAL NO, not a maybe — deferring to a weaker rule here would quietly
  // overrule the manufacturer.
  if (hasCompleteVendorRange(setting)) {
    return withinVendorRange(stone, setting)
      ? { setting, status: "automatic", rule: "vendor_range_inside" }
      : no("vendor_range_outside");
  }

  if (stone.lengthUm === setting.nominalLengthUm && stone.widthUm === setting.nominalWidthUm) {
    return { setting, status: "automatic", rule: "exact_nominal" };
  }

  const approved = policy.approvedToleranceUmByShape?.[stone.shape] ?? 0;
  if (approved > 0 && withinBand(stone, setting, approved)) {
    return { setting, status: "automatic", rule: "approved_tolerance" };
  }

  // The owner's prong-setting accommodation (decision 2026-10-31): up to
  // ±0.3 mm in length and/or width is routinely absorbed when a bench sets
  // prongs.
  //
  // REACHED ONLY AFTER THE VENDOR RANGE, by position in this function. The
  // decision states the tolerance "does NOT override an explicit
  // manufacturer/vendor restriction", and the vendor branch above returns
  // unconditionally — inside or outside — so a mounting with a published
  // range never arrives here. That ordering IS the precedence rule; it is not
  // an accident of layout.
  //
  // AND ONLY FOR MOUNTINGS THAT SAY THEY ARE ADJUSTABLE. A setting style that
  // cannot be opened up by prong work does not get this automatically.
  const prong = policy.prongSetToleranceUm ?? 0;
  if (prong > 0 && setting.prongSetToleranceEligible && withinBand(stone, setting, prong)) {
    return { setting, status: "automatic", rule: "prong_set_tolerance" };
  }

  const band = policy.reviewBandUm ?? 0;
  if (band > 0 && withinBand(stone, setting, band)) {
    return { setting, status: "review_required", rule: "review_band" };
  }

  return no("outside_all_rules");
}

export interface MatchSummary {
  readonly automatic: readonly MatchResult[];
  readonly reviewRequired: readonly MatchResult[];
  /** True when nothing qualified — the storefront must then lead with the
   *  Custom Setting path (§6.4). */
  readonly customRecommended: boolean;
}

/**
 * Classify a catalogue of candidates and split them the way §11 requires.
 *
 * Non-matches are dropped rather than returned: §6.4 says not to "show
 * irrelevant mountings as if compatible", and the safest way to honour that
 * is to never hand them to the view at all.
 *
 * Ordering is deterministic — closest to nominal first, then by variant id so
 * that two equally close settings never swap places between requests.
 */
export function matchSettings(
  stone: StoneDimensions,
  settings: readonly ReadySettingCompatibility[],
  policy: MatchingPolicy = DEFAULT_MATCHING_POLICY
): MatchSummary {
  const results = settings.map((s) => classify(stone, s, policy));

  const distance = (r: MatchResult) =>
    Math.abs(stone.lengthUm - r.setting.nominalLengthUm) +
    Math.abs(stone.widthUm - r.setting.nominalWidthUm);

  const sort = (a: MatchResult, b: MatchResult) =>
    distance(a) - distance(b) ||
    a.setting.shopifyVariantGid.localeCompare(b.setting.shopifyVariantGid);

  const automatic = results.filter((r) => r.status === "automatic").sort(sort);
  const reviewRequired = results.filter((r) => r.status === "review_required").sort(sort);

  return {
    automatic,
    reviewRequired,
    customRecommended: automatic.length === 0,
  };
}

/** Millimetres as entered by a customer to integer micrometres.
 *  Rejects anything that is not a plain decimal with at most 3 places, so a
 *  float never enters the comparison path through the back door. */
export function mmToMicrometres(mm: string): Micrometres {
  const trimmed = mm.trim();
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(trimmed)) {
    throw new RangeError(`Not a valid millimetre measurement: ${JSON.stringify(mm)}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
}

/** Micrometres back to a display string, e.g. 10120 -> "10.12". */
export function micrometresToMm(um: Micrometres): string {
  const s = (um / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
