-- Generalise the upload-destination model: EXPAND phase (owner-directed
-- 2026-10-05). Additive only. Nothing is renamed, nothing is dropped, and no
-- existing row is rewritten beyond gaining values in two new columns.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY TWO MIGRATIONS AND NOT ONE
-- ============================================================================
-- Fly runs `prisma migrate deploy` as a RELEASE COMMAND, before the new
-- machines start. So between the migration finishing and the new code serving
-- traffic, the OLD code runs against the NEW schema. A single migration that
-- added columns, backfilled, set NOT NULL and dropped `claim_id` would leave
-- the running code writing a column that no longer exists — a real, if brief,
-- outage of warranty upload issuance, during which a customer's upload fails
-- for reasons nobody watching would recognise.
--
-- Expand/contract removes that window:
--   THIS migration  — add nullable columns, backfill existing rows.
--   deploy          — code writes BOTH old and new, reads the new.
--   verify          — the warranty live gate must still be 10/10.
--   contract        — set NOT NULL, drop `claim_id`, rename the table.
--
-- The owner asked for exactly this ordering, and it is the reason the
-- sequencing is not collapsed for convenience.
--
-- ============================================================================
-- THE PURPOSE DISCRIMINATOR IS A SECURITY BOUNDARY, NOT A LABEL
-- ============================================================================
-- One table now serves warranty claims and Custom Jewelry enquiries. A
-- destination issued for one purpose must be unusable for the other, and that
-- is enforced by `purpose` being part of the consumption WHERE clause, not by
-- callers remembering to check it. Cross-purpose reuse fails closed because
-- the row simply does not match.

CREATE TYPE "upload_destination_purpose" AS ENUM ('warranty_claim', 'custom_jewelry_project');

-- NULLABLE FOR NOW. The currently-running code does not populate these; making
-- them NOT NULL here would break every issuance between the release command
-- and the new machines starting. They become NOT NULL in the contract phase,
-- once every writer sets them.
ALTER TABLE "warranty_claim_upload_destination" ADD COLUMN "purpose" "upload_destination_purpose";

-- The generic owner reference. For a warranty destination this is the claim
-- id; for Custom Jewelry it is the project id. Deliberately NOT a foreign key,
-- for the same reason `claim_id` never was: a destination is issued BEFORE the
-- row it will belong to exists (evidence is gathered while a form is filled
-- out), so a FK would make the normal flow impossible.
ALTER TABLE "warranty_claim_upload_destination" ADD COLUMN "owner_id" UUID;

-- BACKFILL, EXPLICITLY. Every existing row is a warranty destination by
-- definition — this table has never held anything else — so the mapping is
-- exact rather than inferred.
UPDATE "warranty_claim_upload_destination"
   SET "purpose" = 'warranty_claim',
       "owner_id" = "claim_id"
 WHERE "purpose" IS NULL OR "owner_id" IS NULL;

-- PROVE THE BACKFILL REACHED EVERY ROW BEFORE THIS MIGRATION IS ALLOWED TO
-- COMMIT. A backfill that silently misses rows leaves evidence that later
-- fails the NOT NULL in the contract phase, at which point the cause is three
-- deploys behind. Postgres DDL is transactional, so raising here rolls the
-- whole migration back and nothing is half-applied.
DO $$
DECLARE
    unbackfilled bigint;
BEGIN
    SELECT count(*) INTO unbackfilled
      FROM "warranty_claim_upload_destination"
     WHERE "purpose" IS NULL OR "owner_id" IS NULL;

    IF unbackfilled > 0 THEN
        RAISE EXCEPTION
            'backfill incomplete: % upload destination row(s) still have a NULL purpose or owner_id',
            unbackfilled;
    END IF;
END $$;

-- An owner's destinations are looked up together during consumption.
CREATE INDEX "upload_destination_purpose_owner_idx"
    ON "warranty_claim_upload_destination"("purpose", "owner_id");
