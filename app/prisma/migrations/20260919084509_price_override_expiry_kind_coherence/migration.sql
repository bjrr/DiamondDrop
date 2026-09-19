-- Slice 2 stage 2A, M2 part 2 -- completes 20260919084408_price_override_expiry_kind.
-- Separate migration because the `expired` enum value added there cannot be
-- compared against in the same transaction (see that migration's header).
--
-- Widens the kind/price coherence CHECK added by 20260917161500 to admit
-- `expired`, which carries no price of its own -- exactly like `revoke`, for
-- the same reason: both mean "the calculated price applies again", never a
-- manually set one.

ALTER TABLE "price_override"
  DROP CONSTRAINT "price_override_kind_bank_payment_price_coherent";

ALTER TABLE "price_override"
  ADD CONSTRAINT "price_override_kind_bank_payment_price_coherent" CHECK (
    (kind = 'set'                  AND override_bank_payment_price_minor_units IS NOT NULL
                                    AND override_bank_payment_price_minor_units > 0)
    OR
    (kind IN ('revoke', 'expired') AND override_bank_payment_price_minor_units IS NULL)
  );
