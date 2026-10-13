-- Slice 2 stage 2A/2C, M7 (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md
-- §6). Extends the append-only enforcement (migrations 20260913000100 /
-- 20260914000000, reused unchanged by every L1 pricing table since
-- 20260917020000) to the two new evidence-shaped tables this stage adds.
--
-- pricing_input_change: a trigger record and a bulk-approval grouping key
-- (criterion 11) -- editing or deleting one after the fact would let a past
-- recalculation's stated cause be silently rewritten, exactly the reasoning
-- already applied to metal_price/stone_cost/cost_component/pricing_profile.
--
-- bank_payment_order_line: the spec names "the quote columns" specifically,
-- because those are the fields the 24-hour guarantee and the audit trail
-- depend on. THIS TABLE HAS NO COLUMN THAT LEGITIMATELY MUTATES AFTER
-- INSERT -- unlike bank_payment_order (its header, which is deliberately
-- left mutable for the open/cancelled/completed lifecycle), a line is
-- nothing but its frozen quote. Rather than inventing a partial-column
-- trigger to protect a subset that happens to equal every column on the
-- table, this applies the same whole-row functions used everywhere else in
-- this file. Flagged here for architect review: if a future column is added
-- to this table that legitimately needs to mutate, this blanket enforcement
-- must be replaced with the column-level style
-- price_recalculation_run_completion_only already demonstrates, not removed
-- outright.

-- pricing_input_change
CREATE TRIGGER pricing_input_change_no_update
    BEFORE UPDATE ON "pricing_input_change"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER pricing_input_change_no_delete
    BEFORE DELETE ON "pricing_input_change"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER pricing_input_change_no_truncate
    BEFORE TRUNCATE ON "pricing_input_change"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- bank_payment_order_line
CREATE TRIGGER bank_payment_order_line_no_update
    BEFORE UPDATE ON "bank_payment_order_line"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER bank_payment_order_line_no_delete
    BEFORE DELETE ON "bank_payment_order_line"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER bank_payment_order_line_no_truncate
    BEFORE TRUNCATE ON "bank_payment_order_line"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- price_sync_failure and bank_payment_order (the header) are DELIBERATELY
-- EXCLUDED: both are mutable workflow/state-machine tables, the same
-- reasoning migration 20260917020000 already recorded for price_sync_intent.
