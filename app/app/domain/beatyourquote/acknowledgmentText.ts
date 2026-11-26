import type { BeatQuoteSubmissionKind, BeatQuoteTreatment } from "./eligibility";

/**
 * "Let Us Beat Your Quote!" acknowledgments — OWNER-APPROVED COPY, verbatim.
 *
 * Every string below is reproduced exactly from the locked specifications, not
 * drafted here. `acknowledgmentText.test.ts` pins each one character for
 * character, the same discipline `warranty/acknowledgmentText.ts` and
 * `luxurysteals/acknowledgmentText.ts` follow: an edit here is new unapproved
 * customer-facing copy however small it looks.
 *
 * ============================================================================
 * THERE ARE FOUR PATH ACKNOWLEDGMENTS, NOT THE THREE THE ORIGINAL SPEC LISTS
 * ============================================================================
 * The original document defines 3A (recent quote), 3B (older quote) and 3C
 * (competing Group Buy). It defines none for an active online listing — because
 * in that document a live listing was GUARANTEE ELIGIBLE and therefore took 3A.
 *
 * Amendment §1 moved online listings to review-only and supplied their
 * acknowledgment with it ("Recommended customer-facing acknowledgment for this
 * path"), along with its own required action, **Submit Online Offer for
 * Review**. So the amendment both removes the old mapping and provides the
 * replacement. Implementing the original's three variants alone would hand an
 * online listing the 3A text, which promises exactly the guarantee the
 * amendment withdrew.
 *
 * ============================================================================
 * THE VARIANT IS SELECTED FROM DERIVED TREATMENT, NEVER FROM THE REQUEST
 * ============================================================================
 * `selectPathAcknowledgment` takes the kind and the SERVER-DERIVED treatment.
 * There is no path by which a customer can ask for a particular variant: the
 * public request schema carries no treatment and no acknowledgment id, so a
 * tampered request cannot obtain the more favourable 3A wording for an
 * ineligible submission. The function is total over the combinations the
 * schema permits, and throws on the ones it forbids rather than falling back to
 * a default — a default here would be the 3A text for something that does not
 * qualify.
 */

/** The three material acknowledgments every submission takes, whatever its path. */
export const BEAT_QUOTE_WHAT_WE_MATCH_TEXT =
  "I understand CaratForUs is matching or beating the price of the jewelry itself based on materially " +
  "comparable design and specifications. CaratForUs is not required to match the competing seller's " +
  "production timeline, return policy, warranty, shipping terms, payment terms, promotions, or other " +
  "services.";
export const BEAT_QUOTE_WHAT_WE_MATCH_ACTION = "I Understand & Agree";

/**
 * VERSION 2 (owner decision 2026-11-25). Version 1 read:
 *
 *   "I confirm the quote, listing, CAD, specifications, images, and seller
 *   information I submitted are authentic and have not been altered,
 *   fabricated, or AI-generated. I understand CaratForUs may request additional
 *   documentation or independently verify the seller, offer, specifications,
 *   and price."
 *
 * The new wording makes the certification an explicit representation relied on,
 * names AI editing as well as AI generation, and states the consequence of
 * submitting false information. Version 1 is NOT edited; see
 * `BEAT_QUOTE_AUTHENTICITY_POLICY_VERSION` below.
 */
export const BEAT_QUOTE_AUTHENTICITY_TEXT =
  "I certify, as a formal representation made to induce CaratForUs to rely on it, that the quote, " +
  "listing, CAD, specifications, images, and seller information I have submitted are true, complete, and " +
  "authentic, and have not been altered, fabricated, or generated or edited by AI. I understand that " +
  "knowingly submitting false or altered information may result in cancellation of any resulting price, " +
  "order, or benefit, and may expose me to legal liability. I understand CaratForUs may request " +
  "additional documentation or independently verify the seller, offer, specifications, and price.";
export const BEAT_QUOTE_AUTHENTICITY_ACTION = "I Confirm";

/** 3A — a qualifying recent custom quote. */
export const BEAT_QUOTE_RECENT_QUOTE_TEXT =
  "I understand that only verified custom quotes issued within the last 7 calendar days qualify for the " +
  "guaranteed match-or-beat offer and the 10%-off fallback benefit.";
export const BEAT_QUOTE_RECENT_QUOTE_ACTION = "I Understand";

/** 3B — a custom quote older than the window. */
export const BEAT_QUOTE_OLDER_QUOTE_TEXT =
  "This quote is more than 7 days old. CaratForUs will still review it and may offer a competitive price, " +
  "but there is no guarantee that CaratForUs will match or beat it and the 10%-off fallback does not apply.";
export const BEAT_QUOTE_OLDER_QUOTE_ACTION = "Submit for Review Anyway";

/** 3C — a competing Group Buy. */
export const BEAT_QUOTE_GROUP_BUY_TEXT =
  "I understand CaratForUs may review this Group Buy and may choose to match or beat it, but there is no " +
  "guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot match or beat the price.";
export const BEAT_QUOTE_GROUP_BUY_ACTION = "Submit Group Buy for Review";

/** Amendment §1 — an active online listing. Not present in the original document. */
export const BEAT_QUOTE_ONLINE_LISTING_TEXT =
  "I understand CaratForUs will review this online offer and may choose to match or beat it, but there is " +
  "no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot or chooses not to " +
  "match or beat the price.";
export const BEAT_QUOTE_ONLINE_LISTING_ACTION = "Submit Online Offer for Review";

/**
 * The `policy_version.slug` each acknowledgment's evidence rows reference.
 *
 * Shared with the provisioning migration so both sides name the same policy by
 * construction. A future approved wording change creates a NEW version and
 * bumps the constant — never edits the string in place, which would
 * retroactively change what existing evidence says the customer agreed to.
 */
export const BEAT_QUOTE_POLICY_SLUGS = {
  whatWeMatch: "beat-quote-what-we-match",
  authenticity: "beat-quote-authenticity",
  recentQuote: "beat-quote-recent-quote-guarantee",
  olderQuote: "beat-quote-older-quote-review",
  groupBuy: "beat-quote-group-buy-review",
  onlineListing: "beat-quote-online-listing-review",
} as const;

/**
 * THE SIX SLUGS VERSION INDEPENDENTLY, and the authenticity term is the first
 * one to move.
 *
 * `BEAT_QUOTE_POLICY_VERSION` is version 1 of the five terms whose approved
 * wording has never changed. The authenticity term was rewritten on 2026-11-25
 * and is therefore version 2, provisioned by migration
 * `20261125120000_beat_quote_authenticity_policy_v2`.
 *
 * WHY NOT BUMP ALL SIX TOGETHER. `policy_version` is append-only, and an
 * `acknowledgment` row points at the version it was shown under. Inserting an
 * identical version 2 of the other five would leave an auditor with two rows
 * carrying the same words and no way to tell which one a customer saw. That is
 * the same reasoning migration `20261119120000` applied when it bumped the SMS
 * consent slug and left the email slug at version 1.
 *
 * Version 1 of the authenticity term keeps its original words for as long as
 * any acknowledgment points at it. That is the whole purpose of versioning: it
 * is what the customers who submitted before today actually read.
 */
export const BEAT_QUOTE_POLICY_VERSION = 1;
export const BEAT_QUOTE_AUTHENTICITY_POLICY_VERSION = 2;

export type BeatQuotePathAcknowledgmentId = "recent_quote" | "older_quote" | "group_buy" | "online_listing";

export interface BeatQuoteAcknowledgmentCopy {
  readonly id: BeatQuotePathAcknowledgmentId;
  readonly slug: string;
  readonly version: number;
  readonly text: string;
  readonly affirmativeActionLabel: string;
}

/** Raised when a kind/treatment pair has no acknowledgment, which should be unreachable. */
export class UnmappedBeatQuotePathError extends Error {
  constructor(kind: BeatQuoteSubmissionKind, treatment: BeatQuoteTreatment) {
    super(
      `no path acknowledgment is defined for kind=${kind} treatment=${treatment}. ` +
        `Refusing rather than defaulting: a default here would show the guarantee wording to a submission ` +
        `that does not qualify for it.`
    );
    this.name = "UnmappedBeatQuotePathError";
  }
}

/**
 * The path acknowledgment for a submission, selected from its DERIVED
 * treatment.
 *
 * THROWS RATHER THAN DEFAULTING. The one combination the schema forbids —
 * a non-custom-quote carrying `guarantee` — has no acknowledgment, and the
 * honest response to reaching it is to fail. A fallthrough would quietly hand
 * out the 3A guarantee text.
 */
export function selectPathAcknowledgment(
  kind: BeatQuoteSubmissionKind,
  treatment: BeatQuoteTreatment
): BeatQuoteAcknowledgmentCopy {
  if (kind === "custom_quote") {
    return treatment === "guarantee"
      ? {
          id: "recent_quote",
          slug: BEAT_QUOTE_POLICY_SLUGS.recentQuote,
          version: BEAT_QUOTE_POLICY_VERSION,
          text: BEAT_QUOTE_RECENT_QUOTE_TEXT,
          affirmativeActionLabel: BEAT_QUOTE_RECENT_QUOTE_ACTION,
        }
      : {
          id: "older_quote",
          slug: BEAT_QUOTE_POLICY_SLUGS.olderQuote,
          version: BEAT_QUOTE_POLICY_VERSION,
          text: BEAT_QUOTE_OLDER_QUOTE_TEXT,
          affirmativeActionLabel: BEAT_QUOTE_OLDER_QUOTE_ACTION,
        };
  }

  // Amendment §1 and original §4: both are review-only, so a `guarantee`
  // treatment here is an impossible state the database also refuses.
  if (treatment === "guarantee") throw new UnmappedBeatQuotePathError(kind, treatment);

  if (kind === "online_listing") {
    return {
      id: "online_listing",
      slug: BEAT_QUOTE_POLICY_SLUGS.onlineListing,
      version: BEAT_QUOTE_POLICY_VERSION,
      text: BEAT_QUOTE_ONLINE_LISTING_TEXT,
      affirmativeActionLabel: BEAT_QUOTE_ONLINE_LISTING_ACTION,
    };
  }

  return {
    id: "group_buy",
    slug: BEAT_QUOTE_POLICY_SLUGS.groupBuy,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_GROUP_BUY_TEXT,
    affirmativeActionLabel: BEAT_QUOTE_GROUP_BUY_ACTION,
  };
}
