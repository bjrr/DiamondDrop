/**
 * Design Deposit acknowledgment — the pinned customer-facing copy the
 * customer affirmatively accepts BEFORE the $49 is charged.
 *
 * Same discipline as `app/domain/warranty/acknowledgmentText.ts` and
 * `app/domain/luxurysteals/acknowledgmentText.ts`: pinned character for
 * character by `designDepositAcknowledgmentText.test.ts`, so a well-meaning
 * copy edit fails loudly rather than silently changing what the evidence
 * record says the customer agreed to.
 *
 * ============================================================================
 * PROVENANCE OF EVERY SENTENCE — read before editing any of them
 * ============================================================================
 * The owner required four disclosures on this step. Three come from the
 * owner-approved intake disclosure, reproduced verbatim from
 * `intakeCopy.ts`'s `CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE` rather than
 * restated, so the customer cannot be told one thing on the enquiry form and
 * a differently-worded thing here:
 *
 *   1. the $49 amount
 *   2. that it is credited toward the final price
 *   3. that it is refunded if CaratForUs completes the agreed design stage
 *      and the customer decides not to proceed
 *
 * The FOURTH is the abandonment / non-response rule, which the owner
 * deliberately kept OFF the intake form ("Keep the intake welcoming") and
 * required here, conspicuously, before the deposit is charged. It is rendered
 * from the owner's OWN sentence rather than drafted:
 *
 *   "a refund is not automatic if the customer abandons the project or stops
 *    responding before the agreed design stage is completed"
 *
 * recast into first person because this is a certification the customer
 * makes, not a statement made at them — the same grammatical split the
 * warranty copy already draws between `notice_body` ("Do not send your
 * jewelry until…") and `acknowledgment_text` ("I will not send my jewelry
 * until…"). Nothing is added to it: no grace period, no cure window, no
 * definition of "stops responding". Those would be new policy, and inventing
 * policy inside an acknowledgment is how a customer ends up agreeing to a
 * term nobody approved.
 *
 * FLAGGED FOR AN OWNER CONFIRMATION PASS. The substance is the owner's; the
 * first-person rendering is mine. It is pinned and versioned so a revision
 * is a visible diff plus a new policy version, never a silent edit.
 *
 * ============================================================================
 * WHAT THIS MUST NOT ACQUIRE
 * ============================================================================
 * NO RESPONSE-TIME PROMISE. Same prohibition as every other Custom Jewelry
 * surface, and the tests reject the same terms by name.
 *
 * NO IMPLICATION THAT THE DEPOSIT IS UNCONDITIONALLY REFUNDABLE, and no
 * implication that it is never refundable either. Both conditions ship
 * together, in that order, because the refund condition read alone is a
 * promise and the abandonment rule read alone is a threat.
 *
 * Any future approved wording change must add a NEW `policy_version`
 * (version 2) via a NEW migration and bump the version constant below to
 * match — never silently edit this string or the existing migration.
 */

import { CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE } from "./intakeCopy";

/**
 * The owner-approved intake disclosure, re-shown here verbatim.
 *
 * IMPORTED, NOT RESTATED. The customer saw this exact wording on the enquiry
 * form; a second copy of it on the step where money is actually charged is
 * precisely where a drift would do the most damage.
 */
export const CUSTOM_JEWELRY_DEPOSIT_TERMS_TEXT = CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE;

/**
 * The fourth disclosure. Displayed CONSPICUOUSLY — the owner's word — which
 * `designDepositAcknowledgment.test.ts` enforces structurally rather than
 * trusting: it must be rendered as its own emphasised block, never folded
 * into the terms paragraph above and never behind a disclosure toggle.
 */
export const CUSTOM_JEWELRY_DEPOSIT_NON_REFUND_CONDITION_TEXT =
  "A refund is not automatic if you abandon the project or stop responding before the agreed design stage is completed.";

/**
 * What the customer certifies. Carries both conditions, in the order the
 * owner stated them, so neither can be read alone.
 */
export const CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT =
  "I authorize the $49 Design Deposit and understand it is charged when design/CAD work begins and credited toward my final price. " +
  "I understand the deposit is refunded if CaratForUs completes the agreed design stage and I decide not to proceed. " +
  "I understand a refund is not automatic if I abandon the project or stop responding before the agreed design stage is completed.";

/**
 * THIS IS EVIDENCE, NOT DECORATION. It records what the customer actually
 * clicked (`Acknowledgment.affirmativeActionLabel`), so the storefront must
 * IMPORT this constant as the visible button caption rather than retyping the
 * words — if the two drifted, the evidence row would describe a button the
 * customer never saw.
 *
 * "Authorize" rather than warranty's "Certify", because the customer is
 * permitting a charge rather than attesting to facts. The ampersand matches
 * the family (`I Certify & Agree`, `I Understand & Agree`).
 */
export const CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL = "I Authorize & Agree";

/**
 * The `policy_version.slug` this acknowledgment's evidence rows reference.
 * Shared by the provisioning migration and the capture route so both sides
 * name the same policy by construction rather than by coincidence.
 */
export const CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG = "custom-jewelry-design-deposit";

/** The version provisioned alongside the text above. Bump together with the text, as a NEW version, on any approved wording change. */
export const CUSTOM_JEWELRY_DEPOSIT_POLICY_VERSION = 1;

/**
 * The deposit, in integer minor units — never a float, never derived from the
 * copy by parsing "$49".
 *
 * The AMOUNT and the SENTENCE are pinned against each other by a test, so a
 * price change cannot ship without the disclosure changing with it. A
 * disclosure that says $49 beside a charge of something else is the single
 * worst failure this surface can have.
 */
export const CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS = 4900n;
export const CUSTOM_JEWELRY_DEPOSIT_CURRENCY = "USD";
