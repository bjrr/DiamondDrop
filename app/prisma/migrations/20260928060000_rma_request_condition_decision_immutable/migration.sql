-- OWNER DECISION (RMA dispute-evidence integrity, 2026-09-28,
-- docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md). Follow-up to migration
-- 20260928040000 (`rma_remedy_requires_accepted_inspection`), raised during
-- that migration's own review: `rma_request_guard` (migration
-- 20260926010000) already makes `window_kind`, `calendar_days_since_delivery`,
-- the eligible-amount snapshot, and `received_at` immutable once set, but
-- NOT `condition_decision` -- so a raw UPDATE could rewrite an inspection
-- outcome (e.g. 'accepted' -> 'rejected') on an already-resolved/closed RMA,
-- after a remedy has already been created and possibly already issued.
--
-- This does not let anyone create a second remedy (the `rma_remedy`
-- unique-per-RMA constraint already prevents that) or move money without
-- approval (`rma_remedy_requires_accepted_inspection` only fires on INSERT).
-- But these rows are DISPUTE EVIDENCE -- the whole point of
-- BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md is a coherent packet assemblable
-- months later -- and an inspection outcome that can be silently rewritten
-- after the money question is settled makes that packet indefensible, with
-- nobody even able to tell the record changed.
--
-- STRICTLY ADDITIVE: `CREATE OR REPLACE FUNCTION rma_request_guard()` below
-- reproduces the ENTIRE existing function body from migration 20260926010000
-- unchanged, with exactly one new IF block inserted alongside the other
-- "historical fact, never revised" checks (right after `received_at`'s). No
-- existing check, comment structure, or the status transition table itself
-- is altered. The trigger declaration (`CREATE TRIGGER rma_request_guard
-- BEFORE UPDATE ...`) is untouched and does not need to be recreated --
-- replacing the function body is sufficient, the same pattern this repo
-- already uses for `group_buy_campaign_guard` (migrations 20260918183627,
-- 20260918184804, 20260919060000).
--
-- RULE: once `condition_decision` is non-NULL, it can never change value and
-- can never return to NULL. Setting it from NULL exactly once (the normal
-- `decide_condition` transition) remains legal -- this is the same "one
-- recorded fact, then frozen" shape as `received_at` just above it.
--
-- CHECK CONSTRAINT NOT NARROWED (finding, not a decision to act on):
-- `rma_request_condition_decision_status_coherent` (migration 20260926010000)
-- permits BOTH `condition_decision = 'accepted'` and `condition_decision =
-- 'rejected'` at `status IN ('resolved', 'closed')`. This was considered for
-- narrowing but is NOT changed, because both are legitimate: the allowed
-- status-transition table lets a request reach `resolved` via TWO distinct
-- paths -- `inspection_passed -> remedy_in_progress -> resolved` (decision
-- stays 'accepted') and `inspection_failed -> resolved` (decision stays
-- 'rejected') -- and `closed` follows either. Narrowing the CHECK to require
-- one specific decision at `resolved`/`closed` would refuse one of these two
-- real, already-relied-upon paths. The actual risk this migration closes is
-- REWRITING the decision after the fact, which the new immutability check
-- above closes directly; the CHECK's breadth at those two statuses is
-- correct as written and is left alone.
CREATE OR REPLACE FUNCTION rma_request_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.window_kind IS DISTINCT FROM OLD.window_kind THEN
        RAISE EXCEPTION
            'rma request %: window_kind is set once at creation and cannot change',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.calendar_days_since_delivery IS DISTINCT FROM OLD.calendar_days_since_delivery THEN
        RAISE EXCEPTION
            'rma request %: calendar_days_since_delivery is a snapshot at request time and cannot change',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.eligible_merchandise_amount_minor_units IS DISTINCT FROM OLD.eligible_merchandise_amount_minor_units
       OR NEW.eligible_merchandise_amount_currency IS DISTINCT FROM OLD.eligible_merchandise_amount_currency THEN
        RAISE EXCEPTION
            'rma request %: the eligible merchandise amount is a snapshot at request time and cannot change',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    -- received_at is set once, by the one transition that means "receipt
    -- happened." Never cleared, never backdated afterwards.
    IF OLD.received_at IS NOT NULL AND NEW.received_at IS DISTINCT FROM OLD.received_at THEN
        RAISE EXCEPTION
            'rma request %: received_at is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    -- NEW (migration 20260928060000) — condition_decision is an inspection
    -- OUTCOME, not an editable field. Once recorded it is dispute evidence:
    -- the same "historical fact, never revised" discipline as received_at
    -- immediately above. Legal exactly once, from NULL to a value; illegal
    -- thereafter in every direction, including back to NULL.
    IF OLD.condition_decision IS NOT NULL AND NEW.condition_decision IS DISTINCT FROM OLD.condition_decision THEN
        RAISE EXCEPTION
            'rma request %: condition_decision (%) is an inspection outcome recorded once at inspection, not an editable field -- it cannot be changed to % now, not even back to NULL',
            OLD.id, OLD.condition_decision, COALESCE(NEW.condition_decision::text, 'NULL')
            USING ERRCODE = '23001';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'submitted'                     AND NEW.status IN ('approved', 'denied'))
            OR (OLD.status = 'approved'                       AND NEW.status IN ('return_shipped', 'received_inspection_pending', 'expired'))
            OR (OLD.status = 'return_shipped'                 AND NEW.status IN ('received_inspection_pending', 'expired'))
            OR (OLD.status = 'received_inspection_pending'    AND NEW.status IN ('inspection_passed', 'inspection_failed'))
            OR (OLD.status = 'inspection_passed'              AND NEW.status = 'remedy_in_progress')
            OR (OLD.status = 'remedy_in_progress'             AND NEW.status = 'resolved')
            OR (OLD.status = 'inspection_failed'              AND NEW.status = 'resolved')
            OR (OLD.status = 'resolved'                       AND NEW.status = 'closed')
        ) THEN
            RAISE EXCEPTION
                'rma request %: % -> % is not an allowed status transition',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
