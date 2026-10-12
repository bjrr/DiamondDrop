/**
 * DEMAND CAPTURE — "Bring It Back" and "Request a New Group Buy".
 *
 * ============================================================================
 * THE CUSTOMER-FACING COPY IS NOT APPROVED YET, AND IS NOT INVENTED HERE
 * ============================================================================
 * `docs/specs/STOREFRONT-COPY-PROPOSAL.md` §1.7 records the owner's position
 * verbatim: "In locked MVP1 scope, but it belongs to Slice 13 and must not
 * block Slice 6. No copy drafted, and deliberately no route, model or UI built
 * early merely because copy was requested."
 *
 * So the slugs below are identifiers, which are ours to choose. The TEXT a
 * customer reads is not. Two things remain owner decisions:
 *
 *   1. the disclosure text itself, which lives in a `policy_version` row
 *      provisioned by migration — never in this file, so a copy change is a
 *      versioned data change with an acknowledgment trail rather than a
 *      deploy;
 *   2. the affirmative-action label, which cannot live in a `policy_version`
 *      row (there is no column for it) and therefore has to be here.
 *
 * `AFFIRMATIVE_ACTION_LABEL` is `null` until (2) is decided. The intake route
 * treats null as "copy pending" and fails closed with 503 — the same guard
 * `apps.carat.custom-jewelry-approval` uses, and for the same reason: a page
 * that invites someone to accept something we cannot record is a page that
 * loses their acceptance.
 *
 * WHY BUILD THE BACKEND BEFORE THE WORDS EXIST. Everything below the words is
 * decision-independent: the shape of the two kinds, the deduplication, the
 * normalisation, the evidence trail. Waiting on a sentence to write a UNIQUE
 * index would be waiting for no reason. The route simply refuses to run until
 * the sentence arrives.
 */

/** "Notify me if it returns", captured against a specific past campaign. */
export const BRING_IT_BACK_POLICY_SLUG = "group-buy-bring-it-back-notification";

/** "Request a new Group Buy" — a wish, naming no existing campaign. */
export const NEW_CAMPAIGN_REQUEST_POLICY_SLUG = "group-buy-new-campaign-request";

/**
 * The label on the control the customer actually ticks or presses, recorded as
 * part of the acknowledgment so the evidence row cannot describe words they
 * never saw.
 *
 * NULL = PENDING OWNER APPROVAL. See this file's header. Do not fill this in
 * with a plausible-sounding string; the whole point of the null is that nobody
 * guessed.
 */
export const DEMAND_CAPTURE_AFFIRMATIVE_ACTION_LABEL: string | null = null;

/** The longest note the form accepts, in characters. */
export const DEMAND_CAPTURE_NOTE_MAX_LENGTH = 500;
