-- D9, owner-clarified 2026-09-17 (final shape).
--
--   INTERNAL  calculated price = CASH price. The floors bind it; profit is
--             measured on it; it is the real sale price.
--   DISPLAYED card price = cash x (1 + uplift). Shown to the customer,
--             published to Shopify, with cash presented as a discount off it.
--
-- This restores the cash-based calculation of the first implementation while
-- keeping the customer-facing presentation of the second: the headline price a
-- customer sees is the CARD price either way. Presenting it that way is also
-- the compliant framing — a cash discount is unrestricted, a card surcharge is
-- capped at 3% by the networks and banned in several states.
--
-- RENAME rather than drop-and-add: the columns hold the same kind of fact (a
-- versioned rule plus its rate), applied in the other direction.
ALTER TABLE "pricing_profile"
  RENAME COLUMN "cash_price_rule_id" TO "card_price_rule_id";

ALTER TABLE "pricing_profile"
  RENAME COLUMN "cash_discount_rate" TO "card_uplift_rate";

ALTER TABLE "pricing_profile"
  RENAME CONSTRAINT "pricing_profile_cash_discount_rate_check"
  TO "pricing_profile_card_uplift_rate_check";

-- An uplift is now added rather than subtracted, so the old [0,1) bound is the
-- wrong shape. A negative uplift would price card BELOW cash, inverting the
-- whole arrangement; zero is valid and means the two prices are equal.
ALTER TABLE "pricing_profile"
  DROP CONSTRAINT "pricing_profile_card_uplift_rate_check";

ALTER TABLE "pricing_profile"
  ADD CONSTRAINT "pricing_profile_card_uplift_rate_check"
  CHECK (card_uplift_rate >= 0);

COMMENT ON COLUMN "pricing_profile"."card_uplift_rate" IS
  'D9. Fraction added to the calculated CASH price to produce the CARD price (0.05 = card is 5% higher). The card price is what is DISPLAYED and PUBLISHED; the cash price is what the floors bind. Note a 5% uplift yields roughly a 4.8% discount off the displayed price, not 5%.';
