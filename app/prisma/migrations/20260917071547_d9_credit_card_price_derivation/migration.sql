-- D9 (owner-resolved 2026-09-17): the calculated price is the CASH-EQUIVALENT
-- base; the credit-card price is derived from it rather than maintained as a
-- second editable number.
--
-- Added in two steps because pricing_profile already holds rows and is
-- append-only: a bare NOT NULL ADD COLUMN would fail on them, and rows cannot
-- be UPDATEd afterwards (the append-only trigger blocks it). DEFAULT populates
-- existing rows in the same statement, and the default is then DROPPED so that
-- future inserts must state the rule and rate explicitly rather than silently
-- inheriting a 5% uplift nobody chose.
ALTER TABLE "pricing_profile"
  ADD COLUMN "credit_card_price_rule_id" TEXT NOT NULL DEFAULT 'MULTIPLY_BASE_V1',
  ADD COLUMN "credit_card_uplift_rate" DECIMAL(9,6) NOT NULL DEFAULT 0.050000;

ALTER TABLE "pricing_profile"
  ALTER COLUMN "credit_card_price_rule_id" DROP DEFAULT,
  ALTER COLUMN "credit_card_uplift_rate" DROP DEFAULT;

-- A negative uplift would make the card price cheaper than cash, which inverts
-- the whole point of a cash-equivalent base. Zero is allowed: it is the valid
-- way to express "card and cash cost the same".
ALTER TABLE "pricing_profile"
  ADD CONSTRAINT "pricing_profile_credit_card_uplift_rate_check"
  CHECK (credit_card_uplift_rate >= 0);

COMMENT ON COLUMN "pricing_profile"."credit_card_uplift_rate" IS
  'D9. Fraction added to the cash-equivalent base price for card payment (0.05 = 5%). Configurable; the formula itself is versioned by credit_card_price_rule_id.';
