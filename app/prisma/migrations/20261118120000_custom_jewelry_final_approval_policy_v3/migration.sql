-- Custom Jewelry final approval acknowledgment, VERSION 3 (owner decision
-- 2026-11-18).
--
-- ============================================================================
-- VERSIONS 1 AND 2 ARE NOT TOUCHED, AND THAT IS THE WHOLE MECHANISM
-- ============================================================================
-- `policy_version` is append-only (BEFORE UPDATE/DELETE triggers from
-- migration 20260913000100), so this migration CANNOT edit an earlier version
-- even by accident. That is deliberate rather than incidental: an
-- `acknowledgment` row references the version it was shown under, and every
-- Custom Jewelry approval package records
-- `approval_acknowledgment_policy_version`. Editing v1 or v2 would
-- retroactively change what existing evidence claims a customer agreed to — on
-- a purchase that is final sale.
--
-- So v1 and v2 remain in the table, remain what existing approvals point at,
-- and remain readable forever. New approvals get v3 because
-- `getLatestPolicyVersion` returns the highest version for the slug. The
-- owner's instruction to "preserve all existing final-design approval
-- evidence/versioning" is satisfied by adding a version, not by rewording one.
--
-- ============================================================================
-- WHAT CHANGED: ONE SENTENCE ADDED. NOTHING ALTERED, NOTHING REMOVED.
-- ============================================================================
-- Added as the third sentence:
--
--   "I understand the approved price is the price of the jewelry itself, and
--    that shipping is calculated separately under the CaratForUs Shipping
--    Policy and shown to me before I pay."
--
-- The owner's decision of 2026-11-18 makes CaratForUs shipping rules apply
-- consistently across Buy Now, Group Buy, Custom Jewelry and Let Us Beat Your
-- Quote, on both Card and Bank Payment. The approved custom-jewelry price is a
-- MERCHANDISE price; shipping is a separate fulfilment charge or benefit under
-- `docs/SHIPPING-AND-DELIVERY.md`.
--
-- It is certified rather than merely displayed because the instruction was
-- that the customer must understand this BEFORE final design approval, and
-- must not be surprised by a shipping charge afterwards. A sentence shown near
-- the checkbox but absent from the certified text would leave no evidence that
-- they were told.
--
-- STRICTLY ADDITIVE, which is what keeps this from weakening the
-- acknowledgment. All three of v2's sentences survive verbatim and in order:
-- the approval scope, the price-and-deposit-credit clause, and the final-sale
-- term with its four exceptions. No waiver, no limitation of liability and no
-- acceptance of delay was introduced alongside it.
--
-- The companion display copy changed in the same commit:
-- CUSTOM_JEWELRY_SHIPPING_TEXT said "Standard shipping and insurance are
-- included in the price shown.", which this decision makes false. It now
-- states that the piece ships insured, tracked and signature-required, and
-- that shipping is calculated separately from the approved jewelry price. That
-- string is display copy rather than evidence, so it carries no version of its
-- own.
--
-- ============================================================================
-- text and content_hash are byte-identical to
-- `app/app/domain/customjewelry/finalApprovalCopy.ts`'s
-- CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT, itself pinned
-- character-for-character by `finalApprovalCopy.test.ts` and asserted against
-- this migration by `requiredPolicyVersionsMigrationFence.test.ts`. The hash is
-- plain sha256 of that exact string — NOT canonical-JSON hashed; see
-- `requiredPolicyVersions.ts`'s header for why that distinction matters and
-- what it cost to discover. It was computed FROM the module's own declaration
-- rather than from a retyped copy, because a retyped copy is exactly how the
-- two drift.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'custom-jewelry-final-approval',
  3,
  '2026-01-01T00:00:00.000Z',
  'I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and engraving where applicable, exactly as displayed on this page. I approve the final price shown and the $49 Design Deposit credit applied to it, and I understand the amount due is the remaining balance after that credit. I understand the approved price is the price of the jewelry itself, and that shipping is calculated separately under the CaratForUs Shipping Policy and shown to me before I pay. I understand that once my final design and specifications are approved and the jewelry is purchased, my order is final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the approved design and specifications.',
  '57462d455b53aa583cffc755891ba04025dd8a701f3132c40a848e5f8c7ed15e',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
