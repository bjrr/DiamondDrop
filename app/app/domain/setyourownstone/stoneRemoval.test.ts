import { describe, expect, it } from "vitest";

import {
  STONE_MOUNTED_QUESTION,
  STONE_MOUNTED_STATES,
  STONE_REMOVAL_COPY,
  STONE_REMOVAL_FEE_MINOR_UNITS,
  isStoneMountedState,
  stoneRemovalChargeFor,
  stoneRemovalOfferFor,
  stoneRemovalRequiredFor,
  type StoneMountedState,
} from "./stoneRemoval";

/**
 * The $50 prong-only Stone Removal rule (§17.3; mandatory-not-optional
 * correction 2026-11-02).
 *
 * The owner's three worked examples are the first three tests. The rest are
 * the ways this could go wrong with money or with liability — above all, the
 * contradictory state the correction exists to forbid: a prong-mounted stone
 * on an order with no removal service.
 */
describe("the owner's worked examples", () => {
  it("loose stone → removal $0", () => {
    expect(stoneRemovalOfferFor("LOOSE")).toEqual({ kind: "not_needed" });
    expect(stoneRemovalChargeFor("LOOSE")).toBe(0n);
    expect(stoneRemovalRequiredFor("LOOSE")).toBe(false);
  });

  it("prong-mounted stone → removal $50, required", () => {
    expect(stoneRemovalOfferFor("MOUNTED_PRONG")).toEqual({
      kind: "required",
      feeMinorUnits: 5_000n,
    });
    expect(stoneRemovalChargeFor("MOUNTED_PRONG")).toBe(5_000n);
    expect(stoneRemovalRequiredFor("MOUNTED_PRONG")).toBe(true);
  });

  it("unsupported mounted stone → service unavailable, $0", () => {
    expect(stoneRemovalOfferFor("MOUNTED_UNSUPPORTED")).toEqual({ kind: "unavailable" });
    expect(stoneRemovalChargeFor("MOUNTED_UNSUPPORTED")).toBe(0n);
    expect(stoneRemovalRequiredFor("MOUNTED_UNSUPPORTED")).toBe(false);
  });
});

describe("the charge is not a choice", () => {
  it("takes the mounted state and nothing else", () => {
    // There is no `selected` parameter to pass, so "prong-set but no removal"
    // is not a state this module can be asked to price. That is the whole
    // point of the correction: the customer's decision was the answer to the
    // intake question, and $50 is its disclosed consequence.
    expect(stoneRemovalChargeFor.length).toBe(1);
    expect(stoneRemovalRequiredFor.length).toBe(1);
    expect(stoneRemovalOfferFor.length).toBe(1);
  });

  it("never reports a prong-set stone as not requiring removal", () => {
    // The contradictory operational state, asserted directly.
    expect(stoneRemovalRequiredFor("MOUNTED_PRONG")).toBe(true);
    expect(stoneRemovalChargeFor("MOUNTED_PRONG")).toBeGreaterThan(0n);
  });

  it("requires removal for exactly one state", () => {
    const required = STONE_MOUNTED_STATES.filter((s: StoneMountedState) =>
      stoneRemovalRequiredFor(s)
    );
    expect(required).toEqual(["MOUNTED_PRONG"]);
  });

  it("keeps required and charged in lockstep", () => {
    for (const state of STONE_MOUNTED_STATES) {
      expect(stoneRemovalChargeFor(state) > 0n).toBe(stoneRemovalRequiredFor(state));
    }
  });
});

describe("the fee is flat", () => {
  it("is exactly $50.00 in integer minor units", () => {
    expect(STONE_REMOVAL_FEE_MINOR_UNITS).toBe(5_000n);
    expect(typeof STONE_REMOVAL_FEE_MINOR_UNITS).toBe("bigint");
  });

  it("cannot be scaled by anything, because nothing else is an input", () => {
    // No prong count, carat weight, stone size, ring value or mounting value
    // can reach the amount: the signature has nowhere to put them.
    expect(stoneRemovalChargeFor("MOUNTED_PRONG")).toBe(STONE_REMOVAL_FEE_MINOR_UNITS);
  });

  it("charges once, not once per prong", () => {
    const offer = stoneRemovalOfferFor("MOUNTED_PRONG");
    expect(offer.kind === "required" && offer.feeMinorUnits).toBe(5_000n);
  });
});

describe("the three states", () => {
  it("are exactly these, in this spelling", () => {
    expect([...STONE_MOUNTED_STATES]).toEqual([
      "LOOSE",
      "MOUNTED_PRONG",
      "MOUNTED_UNSUPPORTED",
    ]);
  });

  it("each have an answer and an outcome", () => {
    for (const state of STONE_MOUNTED_STATES) {
      expect(["not_needed", "required", "unavailable"]).toContain(
        stoneRemovalOfferFor(state).kind
      );
      expect(STONE_MOUNTED_QUESTION.answers[state]).toBeTruthy();
    }
  });

  it("reject anything else", () => {
    for (const bad of ["loose", "MOUNTED", "BEZEL", "", null, undefined, 1, true, {}]) {
      expect(isStoneMountedState(bad)).toBe(false);
    }
    for (const state of STONE_MOUNTED_STATES) expect(isStoneMountedState(state)).toBe(true);
  });

  it("never silently turn an unsupported setting into a loose stone", () => {
    // §14. They are different facts with different fulfilment consequences:
    // a loose stone arrives ready to set, an unsupported one must be taken
    // apart by someone else first.
    expect(stoneRemovalOfferFor("MOUNTED_UNSUPPORTED")).not.toEqual(
      stoneRemovalOfferFor("LOOSE")
    );
  });
});

describe("the approved copy", () => {
  it("names the service and its price", () => {
    expect(STONE_REMOVAL_COPY.offerLabel).toBe("Stone Removal — $50");
  });

  it("describes prong removal without promising it is risk-free", () => {
    expect(STONE_REMOVAL_COPY.offered).toBe(
      "Our jewelers can carefully remove your center stone from a standard " +
        "prong setting before setting it into your new mounting."
    );
    expect(STONE_REMOVAL_COPY.offered).not.toMatch(
      /risk[- ]free|guarantee|guaranteed safe|no possibility|cannot be damaged|safely/i
    );
  });

  it("declines the unsupported case without ending the customer's visit", () => {
    expect(STONE_REMOVAL_COPY.unavailable).toBe(
      "We currently only offer stone removal for prong-set stones. Please have " +
        "your stone professionally removed before sending it to CaratForUs. You " +
        "can still continue designing your new setting."
    );
    // Both halves: do not send us a mounted stone, and carry on designing.
    expect(STONE_REMOVAL_COPY.unavailable).toMatch(/professionally removed before sending/);
    expect(STONE_REMOVAL_COPY.unavailable).toMatch(/continue designing your new setting/);
  });

  it("asks the question the owner approved, with the three approved answers", () => {
    expect(STONE_MOUNTED_QUESTION.label).toBe("Is your stone currently mounted?");
    expect(STONE_MOUNTED_QUESTION.answers.LOOSE).toBe("No — my stone is loose");
    expect(STONE_MOUNTED_QUESTION.answers.MOUNTED_PRONG).toBe("Yes — in a prong setting");
    expect(STONE_MOUNTED_QUESTION.answers.MOUNTED_UNSUPPORTED).toBe(
      "Yes — in another type of setting"
    );
  });

  it("does not ask the customer to self-diagnose a setting type", () => {
    const shown = [
      ...Object.values(STONE_MOUNTED_QUESTION.answers),
      STONE_MOUNTED_QUESTION.label,
    ].join(" ");
    expect(shown).not.toMatch(/bezel|tension|flush|channel|claw|double/i);
  });
});
