-- Phase 2C-c, verification admin surface. `CLAUDE.md` #14 locks eligible
-- Bank Payment methods to exactly four electronic instruments (Zelle, ACH,
-- bank transfer, wire) and excludes cheques, money orders and other paper.
-- `bank_payment_order.verified_payment_method` was free-text `String?`,
-- which let a staff member type "check" and quietly violate that rule with
-- no code path noticing. This migration closes it at the database.
--
-- DATA CHECKED BEFORE WRITING THIS MIGRATION (dev database, 2026-09-22):
-- 14 bank_payment_order rows exist (live-gate/test fixtures from phases
-- 2C-a/2C-b), of which exactly 2 have a non-null verified_payment_method,
-- and both are the literal "zelle" -- already a legitimate member of the
-- new enum. The USING cast below is therefore lossless for every row that
-- exists today; there is no non-conforming value to migrate around.

-- CreateEnum
CREATE TYPE "bank_payment_method" AS ENUM ('zelle', 'ach', 'bank_transfer', 'wire');

-- AlterTable
ALTER TABLE "bank_payment_order"
  ALTER COLUMN "verified_payment_method" TYPE "bank_payment_method"
  USING "verified_payment_method"::"bank_payment_method";

COMMENT ON COLUMN "bank_payment_order"."verified_payment_method" IS
  'Phase 2C-c. Closed to the four electronic Bank Payment methods CLAUDE.md #14 makes eligible -- no cheque, money order or other paper instrument. Enforced by the database as of this migration, not merely by application code.';
