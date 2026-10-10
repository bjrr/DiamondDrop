/**
 * "Let Us Beat Your Quote!" — guarantee eligibility and the 10%-off fallback.
 *
 * Authoritative sources, in precedence order:
 *   1. `docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md`  (owner-locked 2026-09-13)
 *   2. `docs/LET-US-BEAT-YOUR-QUOTE.md`            (owner-locked)
 *
 * THE AMENDMENT CONTROLS, AND IT CHANGES THE HEADLINE RULE. The original
 * specification's §2 is titled "Active Online Listed Item — Guarantee Eligible
 * When Qualified" and promises match-or-beat plus the fallback for a live
 * listing. Amendment §1 supersedes that in full: an active online listing is
 * review-only, carries no guaranteed outcome, and does NOT qualify for the
 * fallback. Amendment §5 says so explicitly. Anyone reading only the original
 * document will implement the wrong rule, which is why this module names the
 * conflict rather than quietly resolving it.
 *
 * So exactly ONE path carries the guarantee:
 *
 *   recent custom quote      <= 7 calendar days   GUARANTEE (match/beat, else fallback)
 *   older custom quote       >  7 calendar days   review only
 *   active online listing    any age              review only  <- amendment §1
 *   competing Group Buy      any age              review only
 *
 * ============================================================================
 * THIS MODULE DOES NOT DECIDE WHETHER CARATFORUS MATCHES A PRICE
 * ============================================================================
 * The specification's Implementation Principle is explicit: "MVP1 review is
 * manual. Do not build an automated engine that commits CaratForUs to matching
 * or beating a competitor based solely on uploaded documents or scraped
 * prices."
 *
 * What this computes is narrower and purely mechanical: whether a submission is
 * *capable* of carrying the guarantee, which is a precondition a human reviewer
 * then works within. `guaranteeEligible` means "if staff verify this and cannot
 * beat the price, a fallback is owed" — never "we will beat this price".
 *
 * ============================================================================
 * VERIFICATION IS A SEPARATE GATE AND IS NOT INFERRED HERE
 * ============================================================================
 * Age alone never confers the guarantee. The specification requires a verified,
 * identifiable seller, a verifiable price and date, sufficient specifications
 * for a like-for-like comparison, and authenticity — and lists what is excluded
 * outright (fabricated, altered, AI-generated, screenshot-only, auction,
 * private-party, wholesale-only, obvious pricing errors, expired offers
 * represented as current). None of that is derivable from submitted data, so
 * this module takes the reviewer's verification outcome as an INPUT and refuses
 * the guarantee whenever it is anything but `verified`.
 */

/** What the customer says they are submitting. The three choices the entry flow offers. */
export type BeatQuoteSubmissionKind = "custom_quote" | "online_listing" | "competing_group_buy";

/**
 * The reviewer's verification outcome. `pending` is the initial state and is
 * deliberately NOT eligible: a submission that has not been verified cannot
 * carry a guarantee, and treating "not yet checked" as "fine" is how an
 * unverifiable quote earns a benefit.
 */
export type BeatQuoteVerificationOutcome = "pending" | "verified" | "rejected";

/** Which treatment a submission receives. Derived, never chosen by the customer. */
export type BeatQuoteTreatment = "guarantee" | "review_only";

export interface ClassifyBeatQuoteInput {
  readonly kind: BeatQuoteSubmissionKind;
  /**
   * The quote's own issue date as a calendar date, `YYYY-MM-DD`. Required for
   * `custom_quote`; meaningless for the other two kinds, which have no age
   * rule at all (amendment §1: "There is no 7-day age rule for an active
   * online listing because the listing is review-only").
   */
  readonly quoteIssuedOn?: string;
  /** The submission's own calendar date, `YYYY-MM-DD`. */
  readonly submittedOn: string;
  readonly verification: BeatQuoteVerificationOutcome;
}

export interface BeatQuoteClassification {
  readonly treatment: BeatQuoteTreatment;
  /** True only when a fallback would be owed if CaratForUs cannot match or beat. */
  readonly guaranteeEligible: boolean;
  /** Calendar-day age of the quote, or null when the kind has no age rule. */
  readonly quoteAgeInCalendarDays: number | null;
  /**
   * Why, in terms a reviewer and a customer-facing message can both be built
   * from. A stable machine value, not prose — the approved wording for each
   * path lives in the acknowledgment copy, not here.
   */
  readonly reason:
    | "recent_verified_custom_quote"
    | "custom_quote_older_than_window"
    | "custom_quote_not_verified"
    | "online_listing_review_only"
    | "competing_group_buy_review_only";
}

/**
 * The guarantee window. Amendment §2: "issued within the 7 calendar days
 * immediately preceding submission".
 */
export const BEAT_QUOTE_GUARANTEE_WINDOW_CALENDAR_DAYS = 7;

/** Raised when a date is not a plain `YYYY-MM-DD` calendar date. */
export class InvalidBeatQuoteDateError extends Error {
  constructor(field: string, value: string) {
    super(`${field} must be a YYYY-MM-DD calendar date; got ${JSON.stringify(value)}`);
    this.name = "InvalidBeatQuoteDateError";
  }
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar days between two dates, exactly.
 *
 * ============================================================================
 * WHY THIS TAKES DATE STRINGS AND NOT TIMESTAMPS
 * ============================================================================
 * The rule is stated in CALENDAR days, and calendar days are a property of a
 * place, not of an instant. A quote dated the 1st submitted late on the 8th is
 * 7 calendar days old in the customer's locale and could be 8 in UTC — and that
 * single day is the whole difference between a guaranteed match-or-beat plus a
 * $100 benefit and a discretionary review.
 *
 * Taking `YYYY-MM-DD` on both sides removes the ambiguity from this function
 * entirely: the caller decides, once and visibly, which calendar it is reading,
 * and the boundary becomes exactly testable. Accepting `Date` objects here
 * would push a timezone decision into every call site and make the Day 7 / Day
 * 8 boundary depend on the server's offset.
 *
 * Parsed as UTC midnight on both sides so the subtraction is pure arithmetic on
 * two points the same distance into their days — there is no DST in a date.
 */
/**
 * Milliseconds at UTC midnight on a calendar date, refusing anything that is
 * not that exact date.
 *
 * THE ROUND-TRIP CHECK IS NOT BELT-AND-BRACES. `Date.parse("2026-02-30T...")`
 * does NOT return NaN — V8 rolls the overflow forward and yields March 2. A
 * pattern match plus a NaN guard therefore accepts `2026-02-30` and silently
 * shifts the computed age by two days, which on this feature is the difference
 * between a guaranteed match-or-beat plus a $100 benefit and a discretionary
 * review. Formatting the parsed instant back and comparing is what actually
 * rejects it. Found by the test for it, not by reading the spec for `parse`.
 */
function utcMidnight(field: string, value: string): number {
  if (!CALENDAR_DATE.test(value)) throw new InvalidBeatQuoteDateError(field, value);
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new InvalidBeatQuoteDateError(field, value);
  if (new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new InvalidBeatQuoteDateError(field, value);
  }
  return ms;
}

export function calendarDaysBetween(fromDate: string, toDate: string): number {
  const from = utcMidnight("fromDate", fromDate);
  const to = utcMidnight("toDate", toDate);

  const MS_PER_DAY = 86_400_000;
  // Exact: both operands are UTC midnight, so the difference is always a whole
  // number of days. No rounding helper is involved, which also keeps this clear
  // of the repo-wide ban on them.
  return (to - from) / MS_PER_DAY;
}

/**
 * Which treatment a submission receives.
 *
 * PURE. No database, no clock — the submission date is an input precisely so
 * that "was this inside the window?" is answerable identically at intake, at
 * review, and in a dispute six months later.
 */
export function classifyBeatQuoteSubmission(input: ClassifyBeatQuoteInput): BeatQuoteClassification {
  // Amendment §1 and the original §4: both of these are review-only whatever
  // their age or verification state, so neither age nor verification is even
  // consulted. Returning early makes that structural rather than incidental.
  if (input.kind === "online_listing") {
    return {
      treatment: "review_only",
      guaranteeEligible: false,
      quoteAgeInCalendarDays: null,
      reason: "online_listing_review_only",
    };
  }
  if (input.kind === "competing_group_buy") {
    return {
      treatment: "review_only",
      guaranteeEligible: false,
      quoteAgeInCalendarDays: null,
      reason: "competing_group_buy_review_only",
    };
  }

  if (input.quoteIssuedOn === undefined) {
    throw new InvalidBeatQuoteDateError("quoteIssuedOn", "(absent)");
  }
  const age = calendarDaysBetween(input.quoteIssuedOn, input.submittedOn);

  // A quote dated AFTER the submission is not a 'fresh' quote, it is incoherent
  // evidence. Treated as outside the window rather than as a negative age that
  // would sail through a `<= 7` comparison — the specification's exclusion list
  // covers "obvious pricing errors" and fabricated evidence in the same spirit,
  // and a reviewer should see this rather than a guarantee.
  if (age < 0) {
    return {
      treatment: "review_only",
      guaranteeEligible: false,
      quoteAgeInCalendarDays: age,
      reason: "custom_quote_older_than_window",
    };
  }

  if (age > BEAT_QUOTE_GUARANTEE_WINDOW_CALENDAR_DAYS) {
    // Original §3: accepted for review, may be voluntarily beaten, no fallback.
    return {
      treatment: "review_only",
      guaranteeEligible: false,
      quoteAgeInCalendarDays: age,
      reason: "custom_quote_older_than_window",
    };
  }

  // Inside the window — but the guarantee still turns on verification, which
  // this module never infers. `pending` is not `verified`.
  if (input.verification !== "verified") {
    return {
      treatment: "review_only",
      guaranteeEligible: false,
      quoteAgeInCalendarDays: age,
      reason: "custom_quote_not_verified",
    };
  }

  return {
    treatment: "guarantee",
    guaranteeEligible: true,
    quoteAgeInCalendarDays: age,
    reason: "recent_verified_custom_quote",
  };
}
