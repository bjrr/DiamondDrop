-- Slice 9 — the Custom Jewelry Design Deposit acknowledgment POLICY VERSION.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED — mirroring
-- `20260925030000_warranty_claim_policy_version` and
-- `20260924020000_luxury_steals_policy_version` exactly. Reference data the
-- application REQUIRES in order to function is schema, not fixtures: it
-- belongs in a migration, which every environment runs (fly.toml's
-- release_command runs `prisma migrate deploy` only), never in
-- `prisma/seed.ts`, which runs on developer machines and in the disposable
-- integration database and nowhere else.
--
-- THIS EXACT GAP CAUSED A PRODUCTION OUTAGE ONCE. The Luxury Steals
-- acknowledgment endpoint returned HTTP 500 `policy_unavailable` on its first
-- real production request because its policy_version row existed only in the
-- seed script. Without the row below, the deposit acknowledgment cannot be
-- recorded for ANY customer and the route must refuse — so it is provisioned
-- here, registered in `requiredPolicyVersions.ts`, and therefore surfaced by
-- `/health`'s readiness check the moment a deploy finishes rather than at the
-- first customer request.
--
-- Idempotent by the (slug, version) unique constraint. `policy_version` is
-- append-only (BEFORE UPDATE/DELETE triggers from migration 20260913000100),
-- so this is INSERT-only by design: a future approved wording change creates
-- version 2, it never edits version 1. That is the whole point — an
-- acknowledgment row references the version it was shown under, so editing
-- version 1's text would retroactively change what existing evidence claims
-- the customer agreed to.
--
-- text and content_hash below are byte-identical to
-- `app/app/domain/customjewelry/designDepositAcknowledgmentText.ts`'s
-- CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT, itself pinned character-for-
-- character by `designDepositAcknowledgmentText.test.ts` and asserted against
-- this migration by `requiredPolicyVersionsMigrationFence.test.ts`. The hash
-- is plain sha256 of that exact string — NOT canonical-JSON hashed; see
-- `requiredPolicyVersions.ts`'s header comment for why that distinction
-- matters and what it cost to discover.
INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'custom-jewelry-design-deposit',
  1,
  '2026-01-01T00:00:00.000Z',
  'I authorize the $49 Design Deposit and understand it is charged when design/CAD work begins and credited toward my final price. I understand the deposit is refunded if CaratForUs completes the agreed design stage and I decide not to proceed. I understand a refund is not automatic if I abandon the project or stop responding before the agreed design stage is completed.',
  'aa1640e4fcd47b203eddd5cce1bc38e30cb5f3e1f75b35dba3dd7b1772eec954',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
