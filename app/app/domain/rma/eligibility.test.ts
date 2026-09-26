import { describe, expect, it } from "vitest";
import { evaluateRmaEligibility, requiresClaimWorkflow, type RmaReasonCategory } from "./eligibility";

const CLAIM_WORKFLOW_REASONS: RmaReasonCategory[] = [
  "alleged_defect",
  "wrong_item_or_specification",
  "transit_damage",
  "materially_not_as_described",
];

const DISCRETIONARY_REASONS: RmaReasonCategory[] = ["buyer_remorse", "size_fit", "style_preference", "other"];

describe("requiresClaimWorkflow — criterion 182", () => {
  it.each(CLAIM_WORKFLOW_REASONS)("%s routes to the claim workflow", (reason) => {
    expect(requiresClaimWorkflow(reason)).toBe(true);
  });

  it.each(DISCRETIONARY_REASONS)("%s stays discretionary", (reason) => {
    expect(requiresClaimWorkflow(reason)).toBe(false);
  });
});

describe("evaluateRmaEligibility — combined gate", () => {
  it.each(CLAIM_WORKFLOW_REASONS)(
    "routes %s to the claim workflow even on a personalized item within the standard window",
    (reason) => {
      const result = evaluateRmaEligibility({
        calendarDaysSinceDelivery: 2,
        reasonCategory: reason,
        isPersonalizedOrAltered: true,
        hasProductSpecificReturnOverride: false,
      });
      expect(result).toEqual({ eligible: false, reasonCode: "requires_claim_workflow" });
    }
  );

  it.each(CLAIM_WORKFLOW_REASONS)("routes %s to the claim workflow even past day 30", (reason) => {
    const result = evaluateRmaEligibility({
      calendarDaysSinceDelivery: 45,
      reasonCategory: reason,
      isPersonalizedOrAltered: false,
      hasProductSpecificReturnOverride: false,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "requires_claim_workflow" });
  });

  it("refuses a personalized item on a discretionary reason", () => {
    const result = evaluateRmaEligibility({
      calendarDaysSinceDelivery: 3,
      reasonCategory: "buyer_remorse",
      isPersonalizedOrAltered: true,
      hasProductSpecificReturnOverride: false,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "personalized_or_altered" });
  });

  it("allows a personalized item when a product-specific override is recorded", () => {
    const result = evaluateRmaEligibility({
      calendarDaysSinceDelivery: 3,
      reasonCategory: "buyer_remorse",
      isPersonalizedOrAltered: true,
      hasProductSpecificReturnOverride: true,
    });
    expect(result).toEqual({ eligible: true, windowKind: "standard" });
  });

  it("is eligible, standard window, for an ordinary discretionary request within 7 days", () => {
    const result = evaluateRmaEligibility({
      calendarDaysSinceDelivery: 5,
      reasonCategory: "size_fit",
      isPersonalizedOrAltered: false,
      hasProductSpecificReturnOverride: false,
    });
    expect(result).toEqual({ eligible: true, windowKind: "standard" });
  });

  it("is eligible, late window, for a discretionary request on day 20", () => {
    const result = evaluateRmaEligibility({
      calendarDaysSinceDelivery: 20,
      reasonCategory: "style_preference",
      isPersonalizedOrAltered: false,
      hasProductSpecificReturnOverride: false,
    });
    expect(result).toEqual({ eligible: true, windowKind: "late" });
  });

  it("refuses a discretionary request past day 30 with reasonCode past_day_30", () => {
    const result = evaluateRmaEligibility({
      calendarDaysSinceDelivery: 31,
      reasonCategory: "other",
      isPersonalizedOrAltered: false,
      hasProductSpecificReturnOverride: false,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "past_day_30" });
  });
});
