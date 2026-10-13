-- Slice 2 stage 2A, M2 part 1 (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md
-- §6, owner §2.4, criteria 15/16). An override departs from the calculated
-- price at write time; the owner's rule is that a later MATERIAL
-- recalculation retires it automatically unless `neverExpire` is set.
-- Expiry is recorded the same way revocation already is (migration
-- 20260917161500): APPEND a new price_override row (kind `expired`) rather
-- than editing or deleting the retired one -- the table is append-only.
--
-- SPLIT FROM the CHECK-constraint update in the next migration.
-- `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction as a
-- comparison against the new value (Postgres restriction; Prisma wraps each
-- migration in one transaction). Migration 20260917070507 already
-- established this split in this repository -- add the value here, use it
-- nowhere in this file.

-- AlterEnum
ALTER TYPE "price_override_kind" ADD VALUE 'expired';

-- AlterTable
ALTER TABLE "price_override" ADD COLUMN     "never_expire" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "price_override"."never_expire" IS
  'Owner escape hatch (§2.4): when true, this override chain survives any number of material recalculations and is retired only by an explicit human revoke, never by automatic expiry.';
