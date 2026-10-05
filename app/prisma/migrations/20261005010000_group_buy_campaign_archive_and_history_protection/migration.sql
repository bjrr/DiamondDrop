-- Group Buy campaign archiving, and the history protection that must land
-- BEFORE anything relaxes deletion (owner-locked ordering, 2026-10-05).
--
-- HAND-AUTHORED, following this repo's established escalation path: no local
-- dev database is reachable from this environment to run `prisma migrate dev`,
-- and `migrate reset` / a shadow-database `migrate diff` are both forbidden.
-- Written by hand in this repo's conventions; applied with `migrate deploy`.
--
-- ============================================================================
-- WHY THIS MIGRATION DOES *NOT* TOUCH group_buy_frozen_child_guard
-- ============================================================================
-- That guard currently refuses to delete ANY campaign, including an empty
-- draft, because on a cascading delete it looks up the parent's status, finds
-- the row already gone, reads NULL, and treats NULL as "not draft".
--
-- Fixing it is desirable and is deliberately NOT done here. The owner locked
-- the ordering: the history protection below must land and be verified first.
-- If the guard were relaxed in the same deploy — or an earlier one — there
-- would be a window in which a campaign carrying orders, units,
-- acknowledgments, settlements or refunds became deletable. A window like that
-- is measured in minutes and the damage is permanent, so the sequencing is a
-- safety property, not a preference.
--
-- Net effect of this migration alone: deletion remains impossible (the old
-- guard still refuses), and now it is impossible for TWO independent reasons
-- whenever history exists. The second reason is the one that will still hold
-- after the first is relaxed.

-- ---------------------------------------------------------------------------
-- 1. Archiving: an annotation, with a mandatory reason.
-- ---------------------------------------------------------------------------
ALTER TABLE "group_buy_campaign" ADD COLUMN "archived_at" TIMESTAMPTZ(6);
ALTER TABLE "group_buy_campaign" ADD COLUMN "archived_by" TEXT;
ALTER TABLE "group_buy_campaign" ADD COLUMN "archive_reason" TEXT;

-- ALL THREE OR NONE, and the reason must carry actual content. A half-recorded
-- archive ("hidden, by nobody, for no stated reason") is precisely the state
-- the owner's decision exists to prevent: whoever finds it later cannot tell
-- whether it was deliberate.
ALTER TABLE "group_buy_campaign" ADD CONSTRAINT "group_buy_campaign_archive_complete" CHECK (
    (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
    OR (
      archived_at IS NOT NULL
      AND archived_by IS NOT NULL AND btrim(archived_by) <> ''
      AND archive_reason IS NOT NULL AND btrim(archive_reason) <> ''
    )
);

-- Archived campaigns are excluded from operational listings, which read by
-- status; this keeps that filter cheap as the table grows.
CREATE INDEX "group_buy_campaign_archived_at_idx" ON "group_buy_campaign"("archived_at");

-- ---------------------------------------------------------------------------
-- 2. HISTORY PROTECTION. A campaign carrying evidence cannot be deleted.
-- ---------------------------------------------------------------------------
-- IN THE DATABASE, NOT ONLY IN APPLICATION CODE. A repository pre-check is
-- useful for telling a human WHAT exists, but it is bypassed by an admin
-- script, a future repository function, a psql session, or a migration written
-- in a hurry. For a destructive operation on money-adjacent evidence, the
-- backstop has to be somewhere none of those can route around.
--
-- TIERS AND VARIANTS ARE NOT HISTORY. A draft created by mistake legitimately
-- has both — they are configuration. Counting them would make the one case
-- deletion exists for (remove a mistaken draft) impossible, which is how a
-- safety rule gets disabled wholesale by the first person it inconveniences.
--
-- ACKNOWLEDGMENTS AND CANCELLATION CHECKS ARE MATCHED BY `campaign_ref`, the
-- campaign CODE, because that is how those tables reference a campaign — there
-- is no foreign key to follow. Matching on the wrong column would silently
-- count zero and let a campaign with real customer acknowledgments through.
CREATE OR REPLACE FUNCTION group_buy_campaign_delete_requires_no_history()
RETURNS TRIGGER AS $$
DECLARE
    unit_events      bigint;
    refunds          bigint;
    bank_orders      bigint;
    acknowledgments  bigint;
    cancel_checks    bigint;
    found_history    text[] := ARRAY[]::text[];
BEGIN
    SELECT count(*) INTO unit_events
      FROM group_buy_unit_event WHERE campaign_id = OLD.id;
    SELECT count(*) INTO refunds
      FROM group_buy_refund WHERE campaign_id = OLD.id;
    SELECT count(*) INTO bank_orders
      FROM group_buy_bank_payment_order WHERE campaign_id = OLD.id;
    SELECT count(*) INTO acknowledgments
      FROM acknowledgment WHERE campaign_ref = OLD.code;
    SELECT count(*) INTO cancel_checks
      FROM group_buy_order_cancellation_check WHERE campaign_ref = OLD.code;

    -- NAMES WHAT EXISTS, not merely that something does. "deletion failed"
    -- sends someone hunting; "3 qualifying unit events, 1 acknowledgment"
    -- lets them decide immediately whether archiving is what they wanted.
    IF unit_events > 0 THEN
        found_history := found_history || format('%s qualifying unit event(s)', unit_events);
    END IF;
    IF refunds > 0 THEN
        found_history := found_history || format('%s refund(s)', refunds);
    END IF;
    IF bank_orders > 0 THEN
        found_history := found_history || format('%s bank payment order(s)', bank_orders);
    END IF;
    IF acknowledgments > 0 THEN
        found_history := found_history || format('%s acknowledgment(s)', acknowledgments);
    END IF;
    IF cancel_checks > 0 THEN
        found_history := found_history || format('%s cancellation check(s)', cancel_checks);
    END IF;

    IF array_length(found_history, 1) > 0 THEN
        RAISE EXCEPTION
            'campaign % (%) carries historical evidence and cannot be deleted: %. Archive it instead.',
            OLD.code, OLD.id, array_to_string(found_history, ', ')
            USING ERRCODE = '23001'; -- restrict_violation
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER group_buy_campaign_no_delete_with_history
    BEFORE DELETE ON "group_buy_campaign"
    FOR EACH ROW EXECUTE FUNCTION group_buy_campaign_delete_requires_no_history();
