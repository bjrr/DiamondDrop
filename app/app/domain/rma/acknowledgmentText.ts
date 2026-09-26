/**
 * Buy Now RMA return-policy acknowledgment — the pinned, OWNER-APPROVED copy
 * (docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md §9/§10, docs/specs/
 * SLICE-4-BUY-NOW-RMA.md criterion 180, owner approval 2026-09-26).
 *
 * APPROVED, NOT DRAFTED HERE. Same discipline as
 * `app/domain/warranty/acknowledgmentText.ts` and
 * `app/domain/luxurysteals/acknowledgmentText.ts`: every character below is
 * reproduced exactly from the owner's own approval — the owner wrote this
 * text themselves, it is not this codebase's proposal — pinned
 * character-for-character by `acknowledgmentText.test.ts` so a well-meaning
 * copy edit fails loudly rather than silently changing what the evidence
 * record says the customer agreed to. Do not paraphrase, re-wrap, or "fix"
 * punctuation. Any future approved wording change must add a NEW
 * `policy_version` (version 2) via a NEW migration, mirroring
 * `20260926040000_rma_return_policy_acknowledgment_version` (below), and
 * bump `RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION` here to match —
 * never silently edit this string or an already-applied migration.
 *
 * WHAT THIS TEXT DELIBERATELY DOES NOT RESTATE, AND WHY THAT IS NOT A
 * POLICY CONFLICT. The owner's approved copy does not repeat item-condition
 * requirements, the personalization/alteration restriction, or the
 * non-refund of separately purchased outbound expedited shipping.
 * `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` §10 requires those be
 * CONSPICUOUSLY DISCLOSED on the return-policy page/form, not that they live
 * inside the checkbox text itself — the intake form (a later
 * frontend/storefront task) must display them near this acknowledgment,
 * never silently fold them into the pinned string below.
 *
 * PREVIOUSLY, THIS FILE PINNED ONLY A SLUG (no approved copy existed). That
 * gap is closed as of the owner's 2026-09-26 approval — see git history for
 * the prior fail-closed-only version if useful context.
 */

export const RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT =
  "I certify that the information I provided is accurate. I understand that submitting an RMA request does not approve a return. " +
  "I will not send the item until CaratForUs approves the return and provides an RMA number and return instructions. " +
  "I understand that I am responsible for tracked, appropriately insured return shipping, and that any refund or merchandise credit is subject to the applicable return window, timely receipt, and inspection of the returned item.";

/**
 * Owner-approved 2026-09-26 — deliberately the SAME label as the warranty
 * claim acknowledgment (`WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL`);
 * the owner chose consistency across both forms rather than a distinct label
 * per workflow.
 *
 * THIS IS EVIDENCE, NOT DECORATION — see
 * `~/domain/warranty/acknowledgmentText.ts`'s own comment on this exact
 * point. The (later) storefront RMA intake form must render this SAME
 * constant as the visible checkbox caption, never a second string that
 * happens to match today.
 */
export const RMA_RETURN_POLICY_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL = "I Certify & Agree";

/**
 * The `policy_version.slug` this acknowledgment's evidence rows reference.
 * Shared by `prisma/migrations/20260926040000_rma_return_policy_acknowledgment_version`
 * (which provisions v1) and the intake route (which resolves the latest
 * version under it) so both sides name the same policy by construction.
 */
export const RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG = "rma-return-policy-acknowledgment";

/** The version provisioned alongside `RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT` above. Bump together with the text (as a NEW version) on any future approved wording change. */
export const RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION = 1;
