-- D9, owner-revised 2026-09-17. The model INVERTS.
--
-- Was:  calculated price = cash-equivalent base;  card = base x 1.05
-- Now:  calculated price = LIST price = card price;  cash = list x 0.95
--
-- Not a sign flip. 5% off list is a 5.26% card-to-cash spread, and the floors
-- now bind the CARD price rather than the cash one. The owner's stated purpose
-- is to encourage cash payment and to let the list price carry the card
-- processing fee and other costs.
--
-- RENAME rather than drop-and-add, so the existing rows keep their identity and
-- the history stays continuous: these columns hold the same KIND of fact
-- (a versioned rule plus its rate), applied in the other direction.
ALTER TABLE "pricing_profile"
  RENAME COLUMN "credit_card_price_rule_id" TO "cash_price_rule_id";

ALTER TABLE "pricing_profile"
  RENAME COLUMN "credit_card_uplift_rate" TO "cash_discount_rate";

ALTER TABLE "pricing_profile"
  RENAME CONSTRAINT "pricing_profile_credit_card_uplift_rate_check"
  TO "pricing_profile_cash_discount_rate_check";

-- A discount of 100% or more would make the cash price zero or negative, which
-- is not a price. The owner's instruction that the discount overrides the
-- PROFIT minimums does not extend to producing a non-price: 0 <= rate < 1.
ALTER TABLE "pricing_profile"
  DROP CONSTRAINT "pricing_profile_cash_discount_rate_check";

ALTER TABLE "pricing_profile"
  ADD CONSTRAINT "pricing_profile_cash_discount_rate_check"
  CHECK (cash_discount_rate >= 0 AND cash_discount_rate < 1);

-- Existing rows carry 0.05 from the previous default. That number is still
-- right, but it now means "5% off list" rather than "5% onto cash", so the
-- profiles that used it under the old meaning are superseded by a new version
-- rather than reinterpreted in place (pricing_profile is append-only).
COMMENT ON COLUMN "pricing_profile"."cash_discount_rate" IS
  'D9. Fraction taken OFF the list/card price for cash-equivalent payment (0.05 = 5%). May take the cash price below the minimum-profit floor: that is the owner-approved intent, not a defect.';
