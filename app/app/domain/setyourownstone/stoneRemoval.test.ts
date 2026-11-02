import { describe, expect, it } from "vitest";

import {
  STONE_MOUNTED_QUESTION,
  STONE_MOUNTED_STATES,
  STONE_REMOVAL_COPY,
  STONE_REMOVAL_FEE_MINOR_UNITS,
  isStoneMountedState,
  stoneRemovalChargeFor,
  stoneRemovalIsPurchasable,
  stoneRemovalOfferFor,
  stoneRemovalSelectionIsValid,
  type StoneMountedState,
} from "./stoneRemoval";

/**
 * The $50 prong-only Stone Removal rule (§17.3, owner message 2026-11-02).
 *
 * The owner's three worked examples are the first three tests; the rest are the
 * ways this could go wrong with money or with liability.
 */
describe("the owner's worked examples", () => {
  it("loose stone → removal $0", () => {
    expect(stoneRemovalOfferFor("LOOSE")).toEqual({ kind: "not_needed" });
    expect(stoneRemovalChargeFor("LOOSE", false)).toBe(0n);
  });

  it("prong-mounted stone → removal $50", () => {
    expect(stoneRemovalOfferFor("MOUNTED_PRONG")).toEqual({
      kind: "offered",
      feeMinorUnits: 5_000n,
    });
    expect(stoneRemovalChargeFor("MOUNTED_PRONG", true)).toBe(5_000n);
  });

  it("unsupported mounted stone → service unavailable, $0", () => {
    expect(stoneRemovalOfferFor("MOUNTED_UNSUPPORTED")).toEqual({ kind: "unavailable" });
    expect(stoneRemovalChargeFor("MOUNTED_UNSUPPORTED", true)).toBe(0n);
  });
});

describe("the fee is flat", () => {
  it("is exactly $50.00 in integer minor units", () => {
    expect(STONE_REMOVAL_FEE_MINOR_UNITS).toBe(5_000n);
    expect(typeof STONE_REMOVAL_FEE_MINOR_UNITS).toBe("bigint");
  });

  it("takes no input but the mounted state", () => {
    // Nothing about prong count, carat weight, stone size, ring value or
    // mounting value can reach the amount, because the signature has nowhere
    // to put it. That is the cheapest possible guarantee against a fee that
    // quietly starts scaling.
    expect(stoneRemovalOfferFor.length).toBe(1);
    expect(stoneRemovalChargeFor.length).toBe(2);
  });

  it("charges once, not once per prong", () => {
    const offer = stoneRemovalOfferFor("MOUNTED_PRONG");
    expect(offer.kind === "offered" && offer.feeMinorUnits).toBe(5_000n);
    // One centre stone per session, so one charge. Four prongs or six, same $50.
    expect(stoneRemovalChargeFor("MOUNTED_PRONG", true)).toBe(5_000n);
  });
});

describe("only prong settings are purchasable", () => {
  it("offers removal for a prong setting and nothing else", () => {
    expect(stoneRemovalIsPurchasable("MOUNTED_PRONG")).toBe(true);
    expect(stoneRemovalIsPurchasable("LOOSE")).toBe(false);
    expect(stoneRemovalIsPurchasable("MOUNTED_UNSUPPORTED")).toBe(false);
  });

  it("has an answer for every state, and only these three states", () => {
    expect([...STONE_MOUNTED_STATES]).toEqual([
      "LOOSE",
      "MOUNTED_PRONG",
      "MOUNTED_UNSUPPORTED",
    ]);
    for (const state of STONE_MOUNTED_STATES) {
      expect(["not_needed", "offered", "unavailable"]).toContain(
        stoneRemovalOfferFor(state).kind
      );
      expect(STONE_MOUNTED_QUESTION.answers[state]).toBeTruthy();
    }
  });

  it("rejects anything that is not one of the three states", () => {
    for (const bad of ["loose", "MOUNTED", "BEZEL", "", null, undefined, 1, true, {}]) {
      expect(isStoneMountedState(bad)).toBe(false);
    }
    for (const state of STONE_MOUNTED_STATES) expect(isStoneMountedState(state)).toBe(true);
  });
});

describe("a selection the customer could not have been offered", () => {
  it("is not valid against a loose or unsupported stone", () => {
    expect(stoneRemovalSelectionIsValid("MOUNTED_PRONG", true)).toBe(true);
    expect(stoneRemovalSelectionIsValid("LOOSE", true)).toBe(false);
    expect(stoneRemovalSelectionIsValid("MOUNTED_UNSUPPORTED", true)).toBe(false);
  });

  it("is always valid when nothing was selected", () => {
    for (const state of STONE_MOUNTED_STATES) {
      expect(stoneRemovalSelectionIsValid(state, false)).toBe(true);
    }
  });

  it("yields no charge even if it somehow reaches the charge function", () => {
    // Defence in depth: the route rejects an invalid selection, and the charge
    // function independently refuses to price it. A tampered request has to get
    // past both to become money.
    expect(stoneRemovalChargeFor("LOOSE", true)).toBe(0n);
    expect(stoneRemovalChargeFor("MOUNTED_UNSUPPORTED", true)).toBe(0n);
  });

  it("never charges a stone the customer did not say was prong-set", () => {
    const charged = STONE_MOUNTED_STATES.filter(
      (s: StoneMountedState) => stoneRemovalChargeFor(s, true) > 0n
    );
    expect(charged).toEqual(["MOUNTED_PRONG"]);
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
    // The half that stops this being a dead end.
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
    // §2: no exhaustive customer-facing taxonomy. The customer chooses
    // prong-set or not; bezel/tension/flush/channel are our vocabulary, not a
    // menu we put in front of them.
    const shown = [
      ...Object.values(STONE_MOUNTED_QUESTION.answers),
      STONE_MOUNTED_QUESTION.label,
    ].join(" ");
    expect(shown).not.toMatch(/bezel|tension|flush|channel|claw|double/i);
  });
});
