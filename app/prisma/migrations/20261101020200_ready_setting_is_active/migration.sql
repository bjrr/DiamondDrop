-- Set Your Own Stone — active/inactive status for compatibility records
-- (owner decision 2026-10-31).
--
-- Separate from `eligible_for_set_your_own_stone`, which answers a different
-- question. Eligibility is "does this mounting participate in the feature";
-- active is "is this record still in force". A discontinued mounting is
-- deactivated rather than deleted, so the record of what customers were shown
-- survives for the sessions that matched against it.
--
-- DEFAULT TRUE, unlike the prong flag. Deactivation is the exceptional state
-- and there is no safety argument for the other default: a row that exists
-- was deliberately created, and defaulting it to inactive would silently
-- empty the catalogue on deploy.

ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT TRUE;

-- The storefront only ever reads rows that are BOTH active and eligible, so
-- that pair is the real access path for matching.
CREATE INDEX IF NOT EXISTS "ready_setting_compatibility_active_eligible_shape_idx"
  ON "ready_setting_compatibility" ("is_active", "eligible_for_set_your_own_stone", "shape");
