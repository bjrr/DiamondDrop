/**
 * Warranty Claim acknowledgment — the pinned customer-facing copy
 * (docs/WARRANTY-CLAIMS.md §2/§9, docs/specs/SLICE-5-WARRANTY-CLAIMS.md
 * criterion 154, owner approval 2026-09-25).
 *
 * ALREADY APPROVED — not drafted here. Same discipline as
 * `app/domain/luxurysteals/acknowledgmentText.ts`: every character below is
 * reproduced exactly from the owner's approval, pinned character-for-
 * character by `acknowledgmentText.test.ts` so a well-meaning copy edit
 * fails loudly rather than silently changing what the evidence record says
 * the customer agreed to.
 *
 * ONE ACKNOWLEDGMENT, NOT TWO. `docs/specs/SLICE-5-WARRANTY-COPY-PROPOSAL.md`
 * proposed separate accuracy-certification and coverage-not-established
 * acknowledgments; the owner approved a single merged statement instead,
 * which also covers the shipping undertaking (§4). `WarrantyClaim`'s two FK
 * columns (`accuracyCertificationAcknowledgmentId` /
 * `coverageNotEstablishedAcknowledgmentId`, task 5-1's schema) now both
 * reference the SAME `Acknowledgment` row for a given claim — see
 * `apps.carat.warranty-claim.tsx`'s own comment on why the schema was not
 * changed to match (task 5-1's schema is out of this task's scope, and two
 * FK columns pointing at one row is a correct, if slightly redundant, way
 * to represent "the owner merged these").
 *
 * Do not paraphrase, re-wrap, or "fix" punctuation. Any future counsel/owner
 * -approved wording change must add a NEW `policy_version` (version 2) via a
 * NEW migration, mirroring `20260925030000_warranty_claim_policy_version`,
 * and bump `WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION` here to match —
 * never silently edit this string or the existing migration.
 */

export const WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT =
  "I certify that the information and files I submitted are accurate to the best of my knowledge. " +
  "I understand that submitting this claim does not establish warranty coverage. " +
  "I will not send my jewelry until CaratForUs authorizes an inspection and provides shipping instructions. " +
  "If inspection is authorized, I am responsible for tracked and appropriately insured shipping to CaratForUs. " +
  "Coverage and any remedy will be determined after CaratForUs reviews the claim and, when applicable, inspects the item.";

/**
 * Owner-approved 2026-09-25, matching Final Sale's "I Understand & Agree" —
 * the ampersand is deliberate, not "and", so the two read as a family.
 *
 * THIS IS EVIDENCE, NOT DECORATION. It records what the customer actually
 * clicked (`Acknowledgment.affirmativeActionLabel`), so it must be the SAME
 * constant the storefront form renders as the visible checkbox caption —
 * never a second string that happens to match today. Task 5-5 (storefront
 * form) must IMPORT this constant rather than retyping the words; if the
 * two ever drift, the evidence row would describe a button the customer
 * never actually saw.
 */
export const WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL = "I Certify & Agree";

/**
 * The `policy_version.slug` this acknowledgment's evidence rows reference.
 * Shared by `prisma/migrations/20260925030000_warranty_claim_policy_version`
 * (which provisions v1) and the capture route (which resolves the latest
 * version under it) so both sides name the same policy by construction.
 */
export const WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG = "warranty-claim-acknowledgment";

/** The version provisioned alongside `WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT` above. Bump together with the text (as a NEW version) on any future approved wording change. */
export const WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION = 1;
