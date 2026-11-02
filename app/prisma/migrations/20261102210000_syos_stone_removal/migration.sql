-- $50 prong-only Stone Removal (docs/SET-YOUR-OWN-STONE.md §17.3,
-- owner-locked 2026-11-02).
--
-- Replaces the boolean `is_currently_mounted` with a three-valued state,
-- because "mounted" on its own does not say whether CaratForUs may remove the
-- stone -- which is the only thing the removal service turns on.
--
-- THE BACKFILL FAILS CLOSED.
--   false -> LOOSE               determinable: loose is loose.
--   true  -> MOUNTED_UNSUPPORTED NOT determinable. The old form recorded only
--                                "mounted", so prong-set cannot be inferred.
--                                Mapping these to MOUNTED_PRONG would offer a
--                                $50 service and imply we can open a setting
--                                we have never seen; mapping them to
--                                unsupported says "we do not know this is
--                                prong-set, so we do not offer removal",
--                                which is true and safe. Operations re-asks.
--
-- At the time of writing both existing rows are `false`, so this migration is
-- exact on the live data; the `true` branch exists for any row created between
-- now and deploy.

CREATE TYPE "stone_mounted_state" AS ENUM ('LOOSE', 'MOUNTED_PRONG', 'MOUNTED_UNSUPPORTED');

ALTER TABLE "stone_session" ADD COLUMN "mounted_state" "stone_mounted_state";

UPDATE "stone_session"
SET "mounted_state" = CASE
  WHEN "is_currently_mounted" THEN 'MOUNTED_UNSUPPORTED'::"stone_mounted_state"
  ELSE 'LOOSE'::"stone_mounted_state"
END;

ALTER TABLE "stone_session" ALTER COLUMN "mounted_state" SET NOT NULL;
ALTER TABLE "stone_session" DROP COLUMN "is_currently_mounted";

-- The removal selection. Defaults to declined: a $50 service is never
-- pre-selected on a customer's behalf.
ALTER TABLE "stone_session"
  ADD COLUMN "stone_removal_selected" BOOLEAN NOT NULL DEFAULT false;

-- A selection the customer could not have been offered must not be
-- representable. The route rejects it too; this is the copy of the rule that
-- survives a bug in the route.
ALTER TABLE "stone_session"
  ADD CONSTRAINT "stone_session_removal_requires_prong"
  CHECK ("stone_removal_selected" = false OR "mounted_state" = 'MOUNTED_PRONG');
