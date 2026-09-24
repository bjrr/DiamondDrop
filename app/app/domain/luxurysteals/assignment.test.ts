import { describe, expect, it } from "vitest";

import {
  buildBulkAssignmentTargets,
  EmptyLuxuryStealBulkAssignmentError,
} from "./assignment";

describe("buildBulkAssignmentTargets", () => {
  it("passes through a normal variant id list unchanged, preserving order", () => {
    const ids = ["variant-a", "variant-b", "variant-c"];
    expect(buildBulkAssignmentTargets("product-1", ids)).toEqual(ids);
  });

  it("deduplicates a variant id that appears more than once", () => {
    const result = buildBulkAssignmentTargets("product-1", ["variant-a", "variant-b", "variant-a"]);
    expect(result).toEqual(["variant-a", "variant-b"]);
  });

  it("throws EmptyLuxuryStealBulkAssignmentError for a product with no variants", () => {
    expect(() => buildBulkAssignmentTargets("product-empty", [])).toThrow(
      EmptyLuxuryStealBulkAssignmentError
    );
  });

  it("names the product in the empty-assignment error", () => {
    try {
      buildBulkAssignmentTargets("product-empty", []);
      expect.unreachable("expected buildBulkAssignmentTargets to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EmptyLuxuryStealBulkAssignmentError);
      expect((error as Error).message).toContain("product-empty");
    }
  });
});
