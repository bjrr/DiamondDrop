-- Set Your Own Stone — per-mounting prong-setting eligibility.
--
-- Owner decision 2026-10-31 permits a +/-0.3 mm automatic tolerance for
-- "professional prong-set mountings", and excludes designs "not reasonably
-- adjustable by prong setting". That makes adjustability a property of the
-- MOUNTING, not of the policy, so it needs a column.
--
-- DEFAULT FALSE is the safety-relevant choice. Existing rows must not silently
-- acquire a fit allowance they were never assessed for: a bezel or channel
-- setting shown as a size match would be discovered at the bench, after the
-- customer posted their own diamond. Silence means no, and populating this is
-- a deliberate per-mounting act.

ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN IF NOT EXISTS "prong_set_tolerance_eligible" BOOLEAN NOT NULL DEFAULT FALSE;

-- The tolerance never overrides an explicit vendor range (same decision). That
-- precedence is enforced in the matching service by rule order, not here — a
-- mounting may legitimately carry both a published range and a prong-set
-- design, and the service simply never consults the tolerance when a complete
-- range exists. Recorded so the absence of a constraint here is not read as an
-- oversight.
