-- Upload destination generalization, CONTRACT STEP B of two — drop claim_id.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY THIS IS A SEPARATE DEPLOY FROM STEP A
-- ============================================================================
-- Fly runs `prisma migrate deploy` as a RELEASE COMMAND which completes BEFORE
-- any machine running the new code starts. For the length of that window the
-- PREVIOUS deploy is still serving traffic against the NEW schema.
--
-- Step A (20261007020000) shipped the writer that stopped setting `claim_id`
-- and relaxed the column to nullable. It is now the code serving production,
-- which is the precondition for dropping the column — and the precondition is
-- re-proven below against this database rather than assumed from that history.
--
--   expand  (20261005040000)  add purpose + owner_id, nullable, backfilled
--   step A  (20261007020000)  claim_id nullable; purpose/owner_id NOT NULL
--   step B  (this)            DROP COLUMN claim_id
--
-- THE TABLE IS STILL NOT RENAMED, for the reason step A documents: during that
-- same release window the old code would query a table that does not exist —
-- a real customer-visible failure on the upload endpoints, traded for a name
-- only developers read. Step A's `COMMENT ON TABLE` carries the warning that
-- actually matters: do not add a second destination table for a new upload
-- flow; add a `purpose` enum value, so the customer binding, single-use and
-- expiry guarantees keep having exactly one implementation.

-- ---------------------------------------------------------------------------
-- PROVE THE WRITER REALLY STOPPED, and prove it in a way that cannot pass by
-- finding nothing.
--
-- The window is anchored on step A's OWN recorded completion time rather than
-- a timestamp pasted in by hand — self-describing, and it cannot drift from
-- when the deploy actually happened. Rows issued BEFORE step A legitimately
-- carry a claim_id; those are exactly the ones being discarded on purpose.
--
-- If that migration row is missing or unfinished, this RAISES rather than
-- treating a NULL anchor as "nothing to check". A comparison against NULL
-- yields NULL, count() of no rows is 0, and a check that silently evaluates
-- to "fine" when its own premise is absent is not a check at all.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    step_a_finished_at timestamptz;
    still_written      bigint;
BEGIN
    SELECT "finished_at" INTO step_a_finished_at
      FROM "_prisma_migrations"
     WHERE "migration_name" = '20261007020000_upload_destination_contract_step_a'
       AND "finished_at" IS NOT NULL;

    IF step_a_finished_at IS NULL THEN
        RAISE EXCEPTION
          'refusing to drop claim_id: contract step A (20261007020000) is not recorded as finished in this '
          'database, so there is no point in time after which the column should be unwritten. Apply step A '
          'first — and note this cannot be fixed by running both in one deploy; see this file''s header.';
    END IF;

    SELECT count(*) INTO still_written
      FROM "warranty_claim_upload_destination"
     WHERE "claim_id" IS NOT NULL
       AND "issued_at" > step_a_finished_at;

    IF still_written > 0 THEN
        RAISE EXCEPTION
          'refusing to drop claim_id: % destination row(s) issued after contract step A (%) still set it. '
          'Some writer was missed — find it before dropping the column, or the next request through that '
          'path fails instead of this migration.',
          still_written, step_a_finished_at;
    END IF;
END $$;

-- Prisma named this from `@@index([claimId])`; dropped explicitly so the
-- intent is visible rather than happening as a side effect of DROP COLUMN.
DROP INDEX IF EXISTS "warranty_claim_upload_destination_claim_id_idx";

ALTER TABLE "warranty_claim_upload_destination"
  DROP COLUMN "claim_id";
