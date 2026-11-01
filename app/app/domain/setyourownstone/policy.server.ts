/**
 * Set Your Own Stone — matching policy resolution.
 *
 * ---------------------------------------------------------------------------
 * OWNER DECISION, LOCKED 2026-10-31
 * ---------------------------------------------------------------------------
 * The owner approved a compatibility tolerance, which is exactly the hook
 * docs/SET-YOUR-OWN-STONE.md §6.2 reserved: "Do not invent a universal
 * jewelry-fit tolerance" bans US from choosing one, and permits a configured
 * owner-approved rule. The approved rule is:
 *
 *   - exact nominal shape + dimension matches are allowed
 *   - explicit manufacturer/vendor min/max ranges are allowed
 *   - for professional PRONG-SET mountings, differences up to ±0.3 mm in the
 *     relevant length and/or width are routinely accommodated during setting,
 *     and may be treated as an approved automatic tolerance
 *   - the tolerance does NOT override an explicit vendor restriction
 *   - a mounting not reasonably adjustable by prong setting does not get the
 *     rule automatically
 *   - anything outside tolerance or vendor range is Review Required, or is
 *     routed to Custom Jewelry
 *   - never "Guaranteed fit"
 *
 * TWO PARTS OF THAT ARE ENFORCED ELSEWHERE, deliberately:
 *
 *   Vendor precedence is positional in `classify`. The vendor-range branch
 *   returns unconditionally, inside or outside, so a mounting with a
 *   published range never reaches the tolerance rules at all.
 *
 *   Prong eligibility is per-mounting, on `ReadySettingCompatibility`, and
 *   defaults to FALSE. A tolerance that applied to every mounting because
 *   nobody ticked a box would hand a bezel setting a prong-setting
 *   allowance — and the customer's own diamond is already in the post by the
 *   time a bench discovers it does not fit.
 *
 * ---------------------------------------------------------------------------
 * THE REVIEW BAND IS DERIVED, AND IS THE ONE NUMBER STILL OPEN
 * ---------------------------------------------------------------------------
 * The decision requires that out-of-tolerance cases be "Review Required or
 * routed to Custom Jewelry", and its own worked example fixes a lower bound:
 * a 10.5 × 7.4 mm stone against a 10 × 7 mm mounting — 0.5 mm and 0.4 mm
 * out — must read Review Required. So the band cannot be smaller than
 * 0.5 mm.
 *
 * It also cannot be unbounded. §6.4 forbids showing "irrelevant mountings as
 * if compatible", and an open-ended band would offer a 10 × 7 mounting for a
 * 15 × 9 stone under a "may work" label.
 *
 * Bounded below by the example and above by §6.4, the exact width is
 * underdetermined, so 1.0 mm is set here: comfortably past the worked
 * example, and short of sizes no bench would entertain. FLAGGED FOR OWNER
 * CONFIRMATION — it is the only figure in this file that was not stated.
 * Changing it means changing this one constant.
 */
import type { MatchingPolicy } from "~/domain/setyourownstone/matching";

/** 0.3 mm, as integer micrometres. The owner's prong-setting accommodation. */
const PRONG_SET_TOLERANCE_UM = 300;

/** 1.0 mm. Derived, not stated — see the header. */
const REVIEW_BAND_UM = 1_000;

/**
 * The policy in force.
 *
 * Async because the eventual source is a stored owner decision, and making
 * callers await now means moving these constants into the database later
 * changes no call sites.
 */
export async function resolveMatchingPolicy(): Promise<MatchingPolicy> {
  return {
    // Empty: the approved tolerance is a property of the MOUNTING's setting
    // style, not of the stone's shape. No per-shape decision has been made,
    // and populating this with the prong figure would apply it to bezel and
    // channel mountings too — the precise outcome the decision excludes.
    approvedToleranceUmByShape: {},
    prongSetToleranceUm: PRONG_SET_TOLERANCE_UM,
    reviewBandUm: REVIEW_BAND_UM,
  };
}
