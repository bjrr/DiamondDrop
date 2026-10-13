-- Slice 2 stage 2A, M1 (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §6,
-- owner §7.3). Per-variant escape hatch from the Bank Payment Discount: a
-- bank-mode cart still charges an ineligible line the Regular/Card Price
-- (owner §7.4, criterion 41). Defaults ON, matching the owner's stated
-- default and this column being an exception flag rather than an opt-in.
-- This column is the SYSTEM OF RECORD (criterion 40) -- Shopify's own
-- metafield mirror of it (T6) is a presentation cache only.

-- AlterTable
ALTER TABLE "master_variant" ADD COLUMN     "bank_payment_discount_eligible" BOOLEAN NOT NULL DEFAULT true;
