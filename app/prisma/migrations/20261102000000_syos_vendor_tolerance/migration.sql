-- Vendor-documented compatibility tolerance (owner decision 2026-11-01).
--
-- George's documents mounting #2 as "+/-0.2 mm for stones under 1 ct and
-- +/-0.3 mm for stones over 1 ct". The owner's ruling is to apply the
-- conservative 0.2 mm to all stones on that mounting, with anything beyond it
-- falling into the REVIEW band.
--
-- This is a separate column from the min/max range on purpose. Outside a
-- vendor RANGE is a flat no by design, so expressing a tolerance that way
-- would turn a 0.21 mm difference into "no match" instead of "review
-- required" -- and widening the range's meaning would weaken a published
-- manufacturer restriction for every other vendor.
--
-- Integer micrometres, like every other dimension here. No floats.
ALTER TABLE "ready_setting_compatibility"
  ADD COLUMN "vendor_tolerance_um" INTEGER,
  ADD COLUMN "vendor_tolerance_source" TEXT;

-- A tolerance with no provenance cannot be audited against the vendor six
-- months from now, and a negative or absurd tolerance is a data error rather
-- than a narrow rule. Both are refused at the database.
ALTER TABLE "ready_setting_compatibility"
  ADD CONSTRAINT "ready_setting_vendor_tolerance_needs_source"
  CHECK (
    "vendor_tolerance_um" IS NULL
    OR ("vendor_tolerance_source" IS NOT NULL
        AND btrim("vendor_tolerance_source") <> ''
        AND "vendor_tolerance_um" > 0
        AND "vendor_tolerance_um" <= 2000)
  );

ALTER TYPE "stone_compatibility_rule" ADD VALUE IF NOT EXISTS 'vendor_tolerance';
