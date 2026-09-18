-- Corrects the enum type on metal_reference_price.source.
--
-- The preceding migration declared it as "price_sync_intent_status" — the wrong
-- type entirely, copied from a neighbouring enum. Prisma binds the column as
-- metal_price_source, so every insert failed with
--   column "source" is of type price_sync_intent_status
--   but expression is of type metal_price_source
-- and the seed aborted. The column never accepted a row, so there is no data to
-- preserve and the cast below is a formality.
--
-- Forward-only rather than editing the previous migration: that file has been
-- applied and its checksum is recorded, and rewriting applied history is how a
-- migration set stops being trustworthy.
ALTER TABLE "metal_reference_price"
  ALTER COLUMN "source" TYPE "metal_price_source"
  USING "source"::text::"metal_price_source";
