import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * POLICY/COPY CONSISTENCY FOR THE APPROVED FAQ.
 *
 * ============================================================================
 * WHY A TEST AND NOT A REVIEW
 * ============================================================================
 * The FAQ restates, in plain language, rules that are locked elsewhere. A
 * review catches a contradiction on the day it is written; this catches one
 * introduced a year later by someone tidying the wording, which is when it
 * actually happens.
 *
 * Two kinds of assertion:
 *
 *   1. the owner's own approved sentences appear VERBATIM — they are
 *      decisions, not drafts, and a stylistic edit to one is a silent change
 *      to what the business promised;
 *   2. the forbidden wording each locked policy names BY NAME never appears
 *      in customer-facing copy.
 *
 * ============================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ============================================================================
 * It does not check that the FAQ is a correct summary of every locked policy.
 * That is a reading task, and a test claiming to do it would be lying. It
 * checks the specific, enumerable things the locked documents forbid or fix.
 */

const REPO_ROOT = join(process.cwd(), "..");
const FAQ_PATH = join(REPO_ROOT, "docs", "specs", "SLICE-12-FAQ-COPY-PROPOSAL.md");
const FAQ = readFileSync(FAQ_PATH, "utf8");

/** Collapses quote markers and wrapping so a sentence can be matched across lines. */
function flatten(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

const FLAT = flatten(FAQ);

/**
 * ONLY THE TEXT A CUSTOMER WOULD READ.
 *
 * ============================================================================
 * WHY THIS IS BLOCK-BASED AND NOT LINE-BASED
 * ============================================================================
 * The first version of this filtered out any LINE containing a warning
 * marker, which was wrong in a way worth recording. A fence is a MULTI-LINE
 * blockquote and only its first line carries the marker, so every
 * continuation line — the lines that actually spell out "never write
 * surcharge", "no APO/FPO", "every diamond is" — was scanned as though it
 * were customer copy. Six assertions failed against the very warnings that
 * exist to prevent those words.
 *
 * A blockquote BLOCK is the right unit: consecutive `>` lines, ended by any
 * line that is not one. If any line in the block carries a marker, the whole
 * block is commentary.
 */
function customerFacingText(markdown: string): string {
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) {
      current.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);

  return blocks
    .filter((block) => !block.some((line) => /⚠️|🚦/.test(line)))
    .map((block) => block.join(" "))
    .join(" ")
    .replace(/\s+/g, " ");
}

const CUSTOMER_FACING = customerFacingText(FAQ);

describe("the extractor separates customer copy from the fences", () => {
  it("keeps the answers", () => {
    // Guard the guard. If this returned nothing, every "never says X"
    // assertion below would pass while checking an empty string.
    expect(CUSTOMER_FACING.length).toBeGreaterThan(3000);
    expect(CUSTOMER_FACING).toContain("Bank Payment Price");
  });

  it("drops the fences, which necessarily name the forbidden words", () => {
    expect(FAQ).toMatch(/surcharge/i); // present in a warning
    expect(CUSTOMER_FACING).not.toMatch(/surcharge/i); // absent from the copy
  });
});

describe("the owner's approved answers appear verbatim", () => {
  /**
   * One fragment per decision, long enough that a reworded version fails.
   * Transcribed from the owner's message rather than copied out of the file —
   * copying from the file would only assert that the file equals itself.
   */
  const APPROVED: readonly { readonly decision: string; readonly text: string }[] = [
    {
      decision: "1 — production and delivery timing",
      text:
        "Unless CaratForUs expressly states otherwise in writing, production and delivery dates are " +
        "estimates and are not guaranteed.",
    },
    {
      decision: "2 — materials and stones",
      text:
        "We source from multiple suppliers, so origin can vary by item. If an independent grading report, " +
        "certification, treatment, sourcing statement, or specific origin applies to a piece, it will be " +
        "stated for that item.",
    },
    {
      decision: "3 — ring resizing",
      text:
        "Resizing itself is not a manufacturing defect. Damage caused by unauthorized third-party " +
        "resizing, repair, alteration, or modification is not covered by the limited warranty. Work " +
        "performed or expressly authorized by CaratForUs does not automatically void the rest of the " +
        "warranty.",
    },
    {
      decision: "4 — shipping and duties",
      text:
        "CaratForUs currently ships within the 50 United States and Washington, D.C. We do not currently " +
        "offer international shipping.",
    },
    {
      decision: "5 — refund processing time",
      text:
        "Once an eligible return has been received, inspected when required, and approved, CaratForUs " +
        "will initiate the approved refund within 5 business days. Your bank or payment provider may " +
        "take additional time to post the funds to your account.",
    },
    {
      decision: "6 — contact channels",
      text:
        "Need help? Contact CaratForUs through our Contact Us form or email us at support@caratforus.com.",
    },
  ];

  for (const { decision, text } of APPROVED) {
    it(`decision ${decision}`, () => {
      expect(FLAT, `the owner's approved wording for decision ${decision} is not present verbatim`).toContain(
        text
      );
    });
  }
});

describe("the owner's approved warranty-examples sentence is still reused verbatim", () => {
  it("matches STOREFRONT-COPY-DECISIONS §2.2 exactly", () => {
    // Approved as a REWRITE of my draft, because the original implied any
    // loose stone is automatically covered. Paraphrasing it would reintroduce
    // precisely the problem the owner corrected.
    const approved =
      "Examples may include defective solder joints, structural workmanship failures, setting defects, " +
      "and defective clasps or mechanisms under normal use.";

    const decisions = flatten(
      readFileSync(join(REPO_ROOT, "docs", "specs", "STOREFRONT-COPY-DECISIONS.md"), "utf8")
    );
    expect(decisions).toContain(approved);
    expect(FLAT).toContain(approved);
  });
});

describe("BANK-CARD-PRICING §6 forbidden wording never reaches customer copy", () => {
  it("never says surcharge, card fee, cash discount or cash price", () => {
    for (const forbidden of [
      /surcharge/i,
      /card fee/i,
      /cash discount/i,
      /cash[- ]equivalent price/i,
      /\bcash price\b/i,
    ]) {
      expect(
        CUSTOMER_FACING,
        `forbidden pricing wording ${forbidden} reached customer-facing copy`
      ).not.toMatch(forbidden);
    }
  });

  it("never quotes the internal CARD-PRICING percentage", () => {
    /**
     * SCOPED, AND THE SCOPE IS THE WHOLE POINT.
     *
     * The first version of this banned every "%" in customer copy and failed
     * on "50% restocking fee" and "100% merchandise credit" — which
     * `BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §4 and §10 REQUIRE us to
     * disclose. A test that forbids a required disclosure is worse than no
     * test, because the way to make it pass is to delete the disclosure.
     *
     * What §6 of BANK-CARD-PRICING actually forbids is displaying the
     * internal card uplift rate: "4% discount", "4% cash discount", "4%
     * credit card fee", "Credit card surcharge". So the ban is a percentage
     * in the same breath as a PAYMENT word, not a percentage anywhere.
     */
    /**
     * NARROWED A SECOND TIME. The first scoping included the bare words
     * "fee" and "discount", which matched "50% restocking fee" — a required
     * returns disclosure that merely happens to contain the word "fee". The
     * terms below name the CARD-PRICING context specifically, which is the
     * only percentage §6 forbids.
     */
    const cardPricingContext = String.raw`(credit card|card price|card fee|bank payment|surcharge|cash discount)`;
    const percentThenContext = new RegExp(String.raw`\d+(\.\d+)?\s*%[^.]{0,60}${cardPricingContext}`, "i");
    const contextThenPercent = new RegExp(String.raw`${cardPricingContext}[^.]{0,60}\d+(\.\d+)?\s*%`, "i");

    expect(CUSTOMER_FACING).not.toMatch(percentThenContext);
    expect(CUSTOMER_FACING).not.toMatch(contextThenPercent);
  });

  it("still carries the restocking-fee disclosure the returns policy requires", () => {
    // The flip side of the scoping above: having narrowed the ban, assert
    // the required percentages are actually present, so a later edit cannot
    // quietly drop them and pass.
    expect(CUSTOMER_FACING).toMatch(/50% restocking fee/);
    expect(CUSTOMER_FACING).toMatch(/100% merchandise credit/);
  });
});

describe("WARRANTY-CLAIMS §12 — things never to promise", () => {
  it("never mentions the internal local-jeweller option (§7)", () => {
    expect(CUSTOMER_FACING).not.toMatch(/local jewel+er/i);
  });

  it("never PROMISES a prepaid label — while keeping the required denial", () => {
    /**
     * DENYING A PREPAID LABEL IS MANDATORY, NOT FORBIDDEN.
     *
     * `BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §6: "A discretionary-return
     * RMA does not obligate CaratForUs to provide a prepaid return label",
     * and §10 requires the customer-paid shipping term be disclosed. The
     * first version of this test matched the word "prepaid" near "label" and
     * failed on our own denial — the fix for which would have been deleting
     * a required disclosure.
     *
     * So: catch the affirmative forms only.
     */
    for (const promise of [
      /we('ll| will)? (provide|send|include|email)[^.]{0,40}prepaid[^.]{0,20}label/i,
      /prepaid[^.]{0,20}label (is|will be) (provided|included|sent)/i,
      /free return (shipping|label)/i,
    ]) {
      expect(CUSTOMER_FACING, `a prepaid-label promise (${promise}) appeared`).not.toMatch(promise);
    }

    // And the required denial is still there.
    expect(CUSTOMER_FACING).toMatch(/do not provide a prepaid return label/i);
  });

  it("never promises a warranty turnaround", () => {
    // A day/week figure inside the warranty section is the shape this takes.
    // The one approved timeframe (refunds) lives in §2 and is asserted
    // separately below.
    const warranty = FAQ.slice(
      FAQ.indexOf("## 7. Warranty & Repairs"),
      FAQ.indexOf("## 8. Returns & Cancellations")
    );
    expect(customerFacingText(warranty)).not.toMatch(/\d+\s*(business\s*)?(day|week|month)/i);
  });

  it("states the remedy is CaratForUs's to choose", () => {
    // §6 of the locked doc. Promising repair specifically is the forbidden
    // version; this asserts the correct one is actually present, so the
    // negative assertions above cannot pass by the answer being absent.
    expect(CUSTOMER_FACING).toMatch(/repair, replacement, refund, or something else appropriate/i);
  });
});

describe("the one approved timeframe is stated correctly", () => {
  it("counts from approval, not from the customer's request", () => {
    // The owner was explicit that this wording must not imply that submitting
    // an RMA starts the clock.
    expect(FLAT).toMatch(
      /received, inspected when required, and approved, CaratForUs will initiate the approved refund within 5 business days/
    );
  });

  it("does not promise when funds appear in the customer's account", () => {
    expect(FLAT).toMatch(/may take additional time to post the funds/);
    expect(CUSTOMER_FACING).not.toMatch(/funds will (appear|be available|post) within/i);
  });

  it("is the only timeframe CARATFORUS promises — customer deadlines are separate", () => {
    /**
     * THE DISTINCTION THE FIRST VERSION MISSED.
     *
     * It banned every "within N days" and failed on "we need the item within
     * 10 days", which is `BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §4's
     * receive-by deadline — a term the customer must meet, and one §10
     * requires us to disclose. Deleting it to make a test pass would have
     * removed a locked disclosure.
     *
     * A timeframe is only a PROMISE when CaratForUs is the actor. So: find
     * every duration, and require each one to be either the approved refund
     * commitment or a customer-facing deadline from the returns policy.
     */
    const durations = CUSTOMER_FACING.match(/within \d+ (business |calendar )?(day|week|month)s?/gi) ?? [];
    const normalised = durations.map((d) => d.toLowerCase());

    // The one thing we promise to do.
    expect(normalised).toContain("within 5 business days");

    /**
     * Everything else must be a deadline the LOCKED returns policy sets on
     * the CUSTOMER, each traceable to a section:
     *
     *   "within 7 days"  — §3, request the RMA within 7 calendar days
     *   "within 10 days" — §4, item received within 10 days of approval
     *
     * Both are disclosures §10 requires, not promises. Adding to this set is
     * how a new customer deadline gets through; adding a CaratForUs-side
     * duration to it would be the mistake, which is why the actor-based
     * assertion below exists as well.
     */
    const allowedDeadlines = new Set(["within 7 days", "within 10 days", "within 5 business days"]);
    for (const duration of normalised) {
      expect(
        allowedDeadlines.has(duration),
        `"${duration}" is a timeframe no locked policy or owner decision establishes`
      ).toBe(true);
    }
  });

  it("promises no CaratForUs-side duration other than the refund one", () => {
    // The sharper form of the same rule: phrases where WE are the actor.
    const weWill =
      /\b(we|CaratForUs) (will |'ll )?[a-z ]{0,30}(ship|deliver|complete|repair|respond|repl(y|ace))[^.]{0,40}within \d+/i;
    expect(CUSTOMER_FACING).not.toMatch(weWill);
  });
});

describe("decision 1 — no blanket production SLA", () => {
  it("quotes no production or delivery duration", () => {
    const production = FAQ.slice(
      FAQ.indexOf("## 3. Production & Delivery"),
      FAQ.indexOf("## 4. Materials & Stones")
    );
    expect(customerFacingText(production)).not.toMatch(/\d+\s*[–-]\s*\d+\s*(day|week|month)/i);
    expect(customerFacingText(production)).not.toMatch(/\d+\s*(business\s*)?(day|week|month)/i);
  });

  it("says the dates are estimates, not guarantees", () => {
    expect(CUSTOMER_FACING).toMatch(/estimates and are not guaranteed/);
  });
});

describe("decision 2 — no catalog-wide materials claim", () => {
  it("never claims every item is certified, natural, lab-grown, untreated or conflict-free", () => {
    for (const forbidden of [
      /all (our |of our )?diamonds are/i,
      /every diamond is/i,
      /conflict[- ]free/i,
      /ethically sourced/i,
      /all (our |of our )?(gemstones|stones) are untreated/i,
    ]) {
      expect(
        CUSTOMER_FACING,
        `a catalog-wide materials claim (${forbidden}) appeared`
      ).not.toMatch(forbidden);
    }
  });

  it("says origin varies by item", () => {
    expect(CUSTOMER_FACING).toMatch(/origin can vary by item/);
  });
});

describe("decision 3 — resizing, with both opposite errors excluded", () => {
  it("does not promise free resizing", () => {
    expect(CUSTOMER_FACING).not.toMatch(/free resiz/i);
    expect(CUSTOMER_FACING).not.toMatch(/resize[^.]{0,30}at no (cost|charge)/i);
  });

  it("does not claim resizing voids the whole warranty", () => {
    expect(CUSTOMER_FACING).not.toMatch(/voids (your |the )?(entire |whole )?warranty/i);
    // And states the narrower, correct rule.
    expect(CUSTOMER_FACING).toMatch(/does not automatically void the rest of the warranty/);
  });
});

describe("decision 4 — domestic only, stated exactly", () => {
  it("does not offer international shipping, APO/FPO or territories", () => {
    expect(CUSTOMER_FACING).toContain("We do not currently offer international shipping");
    // Each is a separate owner approval, not an extension of this one.
    for (const forbidden of [/\bAPO\b/, /\bFPO\b/, /Puerto Rico/i, /\bGuam\b/i, /Virgin Islands/i]) {
      expect(CUSTOMER_FACING, `an unapproved destination (${forbidden}) appeared`).not.toMatch(forbidden);
    }
  });
});

describe("decision 6 — two channels, and only the approved address", () => {
  it("advertises no telephone, SMS, live chat or support hours", () => {
    for (const forbidden of [
      /live chat/i,
      /call us/i,
      /phone number/i,
      /text us/i,
      /support hours/i,
      /\bSMS\b/,
    ]) {
      expect(CUSTOMER_FACING, `an unstaffed channel (${forbidden}) was advertised`).not.toMatch(forbidden);
    }
  });

  it("names support@caratforus.com and no other address", () => {
    const addresses = new Set(CUSTOMER_FACING.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []);
    expect([...addresses]).toEqual(["support@caratforus.com"]);
  });
});

describe("the fences survive", () => {
  it("still carries every policy warning", () => {
    // These mark where an innocent edit breaches a locked policy. A rewrite
    // that drops them removes the only thing telling the next person.
    expect((FAQ.match(/⚠️/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });

  it("still flags the support address as a launch blocker", () => {
    expect(FAQ).toMatch(/🚦/);
    expect(FLAT).toMatch(/MUST BE PROVISIONED AND TESTED BEFORE THIS ANSWER IS PUBLISHED/);
  });

  it("leaves no unresolved marker", () => {
    expect(FAQ).not.toContain("[NEEDS YOUR FACTS]");
  });
});
