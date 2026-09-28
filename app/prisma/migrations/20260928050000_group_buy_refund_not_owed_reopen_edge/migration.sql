-- ARCHITECT DECISION (Group Buy settlement override follow-up, 2026-09-28):
-- a `not_owed` refund whose corrected facts reveal money IS owed after all
-- must be reachable, not permanently stranded in a status the domain's
-- transition table used to call terminal in every direction. See
-- `app/app/domain/groupbuy/refunds.ts`'s `ALLOWED["not_owed"]` for the
-- narrow, single-caller-only edge this migration backstops.
--
-- THE STRUCTURAL GUARANTEE THIS ADDS, independent of the domain table or any
-- application code path: a `group_buy_refund` row may NEVER carry
-- `status = 'not_owed'` alongside a nonzero `refund_amount_minor_units`.
-- That combination is exactly the bug this follow-up exists to make
-- impossible — money owed, sitting in a status with (before this migration)
-- no way out. `group_buy_refund_amount_matches_inputs` (migration
-- `20260918185856_group_buy_refund_ledger`) already ties the amount to the
-- paid/final inputs by formula; this constraint additionally ties the
-- STATUS to that same amount, so a future bug in the domain table, the
-- override function, or any other caller cannot reintroduce the trap this
-- one CHECK closes for good — belt and braces over the domain function, the
-- same discipline every other constraint in this table already follows.
ALTER TABLE "group_buy_refund" ADD CONSTRAINT "group_buy_refund_not_owed_has_zero_amount" CHECK (
    "status" <> 'not_owed' OR "refund_amount_minor_units" = 0
);
