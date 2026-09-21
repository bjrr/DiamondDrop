-- Slice 2C, M8 (docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §6, criteria
-- 97-98; architecture review C2C-1). The shipping address stays out of this
-- table entirely -- it is sent to Shopify at draft-order creation and
-- deliberately never persisted here, so there is no address column to add.
-- `customer_email` is the one stored exception: the cancellation email
-- (criterion 80/D22) must be sendable when the draft order it would
-- otherwise be read from may already be gone.
--
-- NOT NULL, no default, no backfill: `bank_payment_order` has zero rows in
-- every environment this feature has shipped to, because the checkout route
-- that creates rows (2C-3) does not exist yet -- M8 lands before any row can
-- be written. D20 requires every draft order to carry an email from
-- creation ("a draft order cannot exist without one"), so the column
-- reflects that invariant directly rather than being added nullable and
-- tightened later.

-- AlterTable
ALTER TABLE "bank_payment_order" ADD COLUMN "customer_email" TEXT NOT NULL;
