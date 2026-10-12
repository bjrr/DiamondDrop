/**
 * DEMAND CAPTURE — "Bring It Back" and "Request a New Group Buy".
 *
 * ============================================================================
 * OWNER-APPROVED 2026-10-12
 * ============================================================================
 * `docs/specs/SLICE-13-DEMAND-CAPTURE-COPY-PROPOSAL.md` carries the full
 * drafts and the reasoning; this file carries what the code needs. It
 * resolves `STOREFRONT-COPY-PROPOSAL.md` §1.7, which deferred the wording to
 * this slice and deliberately drafted none.
 *
 * THE SUBMIT BUTTON IS THE AFFIRMATIVE ACTION — owner decision, not a
 * simplification. There is no consent tickbox: the disclosure is shown above
 * the form and pressing the button is the act. README requires low-friction
 * interest capture, and a tickbox is a step. The evidence is unaffected: the
 * acknowledgment still records the exact disclosure shown AND the exact
 * caption pressed, so a row can never describe words the customer never saw.
 *
 * WHICH IS WHY THE LABELS LIVE HERE AND THE DISCLOSURES DO NOT. A
 * `policy_version` row has no column for a button caption, so the captions
 * have to be constants. The disclosure TEXT is a versioned row provisioned by
 * migration (`20261012030000_group_buy_demand_capture_copy`), so revising it
 * later is a new version with its own acknowledgments rather than a deploy
 * that silently restates what earlier customers were told.
 *
 * ============================================================================
 * WHAT THIS COPY REFUSES TO SAY
 * ============================================================================
 * That a campaign will return, when, or at what price. A past campaign's
 * price was frozen against costs that have since moved, and the public Past
 * Group Buys archive now states that old price plainly — so "it'll come back
 * at that price" is the misunderstanding most likely to arise here, and §1.1
 * of the proposal is written specifically to head it off.
 *
 * "Once" is a promise the system can actually keep: a notified signal is
 * marked and never re-selected (`markGroupBuyDemandSignalsNotified` only ever
 * sets the flag).
 */

/** "Notify me if it returns", captured against a specific past campaign. */
export const BRING_IT_BACK_POLICY_SLUG = "group-buy-bring-it-back-notification";
export const BRING_IT_BACK_POLICY_VERSION = 1;

/** "Request a new Group Buy" — a wish, naming no existing campaign. */
export const NEW_CAMPAIGN_REQUEST_POLICY_SLUG = "group-buy-new-campaign-request";
export const NEW_CAMPAIGN_REQUEST_POLICY_VERSION = 1;

/**
 * THE DISCLOSURES, owner-approved 2026-10-12.
 *
 * Duplicated here and in the migration that provisions them, on purpose: the
 * migration is what a customer's acknowledgment points at, and these are what
 * `requiredPolicyVersions.ts` checks are actually present. A drift between
 * them is caught by `/health` at deploy time rather than by a customer.
 */
export const BRING_IT_BACK_DISCLOSURE_TEXT =
  "We'll email you once if this Group Buy runs again. We can't promise it will, or what the price " +
  "will be — a new campaign is priced from costs at the time it opens. We use your email for this " +
  "notice only, and you can ask us to remove it at any time.";

export const NEW_CAMPAIGN_REQUEST_DISCLOSURE_TEXT =
  "Tell us what you'd like to see run as a Group Buy. We read every request, but we can't promise to " +
  "run any particular one, and we'll only email you about this request. If you want a one-off piece " +
  "made for you, start a Custom Jewelry request instead — that's a different process.";

/**
 * The caption on the button the customer presses. Recorded as the
 * acknowledgment's `affirmativeActionLabel`, so the evidence row names the
 * control they actually used.
 *
 * ONE PER KIND, because the two forms ask for different things and a shared
 * caption would have to be vague enough to cover both — which is exactly the
 * wording a customer later says they did not understand.
 */
export const BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL = "Email me if this runs again";
export const NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL = "Send my request";

/**
 * Shown after EITHER submission, and deliberately the same for a new
 * submission and a repeat — see the intake route. A confirmation that said
 * "you're already on the list" would let anyone check whether a given address
 * is watching a given campaign.
 */
export const DEMAND_CAPTURE_CONFIRMATION_TEXT = "Thanks — we've got it.";

/** The longest note the form accepts, in characters. */
export const DEMAND_CAPTURE_NOTE_MAX_LENGTH = 500;
