-- Slice 4 — the Buy Now RMA return-policy acknowledgment POLICY VERSION.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED — same reasoning as migration
-- 20260924020000_luxury_steals_policy_version and
-- 20260925030000_warranty_claim_policy_version, which this migration
-- mirrors exactly. Reference data the application REQUIRES in order to
-- function is schema, not fixtures: it belongs in a migration, which every
-- environment runs (fly.toml's release_command runs `prisma migrate
-- deploy` only), never in `prisma/seed.ts`, which runs on developer
-- machines and in the disposable integration database and nowhere else.
-- Without this row, the RMA intake route (`apps.carat.rma-intake.tsx`)
-- cannot record the required acknowledgment for ANY request and refuses
-- every submission with `acknowledgment_copy_pending_approval` — exactly
-- the outage class 20260924020000's header comment describes, and exactly
-- the state this route was deliberately left in until this approval landed
-- (see `app/app/domain/rma/acknowledgmentText.ts`'s own header history).
--
-- OWNER-APPROVED 2026-09-26. text and content_hash below are byte-identical
-- to app/app/domain/rma/acknowledgmentText.ts's
-- RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT, itself pinned character-for-
-- character by acknowledgmentText.test.ts and asserted against this
-- migration by requiredPolicyVersionsMigrationFence.test.ts. The hash is
-- plain sha256 of that exact string (not canonical-JSON hashed — see
-- requiredPolicyVersions.ts's header comment for why that distinction
-- matters).
--
-- Idempotent by the (slug, version) unique constraint. policy_version is
-- append-only (BEFORE UPDATE/DELETE triggers from migration
-- 20260913000100), so this is INSERT-only by design: a future wording
-- change creates version 2, it never edits version 1.
INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'rma-return-policy-acknowledgment',
  1,
  '2026-01-01T00:00:00.000Z',
  'I certify that the information I provided is accurate. I understand that submitting an RMA request does not approve a return. I will not send the item until CaratForUs approves the return and provides an RMA number and return instructions. I understand that I am responsible for tracked, appropriately insured return shipping, and that any refund or merchandise credit is subject to the applicable return window, timely receipt, and inspection of the returned item.',
  '8b743c6e3a54a1de41d78f7d9455223893276edc96fb44b031f734f947774aa5',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
