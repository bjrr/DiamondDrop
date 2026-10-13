-- Slice 5 — the Warranty Claim acknowledgment POLICY VERSION.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED — same reasoning as migration
-- 20260924020000_luxury_steals_policy_version, which this migration mirrors
-- exactly. Reference data the application REQUIRES in order to function is
-- schema, not fixtures: it belongs in a migration, which every environment
-- runs (fly.toml's release_command runs `prisma migrate deploy` only), never
-- in `prisma/seed.ts`, which runs on developer machines and in the
-- disposable integration database and nowhere else. Without this row, the
-- warranty claim intake route (`apps.carat.warranty-claim.tsx`) cannot
-- record the required acknowledgment for ANY claim and refuses every
-- submission with `acknowledgment_copy_pending_approval` — exactly the
-- outage class 20260924020000's header comment describes.
--
-- ONE ACKNOWLEDGMENT, NOT TWO. An earlier draft
-- (docs/specs/SLICE-5-WARRANTY-COPY-PROPOSAL.md) proposed separate accuracy-
-- certification and coverage-not-established acknowledgments; the owner
-- approved a single merged statement instead that also covers the shipping
-- undertaking. `warranty_claim.accuracy_certification_acknowledgment_id` and
-- `coverage_not_established_acknowledgment_id` (task 5-1's schema) now both
-- reference the SAME acknowledgment row for a given claim — see
-- `apps.carat.warranty-claim.tsx`'s own comment on this.
--
-- Idempotent by the (slug, version) unique constraint. policy_version is
-- append-only (BEFORE UPDATE/DELETE triggers from migration 20260913000100),
-- so this is INSERT-only by design: a future wording change creates version
-- 2, it never edits version 1.
--
-- text and content_hash below are byte-identical to
-- app/app/domain/warranty/acknowledgmentText.ts's
-- WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT, itself pinned character-for-character
-- by acknowledgmentText.test.ts and asserted against this migration by
-- requiredPolicyVersionsMigrationFence.test.ts. The hash is plain sha256 of
-- that exact string (not canonical-JSON hashed — see
-- requiredPolicyVersions.ts's header comment for why that distinction
-- matters).
INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'warranty-claim-acknowledgment',
  1,
  '2026-01-01T00:00:00.000Z',
  'I certify that the information and files I submitted are accurate to the best of my knowledge. I understand that submitting this claim does not establish warranty coverage. I will not send my jewelry until CaratForUs authorizes an inspection and provides shipping instructions. If inspection is authorized, I am responsible for tracked and appropriately insured shipping to CaratForUs. Coverage and any remedy will be determined after CaratForUs reviews the claim and, when applicable, inspects the item.',
  'bf974433110a47bb857631728ea2182ee3e1482b9d7452b66245f46067446cb9',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
