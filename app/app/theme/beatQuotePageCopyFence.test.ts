import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE BEAT YOUR QUOTE PAGE STATES MATERIAL TERMS AS PAGE COPY. THIS PINS THEM
 * TO THE LOCKED DOCUMENTS ON BOTH SIDES.
 *
 * ============================================================================
 * WHY THIS FENCE EXISTS
 * ============================================================================
 * `publishedPolicyTerms.ts` carries the argument in full: a policy page does
 * not RESTATE a material term, it quotes the authoritative `policy_version`
 * row, because a typed-in copy has nothing keeping it equal to the sentence
 * the customer acknowledged and the first time anyone notices the drift is a
 * dispute where our own page contradicts our own evidence.
 *
 * The page redesign pulled from LAUNCH 188329197786 keeps that discipline for
 * the quoted half: the `terms` section is still `policy-terms` with
 * `group: quote-match`, so the six acknowledgment sentences come from the
 * database. But the new narrative half states figures of its own in TEMPLATE
 * SETTINGS: the 7 calendar day window, the 10% / $100 fallback, its 90 day
 * validity, and which products it may be redeemed on. Those are settings
 * values edited in the Shopify theme editor by whoever is laying out the page,
 * with nothing connecting them to `docs/LET-US-BEAT-YOUR-QUOTE.md` or its
 * amendment.
 *
 * So this is a two-sided fence, and that is the whole point:
 *
 *   1. THE DOCUMENT SIDE asserts the locked documents still say what the page
 *      is relying on. If the owner changes the fallback to 15%, or to 60 days,
 *      or lets it apply to Luxury Steals, these assertions fail and name the
 *      page as the thing that has to move. A fence that only read the theme
 *      would go on passing happily while the page advertised a withdrawn
 *      policy.
 *
 *   2. THE PAGE SIDE asserts the template still carries exactly the figures it
 *      carries today. A theme-editor edit that drops "up to $100", or quietly
 *      offers the fallback on a Group Buy, fails here rather than in front of
 *      a customer.
 *
 * THE AMENDMENT CONTROLS. `docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md` supersedes
 * the original wherever they conflict (CLAUDE.md; the amendment's own §6), and
 * on these terms they DO conflict: the original makes an active online listing
 * guarantee eligible and says nothing about expiry, while the amendment makes
 * online listings review-only and gives the fallback 90 calendar days. Every
 * authoritative phrase below is therefore taken from the amendment, except the
 * two the amendment does not restate.
 *
 * ============================================================================
 * THE TWO GAPS THIS FENCE ORIGINALLY RECORDED ARE BOTH RESOLVED
 * ============================================================================
 * When this fence was written, two page strings were narrower than the locked
 * wording and were pinned as they read, because customer-facing copy is the
 * owner's decision and a test is not the place to quietly rewrite it. Both
 * were decided on 2026-11-26, in opposite directions:
 *
 *   - VALIDITY: the page's "Valid for 90 days" was adopted as the decision,
 *     and the specification's fallback rules, which previously stated no
 *     validity period at all, now state "valid for 90 days from issuance".
 *     The amendment keeps the fuller "valid for 90 calendar days from
 *     issuance" and still controls, and `fallbackBenefit.ts` computes expiry
 *     on calendar days regardless of either phrasing.
 *
 *   - COMBINING: the page's "Generally cannot be combined with another
 *     promotion unless approved" was replaced. The hedge "generally" is gone,
 *     "promotion" is now "promotional discount", and the approver is named.
 *     The page now reads "Cannot be combined with another promotional discount
 *     unless CaratForUs expressly authorizes it" against the amendment's "not
 *     stackable with another promotional discount unless CaratForUs expressly
 *     authorizes the combination". What remains between them is voice, not
 *     substance: "cannot be combined with" for "not stackable with", and
 *     "authorizes it" for "authorizes the combination".
 *
 * Both strings stay pinned, so neither can drift back.
 *
 * NOT IN SCOPE: the acknowledgment sentences. Those live in the database and
 * are pinned by `beatQuoteAcknowledgmentParity.test.ts` and
 * `acknowledgmentText.test.ts`.
 */

const THEME = join(process.cwd(), "..", "theme");
const DOCS = join(process.cwd(), "..", "docs");

const AMENDMENT = readFileSync(join(DOCS, "LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md"), "utf8");
const ORIGINAL = readFileSync(join(DOCS, "LET-US-BEAT-YOUR-QUOTE.md"), "utf8");

interface Section {
  readonly type: string;
  readonly settings?: Record<string, unknown>;
  readonly blocks?: Record<string, { type: string; settings?: Record<string, unknown> }>;
}

/**
 * Shopify's theme editor prepends a nine line auto-generated comment to JSON
 * templates it has touched. The repo's copy has none and the pull strips it,
 * but tolerate it here rather than have this fence fail as a parse error on a
 * future pull that forgets.
 */
function template(): Record<string, Section> {
  const raw = readFileSync(join(THEME, "templates", "page.policy-quote-match.json"), "utf8").replace(
    /^\s*\/\*[\s\S]*?\*\//,
    ""
  );
  const parsed = JSON.parse(raw) as { sections?: Record<string, Section> };
  if (!parsed.sections) throw new Error("page.policy-quote-match.json has no sections");
  return parsed.sections;
}

function section(id: string): Section {
  const found = template()[id];
  if (!found) {
    throw new Error(
      `page.policy-quote-match.json has no "${id}" section. The page was restructured; ` +
        `re-read it against the locked documents before changing this fence.`
    );
  }
  return found;
}

/** Every string setting of a section and its blocks, for substring checks. */
function copyOf(id: string): string {
  const s = section(id);
  const strings: string[] = Object.values(s.settings ?? {}).filter((v): v is string => typeof v === "string");
  for (const block of Object.values(s.blocks ?? {})) {
    strings.push(...Object.values(block.settings ?? {}).filter((v): v is string => typeof v === "string"));
  }
  return strings.join("\n");
}

function setting(id: string, key: string): string {
  const value = section(id).settings?.[key];
  if (typeof value !== "string") throw new Error(`${id}.${key} is not a string setting`);
  return value;
}

/** A newline separated list setting, as the carat-beat-fallback schema stores them. */
function listSetting(id: string, key: string): string[] {
  return setting(id, key)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("the locked documents still say what the page copy relies on", () => {
  it.each([
    ["the 7 calendar day guarantee window", "custom jewelry quote issued within the 7 calendar days immediately preceding submission"],
    ["10% off one eligible purchase", "**10% off one eligible CaratForUs purchase**"],
    ["the $100 cap", "**maximum discount $100**"],
    ["90 calendar days from issuance", "**valid for 90 calendar days from issuance**"],
    ["single use", "**single use**"],
    ["non-transferable", "**non-transferable**"],
    ["no cash value", "**no cash value**"],
    [
      "the no-stacking rule",
      "**not stackable with another promotional discount unless CaratForUs expressly authorizes the combination**",
    ],
    ["what the fallback is redeemable on", "redeemable on eligible regular Buy Now merchandise or Custom Jewelry"],
    [
      "what the fallback is not redeemable on",
      "**not redeemable on Community Group Buys or Luxury Steals**",
    ],
    ["online listings carry no guarantee", "**not eligible for the guaranteed match-or-beat promise**"],
    ["online listings carry no fallback", "**does not qualify for the 10%-off fallback benefit**"],
    [
      "competing Group Buys carry neither",
      "Competing Group Buys remain review-only with no guarantee/fallback.",
    ],
  ])("the amendment still states %s", (_label, phrase) => {
    expect(
      AMENDMENT,
      `The locked amendment no longer contains this phrase. If the policy changed, ` +
        `templates/page.policy-quote-match.json advertises the OLD policy to customers ` +
        `and must be revised with it. Do not relax this assertion to match a changed ` +
        `document without changing the page.`
    ).toContain(phrase);
  });

  /**
   * The original document is the source for the "maximum savings" phrasing the
   * page's fallback section uses, and for the Group Buys / Luxury Steals
   * exclusion in those exact words. The amendment says the same things
   * differently, so both documents are load-bearing for this page.
   */
  it("the original specification still states the fallback cap and the exclusion", () => {
    expect(ORIGINAL).toContain("10% off one eligible CaratForUs purchase, up to a maximum discount of $100");
    expect(ORIGINAL).toContain("maximum savings = **$100**");
    expect(ORIGINAL).toContain("**Group Buys and Luxury Steals are excluded**");
  });
});

describe("the page still quotes the authoritative acknowledgment rows", () => {
  /**
   * The redesign replaced the entire body of this page. Had it dropped the
   * policy-terms section, the six acknowledgment sentences, including the
   * authenticity term this branch versions, would not appear on the page at
   * all, and every figure checked below would be the only statement of the
   * terms a customer ever saw.
   */
  it("keeps the policy-terms section bound to the quote-match group", () => {
    const terms = section("terms");
    expect(terms.type).toBe("policy-terms");
    expect(terms.settings?.group).toBe("quote-match");
    expect(terms.settings?.show_version).toBe(true);
  });

  it("states no acknowledgment sentence of its own anywhere in the template", () => {
    // Those come from the database through /apps/carat/policies. A copy typed
    // into the page would be the second copy of a legal sentence, which is
    // the failure this page's design avoids.
    const whole = readFileSync(join(THEME, "templates", "page.policy-quote-match.json"), "utf8");
    for (const opener of ["I certify", "I confirm the quote", "I understand CaratForUs"]) {
      expect(whole, `an acknowledgment sentence is hardcoded in the template: ${opener}`).not.toContain(opener);
    }
  });
});

describe("the fallback figures on the page", () => {
  it("offers 10% off one eligible purchase capped at $100", () => {
    expect(setting("fallback", "offer")).toBe(
      "10% off one eligible CaratForUs purchase, up to $100 maximum savings."
    );
  });

  it("repeats the same 10% and $100 figures in the custom quote section", () => {
    const highlight = setting("custom_quote", "highlight");
    expect(highlight).toContain("10% off one eligible CaratForUs purchase, up to $100");
  });

  it("names the five fallback rules, in the amendment's order", () => {
    // Both of these were owner decisions on 2026-11-26; see this file's
    // header. "Valid for 90 days" is the adopted wording and the
    // specification now matches it. The combining rule lost its "generally"
    // hedge, gained "promotional discount" for "promotion", and names
    // CaratForUs as the approver, which is what the amendment requires.
    expect(listSetting("fallback", "rules_items")).toEqual([
      "Valid for 90 days",
      "Single use",
      "Non-transferable",
      "No cash value",
      "Cannot be combined with another promotional discount unless CaratForUs expressly authorizes it",
    ]);
  });

  /**
   * The hedge specifically. A material term that says a restriction applies
   * "generally" tells a customer nothing about their own case, and it is the
   * kind of word that creeps back in when copy is edited for tone in the
   * theme editor. The amendment contains no such qualifier.
   */
  it("states the combining rule without a hedge", () => {
    const rule = listSetting("fallback", "rules_items")[4] ?? "";
    expect(rule.toLowerCase()).not.toMatch(/\b(generally|usually|normally|typically|in most cases)\b/);
    expect(rule).toContain("CaratForUs expressly authorizes");
  });

  it("lists exactly the two eligible purchase types", () => {
    expect(listSetting("fallback", "eligible_items")).toEqual([
      "Eligible regular Buy Now merchandise",
      "Custom Jewelry",
    ]);
  });

  it("lists exactly the two excluded purchase types", () => {
    // Adding a third exclusion, or removing one, is a policy change. Removing
    // Luxury Steals would advertise the fallback on final sale merchandise.
    expect(listSetting("fallback", "excluded_items")).toEqual(["Group Buys", "Luxury Steals"]);
  });

  it("says online prices and competing Group Buys do not qualify for it", () => {
    expect(setting("fallback", "foot")).toContain(
      "Online prices and competing Group Buys do not qualify for the fallback."
    );
  });

  it("scopes the whole section to qualifying custom quotes", () => {
    expect(setting("fallback", "tag")).toBe("Qualifying custom quotes only");
    expect(setting("fallback", "intro")).toContain("qualifying recent written custom jewelry quote");
  });
});

describe("the 7 calendar day window belongs to the custom quote path only", () => {
  it("the custom quote section states the window", () => {
    expect(copyOf("custom_quote")).toContain("issued within the last 7 calendar days");
  });

  it("the custom quote section says older quotes lose the guarantee and the fallback", () => {
    expect(setting("custom_quote", "note")).toContain("without the guarantee or the 10% fallback");
  });

  it.each(["online_price", "group_buy"])("the %s section claims no age window of its own", (id) => {
    // The amendment is explicit that there is no 7 day rule for a review-only
    // path, because age is not what makes it reviewable. A window stated here
    // would imply a guarantee that does not exist for this path.
    expect(copyOf(id)).not.toMatch(/7 calendar days|7 days/);
  });
});

describe("the review-only paths promise nothing", () => {
  it("the online price section states no guaranteed outcome and no fallback", () => {
    const note = setting("online_price", "note");
    expect(note).toContain("no guaranteed outcome");
    expect(note).toContain(
      "The match or beat guarantee and the 10% fallback apply only to qualifying recent written custom quotes."
    );
  });

  it("the group buy section states no guaranteed outcome and no fallback", () => {
    expect(setting("group_buy", "note")).toContain(
      "no guaranteed match or beat outcome and no 10% fallback"
    );
  });

  it.each(["online_price", "group_buy"])("the %s section never shows the fallback figures", (id) => {
    const copy = copyOf(id);
    // "10% fallback" appears in both, inside a sentence that WITHDRAWS it.
    // "$100" and "10% off" are the figures themselves, and a review-only path
    // stating them reads as an offer however the sentence around them is built.
    expect(copy, `${id} states the $100 cap, which only the guarantee carries`).not.toContain("$100");
    expect(copy, `${id} offers 10% off, which only the guarantee carries`).not.toContain("10% off");
  });

  it.each(["online_price", "group_buy"])("the %s section never makes the guarantee promise", (id) => {
    // The unconditional promise sentence is the custom quote section's alone.
    expect(copyOf(id)).not.toContain("we will match or beat the qualifying jewelry price");
  });
});
