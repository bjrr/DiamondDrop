/**
 * The historical record of a compatibility decision.
 *
 * Authoritative requirements: owner approval 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `StoneSession.compatibilityStatus` and `compatibilityRule` record WHAT was
 * decided. They cannot explain WHY, and that gap became load-bearing the
 * moment Shopify became the editable source of truth: a merchant can change a
 * mounting's nominal size, vendor range or prong eligibility the day after a
 * customer was shown a match. "We told them 10 × 7 fits" has to stay
 * answerable from the numbers actually used at the time, not from whatever the
 * catalogue says now.
 *
 * ---------------------------------------------------------------------------
 * WRITE-ONCE, AND THE DATABASE ENFORCES IT
 * ---------------------------------------------------------------------------
 * A trigger refuses any UPDATE that would change a populated
 * `matched_snapshot`. This module is the cooperative half of that: it builds
 * the value and never updates one. Application discipline alone would not be
 * enough — this is the column someone reaches for when a customer disputes
 * what they were shown, and a well-meaning resync "correcting" it destroys
 * exactly the evidence worth keeping.
 *
 * MILLIMETRES ARE STORED ALONGSIDE MICROMETRES. The micrometres are the values
 * the decision was actually computed from, so they are the evidence; the
 * millimetres exist so a person reading the record six months later does not
 * have to divide by a thousand to understand it. Both, not one.
 */
import type { CompatibilityRule, CompatibilityStatus, MatchResult } from "./matching";

/** The version of this record's shape. Present from the first row so a later
 *  field addition can be told apart from an old row that never had it —
 *  without it, "absent" and "not yet invented" look identical forever. */
export const MATCHED_SNAPSHOT_VERSION = 1 as const;

export interface MatchedSnapshot {
  readonly version: typeof MATCHED_SNAPSHOT_VERSION;
  /** When the decision was made. Not when the row was written. */
  readonly decidedAt: string;

  readonly shopifyProductGid: string;
  readonly shopifyVariantGid: string;
  /** The stable centre-size option value, when the product had one. Lets a
   *  historical match name its configuration even after the label is
   *  reworded. */
  readonly centerSizeOptionValueId: string | null;
  /** Which shared profile supplied the dimensions below. */
  readonly centerSizeProfileId: string | null;

  readonly shape: string;
  readonly nominalLengthUm: number;
  readonly nominalWidthUm: number;
  readonly nominalDepthUm: number | null;
  readonly nominalLengthMm: string;
  readonly nominalWidthMm: string;
  readonly nominalDepthMm: string | null;

  /**
   * The vendor range as it stood, or null when none applied.
   *
   * Recorded even though the rule already says whether it was used: a range
   * that EXISTED but did not decide the outcome is itself evidence, because
   * its presence is what stopped the ±0.3 mm allowance from being consulted.
   */
  readonly vendorRange: {
    readonly minLengthUm: number;
    readonly maxLengthUm: number;
    readonly minWidthUm: number;
    readonly maxWidthUm: number;
    readonly source: string | null;
  } | null;

  readonly prongSetToleranceEligible: boolean;
  /** The policy figures in force at decision time, so a later change to them
   *  cannot make a past verdict look unjustified. */
  readonly policy: {
    readonly prongSetToleranceUm: number;
    readonly reviewBandUm: number;
  };

  readonly status: CompatibilityStatus;
  readonly rule: CompatibilityRule;
}

/** Micrometres to a readable millimetre figure. Trailing zeros trimmed, so a
 *  nominal 10 reads as "10" rather than "10.000". */
function mm(um: number): string {
  return (um / 1000).toFixed(3).replace(/\.?0+$/, "");
}

export interface BuildSnapshotInput {
  readonly result: MatchResult;
  readonly shopifyProductGid: string;
  readonly centerSizeOptionValueId: string | null;
  readonly centerSizeProfileId: string | null;
  readonly policy: { readonly prongSetToleranceUm: number; readonly reviewBandUm: number };
  readonly decidedAt: Date;
}

/**
 * Build the record for one decision.
 *
 * Pure, and takes `decidedAt` rather than reading the clock, so a test asserts
 * an exact timestamp instead of tolerating whatever `new Date()` returned.
 */
export function buildMatchedSnapshot(input: BuildSnapshotInput): MatchedSnapshot {
  const { result } = input;
  const s = result.setting;

  const hasRange =
    s.minLengthUm != null && s.maxLengthUm != null && s.minWidthUm != null && s.maxWidthUm != null;

  return {
    version: MATCHED_SNAPSHOT_VERSION,
    decidedAt: input.decidedAt.toISOString(),

    shopifyProductGid: input.shopifyProductGid,
    shopifyVariantGid: s.shopifyVariantGid,
    centerSizeOptionValueId: input.centerSizeOptionValueId,
    centerSizeProfileId: input.centerSizeProfileId,

    shape: s.shape,
    nominalLengthUm: s.nominalLengthUm,
    nominalWidthUm: s.nominalWidthUm,
    nominalDepthUm: s.nominalDepthUm ?? null,
    nominalLengthMm: mm(s.nominalLengthUm),
    nominalWidthMm: mm(s.nominalWidthUm),
    nominalDepthMm: s.nominalDepthUm != null ? mm(s.nominalDepthUm) : null,

    vendorRange: hasRange
      ? {
          minLengthUm: s.minLengthUm as number,
          maxLengthUm: s.maxLengthUm as number,
          minWidthUm: s.minWidthUm as number,
          maxWidthUm: s.maxWidthUm as number,
          source: null,
        }
      : null,

    prongSetToleranceEligible: s.prongSetToleranceEligible,
    policy: { ...input.policy },

    status: result.status,
    rule: result.rule,
  };
}
