-- Slice 3 — the Luxury Steals Final Sale acknowledgment POLICY VERSION.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED.
-- This row was created by prisma/seed.ts, which runs on developer machines and
-- in the disposable integration database, and NOWHERE ELSE. fly.toml's
-- release_command runs `prisma migrate deploy` only. The result was found by
-- the slice 3 live gate, not by any test: the deployed acknowledgment endpoint
-- returned HTTP 500 `policy_unavailable` on the first real request, because
-- production had only `sample-policy v1`. Every unit and integration test
-- passed, because every one of them runs against a seeded database.
--
-- The consequence was total rather than partial. An acknowledgment cannot be
-- recorded without a policy version to anchor it, so NO customer could have
-- completed a Luxury Steal purchase through the gate — the storefront would
-- have failed at the last step, on every attempt.
--
-- The general rule this encodes: reference data the application REQUIRES in
-- order to function is schema, not fixtures. It belongs in a migration, which
-- every environment runs, rather than in a seed script, which only some do.
-- Demo products and sample costs stay in the seed where they belong.
--
-- Idempotent by the (slug, version) unique constraint, so re-running against
-- an environment that already has the row is a no-op rather than an error.
-- policy_version is append-only (BEFORE UPDATE/DELETE triggers from migration
-- 20260913000100), so this is INSERT-only by design: a wording change under
-- D11 creates version 2, it never edits version 1.
--
-- text and content_hash below are byte-identical to
-- app/app/domain/luxurysteals/acknowledgmentText.ts's
-- LUXURY_STEALS_ACKNOWLEDGMENT_TEXT, which is itself pinned
-- character-for-character against docs/LUXURY-STEALS.md by
-- acknowledgmentText.test.ts. The hash is sha256 of that exact string.
INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'luxury-steals-final-sale-acknowledgment',
  1,
  '2026-01-01T00:00:00.000Z',
  E'FINAL SALE ACKNOWLEDGMENT\n\nI understand that this item is a Luxury Steal and is FINAL SALE. I understand that it cannot be returned or exchanged because I change my mind, prefer another style, select the wrong size or configuration, or otherwise no longer want the item. I have reviewed the item specifications and selected options before purchasing.',
  '5c313b74fa92eee74aa8c7d415e97b6d288d447ceab5a66717e925d6e10ec109',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
