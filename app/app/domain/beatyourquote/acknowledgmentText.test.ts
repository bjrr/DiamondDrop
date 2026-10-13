import { describe, expect, it } from "vitest";

import {
  BEAT_QUOTE_AUTHENTICITY_ACTION,
  BEAT_QUOTE_AUTHENTICITY_TEXT,
  BEAT_QUOTE_GROUP_BUY_ACTION,
  BEAT_QUOTE_GROUP_BUY_TEXT,
  BEAT_QUOTE_OLDER_QUOTE_ACTION,
  BEAT_QUOTE_OLDER_QUOTE_TEXT,
  BEAT_QUOTE_ONLINE_LISTING_ACTION,
  BEAT_QUOTE_ONLINE_LISTING_TEXT,
  BEAT_QUOTE_POLICY_SLUGS,
  BEAT_QUOTE_RECENT_QUOTE_ACTION,
  BEAT_QUOTE_RECENT_QUOTE_TEXT,
  BEAT_QUOTE_WHAT_WE_MATCH_ACTION,
  BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
  selectPathAcknowledgment,
  UnmappedBeatQuotePathError,
} from "./acknowledgmentText";
import { deriveIntakeTreatment, type BeatQuoteSubmissionKind } from "./eligibility";

/**
 * OWNER-APPROVED COPY, PINNED VERBATIM. A failure here is not an expectation to
 * update — it means customer-facing text from a locked specification changed,
 * and the fix is to restore it or get new approval.
 */

describe("the approved acknowledgment text", () => {
  it("3A — recent quote, from the original spec", () => {
    expect(BEAT_QUOTE_RECENT_QUOTE_TEXT).toBe(
      "I understand that only verified custom quotes issued within the last 7 calendar days qualify for the " +
        "guaranteed match-or-beat offer and the 10%-off fallback benefit."
    );
    expect(BEAT_QUOTE_RECENT_QUOTE_ACTION).toBe("I Understand");
  });

  it("3B — older quote", () => {
    expect(BEAT_QUOTE_OLDER_QUOTE_TEXT).toBe(
      "This quote is more than 7 days old. CaratForUs will still review it and may offer a competitive " +
        "price, but there is no guarantee that CaratForUs will match or beat it and the 10%-off fallback " +
        "does not apply."
    );
    expect(BEAT_QUOTE_OLDER_QUOTE_ACTION).toBe("Submit for Review Anyway");
  });

  it("3C — competing Group Buy", () => {
    expect(BEAT_QUOTE_GROUP_BUY_TEXT).toBe(
      "I understand CaratForUs may review this Group Buy and may choose to match or beat it, but there is " +
        "no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot match or beat " +
        "the price."
    );
    expect(BEAT_QUOTE_GROUP_BUY_ACTION).toBe("Submit Group Buy for Review");
  });

  it("online listing — from the AMENDMENT, which the original spec has no equivalent for", () => {
    // The original document defines no online-listing acknowledgment because
    // there a live listing was guarantee eligible and took 3A. Amendment §1
    // moved it to review-only and supplied this wording with it.
    expect(BEAT_QUOTE_ONLINE_LISTING_TEXT).toBe(
      "I understand CaratForUs will review this online offer and may choose to match or beat it, but there " +
        "is no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot or chooses " +
        "not to match or beat the price."
    );
    expect(BEAT_QUOTE_ONLINE_LISTING_ACTION).toBe("Submit Online Offer for Review");
  });

  it("1 — what we match", () => {
    expect(BEAT_QUOTE_WHAT_WE_MATCH_TEXT).toBe(
      "I understand CaratForUs is matching or beating the price of the jewelry itself based on materially " +
        "comparable design and specifications. CaratForUs is not required to match the competing seller's " +
        "production timeline, return policy, warranty, shipping terms, payment terms, promotions, or other " +
        "services."
    );
    expect(BEAT_QUOTE_WHAT_WE_MATCH_ACTION).toBe("I Understand & Agree");
  });

  it("2 — authenticity and verification", () => {
    expect(BEAT_QUOTE_AUTHENTICITY_TEXT).toBe(
      "I confirm the quote, listing, CAD, specifications, images, and seller information I submitted are " +
        "authentic and have not been altered, fabricated, or AI-generated. I understand CaratForUs may " +
        "request additional documentation or independently verify the seller, offer, specifications, and " +
        "price."
    );
    expect(BEAT_QUOTE_AUTHENTICITY_ACTION).toBe("I Confirm");
  });
});

describe("only the guarantee variant may mention the guarantee favourably", () => {
  it("every review-only acknowledgment says there is NO guarantee and NO fallback", () => {
    // The amendment's whole point. A review-only path whose acknowledgment
    // omitted this would leave a customer believing they were promised
    // something.
    for (const [label, text] of [
      ["3B older quote", BEAT_QUOTE_OLDER_QUOTE_TEXT],
      ["3C group buy", BEAT_QUOTE_GROUP_BUY_TEXT],
      ["online listing", BEAT_QUOTE_ONLINE_LISTING_TEXT],
    ] as const) {
      expect(text.toLowerCase(), label).toMatch(/no guarantee|no guaranteed/);
      expect(text, label).toContain("10%-off fallback");
      expect(text.toLowerCase(), label).toMatch(/does not apply|no 10%-off fallback/);
    }
  });
});

describe("the variant is selected from DERIVED treatment", () => {
  it.each<[BeatQuoteSubmissionKind, string, string]>([
    ["custom_quote", "guarantee", "recent_quote"],
    ["custom_quote", "review_only", "older_quote"],
    ["online_listing", "review_only", "online_listing"],
    ["competing_group_buy", "review_only", "group_buy"],
  ])("kind=%s treatment=%s -> %s", (kind, treatment, expectedId) => {
    const copy = selectPathAcknowledgment(kind, treatment as "guarantee" | "review_only");
    expect(copy.id).toBe(expectedId);
    expect(copy.slug).toBeTruthy();
    expect(copy.text.length).toBeGreaterThan(0);
  });

  it("REFUSES a guarantee treatment on a kind that can never carry one", () => {
    // Unreachable through the schema, which also refuses it. Throwing rather
    // than defaulting matters: a fallthrough would hand the 3A guarantee
    // wording to an online listing, which is precisely the promise the
    // amendment withdrew.
    expect(() => selectPathAcknowledgment("online_listing", "guarantee")).toThrow(UnmappedBeatQuotePathError);
    expect(() => selectPathAcknowledgment("competing_group_buy", "guarantee")).toThrow(
      UnmappedBeatQuotePathError
    );
  });

  it("an online listing NEVER receives the 3A guarantee text", () => {
    // The specific regression the amendment creates the risk of.
    const copy = selectPathAcknowledgment("online_listing", "review_only");
    expect(copy.text).not.toBe(BEAT_QUOTE_RECENT_QUOTE_TEXT);
    expect(copy.text).toBe(BEAT_QUOTE_ONLINE_LISTING_TEXT);
  });
});

describe("selection agrees with the intake derivation end to end", () => {
  it("a 7-day-old quote gets 3A and an 8-day-old quote gets 3B — from dates alone", () => {
    // Composed deliberately: this is the actual production path, derivation
    // feeding selection, with no opportunity for a request to intervene.
    const seven = deriveIntakeTreatment({
      kind: "custom_quote",
      quoteIssuedOn: "2026-10-02",
      submittedOn: "2026-10-09",
    });
    expect(selectPathAcknowledgment("custom_quote", seven.treatment).id).toBe("recent_quote");

    const eight = deriveIntakeTreatment({
      kind: "custom_quote",
      quoteIssuedOn: "2026-10-01",
      submittedOn: "2026-10-09",
    });
    expect(selectPathAcknowledgment("custom_quote", eight.treatment).id).toBe("older_quote");
  });

  it("every slug is distinct — evidence rows must not share a policy", () => {
    const slugs = Object.values(BEAT_QUOTE_POLICY_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
