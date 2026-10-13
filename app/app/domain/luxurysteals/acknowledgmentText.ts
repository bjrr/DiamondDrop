/**
 * Luxury Steals Final Sale acknowledgment — the pinned customer-facing copy
 * (docs/LUXURY-STEALS.md "Required Customer Disclosure and Acknowledgment";
 * docs/specs/SLICE-3-LUXURY-STEALS.md §13.2, task 3-3, criterion 134).
 *
 * ALREADY APPROVED IN POLICY — not drafted here. Same discipline as
 * `app/domain/bankpayment/guaranteeCancellationEmail.ts`: every character
 * below is reproduced exactly from the locked policy document, pinned
 * character-for-character by `acknowledgmentText.test.ts` so a well-meaning
 * copy edit fails loudly rather than silently changing what the evidence
 * record says the customer agreed to.
 *
 * Do not paraphrase, re-wrap, or "fix" the punctuation — see D11
 * (spec §3): any counsel-approved wording change must create or update this
 * pinned copy AND bump `LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION`, never
 * silently edit this string. An acknowledgment already captured records the
 * text and version the customer actually saw, and that record is immutable
 * by design (the `Acknowledgment` table's append-only trigger).
 *
 * MARKDOWN STRIPPED, WORDING NOT. The source document renders "FINAL SALE"
 * in bold (`**FINAL SALE**`) as markdown emphasis, not as literal asterisk
 * characters a customer would read — this constant carries the words only,
 * the way `guaranteeCancellationEmail.ts` renders its own owner-approved
 * copy as plain email text rather than markdown source.
 */

export const LUXURY_STEALS_ACKNOWLEDGMENT_TEXT =
  "FINAL SALE ACKNOWLEDGMENT\n\n" +
  "I understand that this item is a Luxury Steal and is FINAL SALE. I understand that it cannot be returned or exchanged because I change my mind, prefer another style, select the wrong size or configuration, or otherwise no longer want the item. I have reviewed the item specifications and selected options before purchasing.";

/** Recommended affirmative action, docs/LUXURY-STEALS.md and spec §13.2 — the exact label the customer clicks. */
export const LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL = "I Understand & Agree";

/**
 * The `policy_version.slug` this acknowledgment's evidence rows reference.
 * Shared by `prisma/seed.ts` (which seeds v1 under this slug) and the
 * capture route (which resolves the latest version under it) so both sides
 * name the same policy by construction rather than by convention.
 */
export const LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG = "luxury-steals-final-sale-acknowledgment";

/**
 * The version seeded alongside `LUXURY_STEALS_ACKNOWLEDGMENT_TEXT` above.
 * Bump together with the text (as a NEW version — policy_version is
 * append-only) if the owner/counsel ever approves a wording change (D11).
 */
export const LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION = 1;
