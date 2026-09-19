-- Slice 2 stage 2A, M4 completion -- completes 20260919084722_pricing_input_change.
-- Separate migration because `input_change` cannot be compared against in
-- the same transaction that added it (see that migration's header).
--
-- A run recorded with trigger = 'input_change' must always name the change
-- that caused it, and no other trigger may carry one -- so criterion 11's
-- bulk-approval join always resolves to a real, singular cause.

ALTER TABLE "price_recalculation_run"
  ADD CONSTRAINT "price_recalculation_run_input_change_pairing" CHECK (
    (trigger = 'input_change') = (pricing_input_change_id IS NOT NULL)
  );
