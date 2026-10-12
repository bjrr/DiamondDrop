import { describe, expect, it } from "vitest";

import { DEMAND_CAPTURE_NOTE_MAX_LENGTH } from "./demandCaptureCopy";
import { normalizeDemandSignalEmail, parseDemandSignal } from "./demandSignal";

/**
 * Demand capture validation.
 *
 * The two things worth most here: that email normalisation actually
 * normalises (the whole dedup guarantee rests on it), and that the two kinds
 * cannot be submitted in each other's shape — a "bring it back" naming
 * nothing is unactionable, and a "new campaign request" naming an existing
 * campaign would be counted as demand for something that is not new.
 */

const VALID_BRING_BACK = { kind: "bring_it_back", email: "ada@example.com", campaignRef: "gb-summer" };
const VALID_REQUEST = { kind: "new_campaign_request", email: "ada@example.com", note: "a wider band" };

describe("email normalisation — what the dedup index depends on", () => {
  it("lowercases and trims", () => {
    expect(normalizeDemandSignalEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("normalises before validating, so a capitalised address is accepted and stored lowercase", () => {
    const result = parseDemandSignal({ ...VALID_BRING_BACK, email: "  Ada@Example.COM " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe("ada@example.com");
  });
});

describe("email shape", () => {
  it("accepts ordinary addresses", () => {
    for (const email of ["a@b.co", "ada.lovelace+gb@example.co.uk", "x_y-z@sub.domain.org"]) {
      expect(parseDemandSignal({ ...VALID_BRING_BACK, email }).ok).toBe(true);
    }
  });

  it("rejects what no mail server would accept", () => {
    for (const email of ["", "   ", "ada", "ada@", "@example.com", "ada@example", "a b@example.com", "a@b@c.com"]) {
      const result = parseDemandSignal({ ...VALID_BRING_BACK, email });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems.some((p) => p.startsWith("email_"))).toBe(true);
      }
    }
  });

  it("rejects an absurdly long address rather than storing it", () => {
    const email = `${"a".repeat(250)}@example.com`;
    const result = parseDemandSignal({ ...VALID_BRING_BACK, email });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("email_too_long");
  });
});

describe("the two kinds have different required shapes", () => {
  it("a bring-it-back MUST name a campaign", () => {
    const result = parseDemandSignal({ kind: "bring_it_back", email: "ada@example.com", campaignRef: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("campaign_required");
  });

  it("a new-campaign request MUST NOT name one", () => {
    // Otherwise it is a bring-it-back wearing the wrong label, and would be
    // counted as demand for something new that is not new.
    const result = parseDemandSignal({ ...VALID_REQUEST, campaignRef: "gb-summer" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("campaign_not_allowed");
  });

  it("a new-campaign request MUST say something", () => {
    const result = parseDemandSignal({ kind: "new_campaign_request", email: "ada@example.com", note: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("note_required");
  });

  it("a bring-it-back needs NO note — that is the low-friction case", () => {
    const result = parseDemandSignal(VALID_BRING_BACK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBeNull();
  });

  it("drops a blank note to null rather than storing an empty string", () => {
    const result = parseDemandSignal({ ...VALID_BRING_BACK, note: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBeNull();
  });

  it("nulls the campaign ref on a request, so the dedup index behaves as designed", () => {
    const result = parseDemandSignal(VALID_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.campaignRef).toBeNull();
  });
});

describe("the note is capped — this is interest capture, not a questionnaire", () => {
  it("accepts a note at the limit", () => {
    const note = "x".repeat(DEMAND_CAPTURE_NOTE_MAX_LENGTH);
    expect(parseDemandSignal({ ...VALID_REQUEST, note }).ok).toBe(true);
  });

  it("rejects one character more", () => {
    const note = "x".repeat(DEMAND_CAPTURE_NOTE_MAX_LENGTH + 1);
    const result = parseDemandSignal({ ...VALID_REQUEST, note });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain("note_too_long");
  });
});

describe("an unknown kind", () => {
  it("is rejected on its own, without a pile of consequential problems", () => {
    // The required shape DEPENDS on the kind, so reporting "campaign
    // required" for a kind we do not recognise would be noise.
    const result = parseDemandSignal({ kind: "vote", email: "ada@example.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toEqual(["unknown_kind"]);
  });

  it("rejects VOTING in particular — that is Post-MVP and deliberately absent", () => {
    expect(parseDemandSignal({ kind: "vote", email: "ada@example.com" }).ok).toBe(false);
  });
});

describe("several problems are reported together", () => {
  it("names every one, so a form marks every bad field at once", () => {
    const result = parseDemandSignal({ kind: "new_campaign_request", email: "nope", note: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContain("email_malformed");
      expect(result.problems).toContain("note_required");
    }
  });
});
