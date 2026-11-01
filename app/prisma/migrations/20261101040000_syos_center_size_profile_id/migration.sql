-- Set Your Own Stone -- the reverse index for Center Stone Size Profile events.
-- Owner direction 2026-11-01.
--
-- ADDITIVE AND NULLABLE. Deploys against the existing table without touching a
-- row and without a window where the matcher sees half-migrated data.
--
-- WHY A COLUMN AND NOT A JOIN: a merchant editing "Pear 10 x 7 mm" from
-- 10.0 x 7.0 to 10.5 x 7.0 touches NO product. The option value still points at
-- the same metaobject id, so no Product event fires and nothing in the product
-- graph changed. The Metaobject event gives us only the profile id, so the
-- handler has to answer "which mounting configurations used this profile?"
-- Without this column that question needs a scan of every product in the
-- catalogue through the Shopify API on every profile edit.
ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "center_size_profile_id" TEXT;

-- The profile-event lookup is the whole reason the column exists, so it gets
-- the index. Partial: rows with no profile are misconfigured and are never the
-- target of a profile event.
CREATE INDEX IF NOT EXISTS "ready_setting_compatibility_center_size_profile_idx"
  ON "ready_setting_compatibility" ("center_size_profile_id")
  WHERE "center_size_profile_id" IS NOT NULL;
