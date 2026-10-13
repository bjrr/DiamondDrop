-- Slice 3 follow-up (owner directive, 2026-09-24): D27
-- (docs/specs/SLICE-3-LUXURY-STEALS.md) makes variant-grain assignment
-- (master_variant.is_luxury_steal, migration 20260923010000) the ONLY
-- source of truth for Luxury Steal status. This migration retires the
-- slice-1 product-level column that predated D27.
--
-- WHY THIS MATTERED, NOT JUST TIDINESS.
-- app/jobs/pricing/runRecalculation.server.ts was reading
-- master_product.is_luxury_steal directly to exclude Luxury Steal variants
-- from ordinary Buy Now price recalculation. Under D27 that is wrong in two
-- directions at once: a variant assigned through the new variant-level admin
-- path whose PRODUCT flag was never set would NOT be skipped, so the
-- recalculation job would silently overwrite the deliberately-low assigned
-- price with an ordinary computed one (docs/LUXURY-STEALS.md requires the
-- assigned price to be explicit and auditable); and the old behaviour would
-- also have skipped every OTHER variant of that product too, which
-- criterion 147 forbids now that assignment is per variant. Leaving the
-- column in place as an unused second source of truth was exactly what §5 of
-- the spec says not to do ("nothing may read assignment from the product").
--
-- BACKFILL BEFORE DROP, so this migration is correct wherever it runs, not
-- only against carat_dev. Verified there directly before writing this
-- migration: zero products currently carry is_luxury_steal (0 of 22), so the
-- backfill is a no-op in THIS database today -- but the ordering still
-- matters for any other environment this migration is applied to, and for
-- anyone re-deriving this history later.
UPDATE "master_variant" v
SET "is_luxury_steal" = true
FROM "master_product" p
WHERE v."master_product_id" = p."id" AND p."is_luxury_steal" = true;

-- AlterTable
ALTER TABLE "master_product" DROP COLUMN "is_luxury_steal";
