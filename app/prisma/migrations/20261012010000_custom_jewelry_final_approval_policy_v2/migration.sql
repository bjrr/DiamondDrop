-- Custom Jewelry final approval acknowledgment, VERSION 2 (owner decision
-- 2026-10-12).
--
-- ============================================================================
-- VERSION 1 IS NOT TOUCHED, AND THAT IS THE WHOLE MECHANISM
-- ============================================================================
-- `policy_version` is append-only (BEFORE UPDATE/DELETE triggers from
-- migration 20260913000100), so this migration CANNOT edit version 1 even by
-- accident. That is deliberate rather than incidental: an `acknowledgment` row
-- references the version it was shown under, and every Custom Jewelry approval
-- package records `approval_acknowledgment_policy_version`. Editing version 1
-- would retroactively change what existing evidence claims a customer agreed
-- to — on a purchase that is final sale.
--
-- So version 1 remains in the table, remains what existing approvals point at,
-- and remains readable forever. New approvals get version 2 because
-- `getLatestPolicyVersion` returns the highest version for the slug.
--
-- ============================================================================
-- WHAT CHANGED: THE MIDDLE SENTENCE, AND ONLY THAT
-- ============================================================================
-- v1: "I approve the final price shown and the credit of my $49 Design Deposit
--      against it, and I understand I am paying the remaining balance."
--
-- v2: "I approve the final price shown and the $49 Design Deposit credit
--      applied to it, and I understand the amount due is the remaining balance
--      after that credit."
--
-- The owner's wording names the credit as a thing APPLIED TO the price and
-- states what the amount due actually is, which is clearer about what is being
-- collected. The first and third sentences — the approval scope and the
-- final-sale term with its four exceptions — are unchanged.
--
-- The owner also separated the checkbox label from the submit-button caption:
--
--   checkbox        "I Approve & Agree"            (unchanged; this is the
--                                                   AFFIRMATIVE ACTION recorded
--                                                   on the acknowledgment row)
--   submit button   "Approve Design & Continue to Purchase"   (new constant)
--
-- Only the checkbox label is evidence, so only it appears in an acknowledgment
-- row. The button caption is pinned in the copy module so the storefront
-- imports it rather than retyping it.
--
-- ============================================================================
-- text and content_hash are byte-identical to
-- `app/app/domain/customjewelry/finalApprovalCopy.ts`'s
-- CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT, itself pinned
-- character-for-character by `finalApprovalCopy.test.ts` and asserted against
-- this migration by `requiredPolicyVersionsMigrationFence.test.ts`. The hash is
-- plain sha256 of that exact string — NOT canonical-JSON hashed; see
-- `requiredPolicyVersions.ts`'s header for why that distinction matters and
-- what it cost to discover.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'custom-jewelry-final-approval',
  2,
  '2026-01-01T00:00:00.000Z',
  'I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and engraving where applicable, exactly as displayed on this page. I approve the final price shown and the $49 Design Deposit credit applied to it, and I understand the amount due is the remaining balance after that credit. I understand that once my final design and specifications are approved and the jewelry is purchased, my order is final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the approved design and specifications.',
  '6f6796e9c18e69930ca8974283dc72cb57d33123829d12a4f23da3ed7d0a4c5b',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
