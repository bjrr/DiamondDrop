-- OWNER DECISION (discretionary RMA authorization chain, 2026-09-28,
-- docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md): every discretionary RMA
-- window -- including Day 0-7 -- requires customer submission -> staff
-- pre-shipment authorization -> receipt+inspection -> staff remedy approval
-- -> execution, "structurally enforced in the state machine/database, not
-- merely checked by a route." Steps 1-3 are `rma_request_guard` plus
-- `rma_request_condition_decision_status_coherent`
-- (migration 20260926010000). Steps 4-5 are `rma_remedy_guard` plus
-- `rma_remedy_requires_approval_once_left_pending`
-- (migration 20260927030000). THIS MIGRATION closes the one remaining link
-- BETWEEN step 3 and step 4: "a remedy may only exist for an RMA whose
-- inspection was ACCEPTED" was previously enforced only in
-- `rmaRepository.server.ts`'s `createRmaRemedy` (one `if` statement) and
-- nowhere at the database -- so a raw INSERT, a future repository function,
-- or a backfill script could create a remedy for an RMA that was never
-- inspected, or was inspected and REJECTED, and the approval gate would then
-- let a reviewer approve paying for merchandise CaratForUs refused.
--
-- A same-row CHECK constraint cannot express this: it needs to read
-- `rma_request`, a different table, which Postgres CHECK constraints cannot
-- reference. A trigger is required, same reasoning `rma_request_guard` and
-- `rma_remedy_guard` already rely on for their own cross-row rules.
--
-- BEFORE INSERT only, deliberately -- see the finding below on why an
-- UPDATE-side guard is not added here.
CREATE OR REPLACE FUNCTION rma_remedy_requires_accepted_inspection()
RETURNS TRIGGER AS $$
DECLARE
    v_condition_decision "rma_condition_decision";
BEGIN
    -- FOR SHARE: holds the parent row against a concurrent condition-decision
    -- change until this INSERT's transaction commits, so a remedy INSERT and
    -- a competing decide-condition UPDATE cannot interleave into an
    -- inconsistent result.
    SELECT "condition_decision" INTO v_condition_decision
    FROM "rma_request"
    WHERE "id" = NEW."rma_id"
    FOR SHARE;

    IF v_condition_decision IS DISTINCT FROM 'accepted' THEN
        RAISE EXCEPTION
            'rma remedy for rma_request %: a remedy may only be created for an RMA whose item condition was ACCEPTED at inspection (condition_decision = ''accepted''); found %',
            NEW."rma_id",
            COALESCE(v_condition_decision::text, 'NULL (not yet received/inspected)')
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rma_remedy_requires_accepted_inspection
    BEFORE INSERT ON "rma_remedy"
    FOR EACH ROW EXECUTE FUNCTION rma_remedy_requires_accepted_inspection();

-- FINDING re: the UPDATE path (reported per architect's request, not fixed
-- here -- out of this migration's bounded scope; see handoff).
--
-- Could `rma_request.condition_decision` flip from 'accepted' to 'rejected'
-- AFTER a remedy row already exists, undermining this trigger after the
-- fact? `rma_request_guard` (migration 20260926010000) makes `window_kind`,
-- `calendar_days_since_delivery`, the eligible-amount snapshot, and
-- `received_at` immutable once set, but does NOT do the same for
-- `condition_decision`. The status transition table blocks most routes
-- (e.g. `inspection_passed` has no edge back to `inspection_failed`, so a
-- coordinated status+decision flip is refused), but
-- `rma_request_condition_decision_status_coherent`
-- (migration 20260926010000) still permits BOTH `condition_decision =
-- 'accepted'` and `condition_decision = 'rejected'` at `status = 'resolved'`
-- or `'closed'` -- so a raw
-- `UPDATE rma_request SET condition_decision = 'rejected', ... WHERE status
-- IN ('resolved', 'closed')` on an already-resolved/closed RMA passes every
-- existing CHECK and trigger unchanged. This does not let anyone create a
-- SECOND remedy or move money without approval (this trigger only fires on
-- INSERT, and `@@unique([rmaId])` still caps the RMA at one remedy row), but
-- it does corrupt the historical inspection-decision fact for an RMA whose
-- remedy has already been decided/paid, which is the same "historical fact,
-- never revised" property `received_at` already gets. Fixing this would mean
-- adding `condition_decision` immutability-once-set to `rma_request_guard`
-- itself (the trigger function that already owns that exact discipline) --
-- a change to a different, already-relied-upon trigger, which is out of
-- this migration's bounded "add one BEFORE INSERT trigger on rma_remedy"
-- scope. Flagged for architect review; not implemented here.
