-- Set Your Own Stone — the owner's prong-setting tolerance (decision 2026-10-31).
--
-- ENUM VALUE ONLY, IN ITS OWN MIGRATION. Postgres will not let a newly added
-- enum value be USED in the same transaction that adds it, so the column that
-- records it lands in the next migration. The two Set Your Own Stone
-- migrations before this one are split the same way and for the same reason.

ALTER TYPE "stone_compatibility_rule" ADD VALUE IF NOT EXISTS 'prong_set_tolerance';
