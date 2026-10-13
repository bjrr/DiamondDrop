-- Upload destination generalization, CONTRACT STEP A of two.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY THIS IS TWO MIGRATIONS AND TWO DEPLOYS
-- ============================================================================
-- Fly runs `prisma migrate deploy` as a RELEASE COMMAND, which completes
-- BEFORE any machine running the new code starts. For the length of that
-- window the OLD code is still serving traffic against the NEW schema. So a
-- single migration that dropped `claim_id` would leave the currently-deployed
-- writer inserting a column that no longer exists — every upload-destination
-- request failing until the rollout finished.
--
-- The code deployed alongside THIS migration stops writing `claim_id`. The
-- code deployed BEFORE it still writes it, which is why this step only
-- relaxes the column to nullable. Step B drops it, in a later deploy, once
-- nothing running references it at all.
--
--   expand  (20261005040000)  add purpose + owner_id, nullable, backfilled
--   step A  (this)            claim_id nullable; purpose/owner_id NOT NULL
--   step B  (next deploy)     DROP COLUMN claim_id
--
-- ============================================================================
-- THE NOT NULL CONSTRAINTS ARE THE POINT OF THIS STEP
-- ============================================================================
-- `purpose` is the security boundary between upload kinds: it is part of the
-- consumption WHERE clause, so a destination issued for a warranty claim
-- finds no row when offered to Custom Jewelry. A NULL purpose would match
-- nothing and therefore fail closed — but it would also mean a row existed
-- that no caller could ever consume, i.e. a silently dead destination. The
-- constraint makes that unrepresentable rather than merely harmless.
--
-- Both are proven safe to constrain right now: the expand migration backfilled
-- every existing row and verified the backfill, and the writer deployed since
-- then has set both on every insert. The check below re-proves it against
-- THIS database rather than trusting that history.
--
-- ============================================================================
-- THE TABLE IS DELIBERATELY *NOT* RENAMED
-- ============================================================================
-- `upload_destination` would be a truer name now that the table serves two
-- purposes. It is not worth what the rename costs: during the release-command
-- window the old code would query a table that no longer exists, so every
-- upload request would fail until the rollout completed. That is a real
-- customer-visible window traded for a name only developers read. It could be
-- done behind a compatibility VIEW, but that is a third migration and a fourth
-- to remove the view, for the same cosmetic gain.
--
-- What the misleading name actually risks is a future reader assuming the
-- table is warranty-only and adding a second one. A table COMMENT costs
-- nothing and addresses exactly that, so it is set below.

-- ---------------------------------------------------------------------------
-- Re-prove the backfill against THIS database before constraining anything.
-- A NOT NULL that fails here fails the whole release command, which keeps the
-- previous version serving — the correct outcome, but a bare constraint error
-- names a column and nothing else. This names the problem.
-- ---------------------------------------------------------------------------
DO $$
DECLARE unbackfilled bigint;
BEGIN
    SELECT count(*) INTO unbackfilled
      FROM "warranty_claim_upload_destination"
     WHERE "purpose" IS NULL OR "owner_id" IS NULL;

    IF unbackfilled > 0 THEN
        RAISE EXCEPTION
          'refusing to contract: % upload destination row(s) still have a NULL purpose or owner_id. '
          'The expand migration (20261005040000) should have backfilled every row; investigate before retrying.',
          unbackfilled;
    END IF;
END $$;

ALTER TABLE "warranty_claim_upload_destination"
  ALTER COLUMN "purpose" SET NOT NULL;

ALTER TABLE "warranty_claim_upload_destination"
  ALTER COLUMN "owner_id" SET NOT NULL;

-- Relaxed, NOT dropped — see the header. The code deployed with this
-- migration stops writing it; the code it replaces still does.
ALTER TABLE "warranty_claim_upload_destination"
  ALTER COLUMN "claim_id" DROP NOT NULL;

COMMENT ON TABLE "warranty_claim_upload_destination" IS
  'Issued upload destinations for EVERY upload purpose, not warranty alone — see the purpose column. '
  'The name is historical: renaming it would break the old code still serving during a release-command '
  'window, for a cosmetic gain. Do NOT add a second destination table for a new upload flow; add a '
  'purpose enum value instead, so the customer binding, single-use and expiry guarantees keep having '
  'exactly one implementation (owner decision 2026-10-05).';

COMMENT ON COLUMN "warranty_claim_upload_destination"."claim_id" IS
  'TRANSITIONAL — superseded by purpose + owner_id. No longer written. Dropped in contract step B.';
