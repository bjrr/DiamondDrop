-- A refund has to be computed against the basis the money arrived in.
--
-- THE BUG THIS CLOSES. group_buy_refund compares what a customer paid against
-- the campaign's final tier price. The tier price is derived from the frozen
-- CASH base, so it is a cash figure. A card customer paid cash x 1.05. Without
-- recording which price they paid, the comparison silently refunds the uplift
-- as well — roughly 5% of the order value, on every card line, every time a
-- tier drops. Nothing flagged it because both numbers are plausible money in
-- the right currency.
--
-- Recording the basis is what makes the two amounts comparable, and makes a
-- mismatch a schema error rather than an arithmetic one.

CREATE TYPE "payment_basis" AS ENUM ('cash', 'credit_card');

-- Added NULLABLE first, then backfilled, then constrained. A DEFAULT would
-- settle the question for every future insert as well, and "which price did
-- this customer pay?" is not a question that should have a default answer.
ALTER TABLE "group_buy_refund"
  ADD COLUMN "payment_basis" "payment_basis";

-- Backfill: every existing row predates any card/cash split reaching checkout,
-- so all of them were charged the single published price. That price was the
-- stored calculated price, which is the CASH price — hence 'cash', and not
-- 'credit_card' merely because card is the headline going forward.
--
-- This is development data only; the statement is written to be exact rather
-- than convenient so that it stays correct if it ever runs anywhere else.
UPDATE "group_buy_refund" SET "payment_basis" = 'cash' WHERE "payment_basis" IS NULL;

ALTER TABLE "group_buy_refund"
  ALTER COLUMN "payment_basis" SET NOT NULL;

COMMENT ON COLUMN "group_buy_refund"."payment_basis" IS
  'Which price the customer paid: cash (ACH/wire/Zelle/check) or credit_card (cash x 1+uplift). paid_per_unit_minor_units and final_per_unit_minor_units are both expressed in this basis.';
