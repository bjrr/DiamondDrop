-- Set Your Own Stone — Shopify metafields become the authoring surface.
-- Owner direction 2026-11-01.
--
-- PURELY ADDITIVE. Every column is nullable with no default backfill, so this
-- deploys against the existing table without touching a single existing row
-- and without a window where the matcher sees half-migrated data. Nothing is
-- dropped or renamed: the compatibility table keeps every column it had, and
-- the 37 matching tests keep passing because the matcher's inputs are
-- unchanged in shape — only their provenance moves to Shopify.

-- ---------------------------------------------------------------------------
-- ready_setting_compatibility: the row becomes a DERIVED projection
-- ---------------------------------------------------------------------------

-- The Shopify ProductOptionValue the centre size belongs to. A stable
-- identity rather than a label, so the storefront can preselect the matched
-- centre size with real catalogue data and a historical session can name the
-- configuration it matched even after the label is reworded.
ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "center_size_option_value_id" TEXT;

-- Where this projection came from, and when. Lets the index be rebuilt from
-- Shopify at any time and lets the dashboard show "the product changed but the
-- sync has not caught up", which is otherwise invisible.
ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "synced_from_shopify_at" TIMESTAMPTZ(6);

ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "sync_source_hash" TEXT;

-- Problems found while projecting. A row with problems is forced ineligible,
-- so a misconfiguration costs a MISSING mounting rather than a WRONG match.
-- Stored rather than logged because the dashboard has to tell "nobody has
-- configured this yet" apart from "this is configured wrongly" — different
-- jobs for different people.
ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "sync_problems" JSONB;

-- The dashboard's two real queries: everything needing attention, and
-- everything whose sync is stale.
CREATE INDEX IF NOT EXISTS "ready_setting_compatibility_sync_attention_idx"
  ON "ready_setting_compatibility" ("synced_from_shopify_at");

-- ---------------------------------------------------------------------------
-- stone_session: historical evidence for a decision Shopify can now change
-- ---------------------------------------------------------------------------
--
-- `compatibility_status` and `compatibility_rule` record WHAT was decided.
-- They cannot explain WHY, and that gap matters now in a way it did not
-- before: staff edit metafields in Shopify, so a mounting's nominal size,
-- vendor range or prong eligibility can change the day after a customer was
-- shown a match. "We told them 10 x 7 fits" has to stay answerable from the
-- numbers actually used at the time.
ALTER TABLE "stone_session"
  ADD COLUMN IF NOT EXISTS "matched_snapshot" JSONB;

-- WRITE-ONCE, ENFORCED BY THE DATABASE.
--
-- The owner's instruction is explicit: "Later Shopify edits must not rewrite
-- the snapshot." Application discipline is not enough for evidence — this is
-- the column someone reaches for when a customer disputes what they were
-- shown, and a well-meaning resync that "corrects" it destroys exactly the
-- record that was worth keeping.
--
-- Deliberately permissive in one direction: NULL -> value is allowed, because
-- the snapshot is written after the row is created. Value -> different value
-- and value -> NULL both abort. An UPDATE that leaves it untouched passes, so
-- ordinary session progress (selecting a setting, handing off to Custom
-- Jewelry) is unaffected.
CREATE OR REPLACE FUNCTION prevent_matched_snapshot_rewrite()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."matched_snapshot" IS NOT NULL
       AND NEW."matched_snapshot" IS DISTINCT FROM OLD."matched_snapshot" THEN
        RAISE EXCEPTION
            'stone_session.matched_snapshot is write-once historical evidence and cannot be changed (row id %)',
            OLD.id
            USING ERRCODE = '23001'; -- restrict_violation
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stone_session_matched_snapshot_write_once ON "stone_session";
CREATE TRIGGER stone_session_matched_snapshot_write_once
    BEFORE UPDATE ON "stone_session"
    FOR EACH ROW EXECUTE FUNCTION prevent_matched_snapshot_rewrite();
