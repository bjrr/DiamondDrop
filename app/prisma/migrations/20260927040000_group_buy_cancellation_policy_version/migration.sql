-- Group Buy cancellation acknowledgment POLICY VERSION.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED — same reasoning as migrations
-- 20260924020000_luxury_steals_policy_version,
-- 20260925030000_warranty_claim_policy_version, and
-- 20260926040000_rma_return_policy_acknowledgment_version, which this
-- migration mirrors exactly. Reference data the application REQUIRES in
-- order to function is schema, not fixtures: it belongs in a migration,
-- which every environment runs (fly.toml's release_command runs
-- `prisma migrate deploy` only), never in `prisma/seed.ts`, which runs on
-- developer machines and in the disposable integration database and
-- nowhere else. Without this row, neither the Bank Payment checkout route
-- nor the native-checkout capture route can record the required Group Buy
-- cancellation acknowledgment for ANY request — exactly the outage class
-- 20260924020000's header comment describes.
--
-- OWNER-APPROVED 2026-09-27. text and content_hash below are byte-identical
-- to app/app/domain/groupbuy/cancellationAcknowledgmentText.ts's
-- GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT (the required CHECKBOX
-- statement, not the longer surrounding disclosure paragraph — see that
-- file's header comment for why the two are deliberately separate),
-- itself pinned character-for-character by cancellationAcknowledgmentText.test.ts
-- and asserted against this migration by
-- requiredPolicyVersionsMigrationFence.test.ts. The hash is plain sha256 of
-- that exact string (not canonical-JSON hashed — see requiredPolicyVersions.ts's
-- header comment for why that distinction matters).
--
-- Idempotent by the (slug, version) unique constraint. policy_version is
-- append-only (BEFORE UPDATE/DELETE triggers from migration
-- 20260913000100), so this is INSERT-only by design: a future wording
-- change creates version 2, it never edits version 1.
INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'group-buy-cancellation-acknowledgment',
  1,
  '2026-01-01T00:00:00.000Z',
  'I understand that cancellation requests before the campaign closes require CaratForUs approval, and that once the campaign closes my Group Buy order is committed and is not eligible for discretionary cancellation or return.',
  '93bd4934e456ced66019c27f653462e20121dfe6e540de4ce47439a2cb6edd48',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
