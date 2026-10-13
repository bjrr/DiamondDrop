/**
 * Buy Now RMA reason-category routing and item-condition eligibility
 * (docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md §7-§9,
 * docs/specs/SLICE-4-BUY-NOW-RMA.md criteria 182-183, 185).
 *
 * PURE — no database access, no I/O, no ambient clock.
 *
 * `evaluateRmaEligibility` is the single combined gate a caller (a later
 * intake/approval task) should consult before creating or approving an
 * `RmaRequest`. It composes `requiresClaimWorkflow` (reason-category
 * routing), the personalization/alteration restriction, and
 * `classifyReturnWindow` from `window.ts` — imported, never re-derived — in
 * the order the policy states them: a defect/damage/wrong-item/not-as-
 * described reason routes away from this discretionary workflow regardless
 * of personalization or day count, because that routing is not a discount on
 * eligibility, it is a statement that this is the wrong workflow entirely.
 */

import { classifyReturnWindow, type RmaWindowClassification } from "./window";

export const RMA_REASON_CATEGORIES = [
  "buyer_remorse",
  "size_fit",
  "style_preference",
  "alleged_defect",
  "wrong_item_or_specification",
  "transit_damage",
  "materially_not_as_described",
  "other",
] as const;

export type RmaReasonCategory = (typeof RMA_REASON_CATEGORIES)[number];

/**
 * Criterion 182 — policy §9: "Defect/wrong specifications, shipping damage,
 * warranty claims, and failure to deliver the ordered/presented product
 * remain separate [from discretionary buyer-remorse returns]." These four
 * reason categories never automatically receive a restocking-fee refund or
 * credit under this workflow; they belong to the applicable claim/warranty
 * workflow instead.
 */
const CLAIM_WORKFLOW_REASONS: ReadonlySet<RmaReasonCategory> = new Set([
  "alleged_defect",
  "wrong_item_or_specification",
  "transit_damage",
  "materially_not_as_described",
]);

export function requiresClaimWorkflow(reasonCategory: RmaReasonCategory): boolean {
  return CLAIM_WORKFLOW_REASONS.has(reasonCategory);
}

export interface RmaEligibilityInput {
  readonly calendarDaysSinceDelivery: number;
  readonly reasonCategory: RmaReasonCategory;
  /** Engraved, resized, altered, personalized, or otherwise customized (policy §8). */
  readonly isPersonalizedOrAltered: boolean;
  /** Policy §8: "unless a product-specific locked policy expressly says otherwise." */
  readonly hasProductSpecificReturnOverride: boolean;
}

export type RmaIneligibilityReasonCode = "requires_claim_workflow" | "personalized_or_altered" | "past_day_30";

export type RmaEligibilityResult =
  | { readonly eligible: true; readonly windowKind: Exclude<RmaWindowClassification, "ineligible"> }
  | { readonly eligible: false; readonly reasonCode: RmaIneligibilityReasonCode };

/**
 * The combined discretionary-return eligibility gate. Order matters:
 *
 * 1. Claim-workflow routing (criterion 182) is checked FIRST and
 *    unconditionally — a defect on a personalized item, or one reported on
 *    day 45, still routes to the claim workflow rather than being reported
 *    as "past day 30" or "personalized," because the real reason it isn't a
 *    discretionary return is that it was never one to begin with.
 * 2. Personalization/alteration (criterion 183) is checked next, for the
 *    remaining genuinely-discretionary reasons (buyer remorse, size/fit,
 *    style, other).
 * 3. Window classification (criterion 185) is checked last, delegating to
 *    `classifyReturnWindow` — imported, not re-derived.
 */
export function evaluateRmaEligibility(input: RmaEligibilityInput): RmaEligibilityResult {
  if (requiresClaimWorkflow(input.reasonCategory)) {
    return { eligible: false, reasonCode: "requires_claim_workflow" };
  }

  if (input.isPersonalizedOrAltered && !input.hasProductSpecificReturnOverride) {
    return { eligible: false, reasonCode: "personalized_or_altered" };
  }

  const windowKind = classifyReturnWindow(input.calendarDaysSinceDelivery);
  if (windowKind === "ineligible") {
    return { eligible: false, reasonCode: "past_day_30" };
  }

  return { eligible: true, windowKind };
}
