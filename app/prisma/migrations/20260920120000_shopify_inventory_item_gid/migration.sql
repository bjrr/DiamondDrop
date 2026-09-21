-- R17 (owner ruling, 2026-09-20) -- the mapping the `inventory_levels/update`
-- webhook resolves through, replacing `variants/out_of_stock`/
-- `variants/in_stock` (proven live not to fire under real conditions --
-- see docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md R15/R17).
--
-- Nullable and additive only: no existing row is touched. Every
-- already-linked variant needs an explicit BACKFILL from the Admin API
-- (see app/shopify/admin/backfillInventoryItemGids.server.ts) before the
-- webhook can resolve anything for it.

-- AlterTable
ALTER TABLE "master_variant" ADD COLUMN "shopify_inventory_item_gid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "master_variant_shopify_inventory_item_gid_key" ON "master_variant"("shopify_inventory_item_gid");
