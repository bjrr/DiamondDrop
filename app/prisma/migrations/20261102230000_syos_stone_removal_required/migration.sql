-- Stone Removal is REQUIRED for a prong-set stone, not optional
-- (owner correction 2026-11-02).
--
-- The column stops being a customer selection and becomes a derived fact:
-- prong-set means required, and a customer who would rather not pay us has
-- their stone professionally removed first, which makes their answer LOOSE.
--
-- The constraint therefore becomes a BICONDITIONAL rather than an implication.
-- The old one only forbade required-without-prong; this one also forbids
-- prong-without-required, which is the contradictory operational state the
-- correction is about: an order that includes a prong-mounted stone but no
-- removal service is one the bench cannot fulfil.
--
-- Backfill is exact in both directions — every prong row becomes required,
-- every other row becomes not-required — because the value is a function of a
-- column that is already correct.

ALTER TABLE "stone_session"
  DROP CONSTRAINT IF EXISTS "stone_session_removal_requires_prong";

ALTER TABLE "stone_session"
  RENAME COLUMN "stone_removal_selected" TO "stone_removal_required";

UPDATE "stone_session"
SET "stone_removal_required" = ("mounted_state" = 'MOUNTED_PRONG');

ALTER TABLE "stone_session"
  ADD CONSTRAINT "stone_session_removal_matches_mounted_state"
  CHECK ("stone_removal_required" = ("mounted_state" = 'MOUNTED_PRONG'));
