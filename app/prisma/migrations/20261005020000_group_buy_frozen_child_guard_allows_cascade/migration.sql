-- Let `group_buy_frozen_child_guard` recognise a cascading delete.
--
-- HAND-AUTHORED, same escalation path as the sibling migrations: no local dev
-- database is reachable here, and `migrate reset` / shadow-database
-- `migrate diff` are forbidden. Applied with `migrate deploy`.
--
-- ============================================================================
-- THE BUG
-- ============================================================================
-- The guard protects tiers and eligible-variant prices from being edited once
-- a campaign leaves draft. It resolves the campaign's status by SELECTing the
-- parent row:
--
--     SELECT status::text INTO campaign_status
--       FROM group_buy_campaign WHERE id = target_campaign;
--     IF campaign_status IS DISTINCT FROM 'draft' THEN RAISE ...
--
-- On a CASCADING delete the parent row is already gone by the time the child
-- rows are removed, so the SELECT matches nothing, `campaign_status` stays
-- NULL, and `NULL IS DISTINCT FROM 'draft'` is TRUE. The guard therefore
-- refused to delete the children of ANY campaign — including a completely
-- empty draft created by mistake, which is the one case deletion exists for.
--
-- Observed in production while building the live-gate fixtures:
--   campaign <id> is <NULL>, so its tiers and eligible-variant prices are
--   frozen (DELETE rejected)
-- The `<NULL>` where a status should be is the tell.
--
-- ============================================================================
-- WHY THIS IS SAFE *NOW* AND WOULD NOT HAVE BEEN BEFORE
-- ============================================================================
-- This relaxation is only safe because something else already refuses the
-- dangerous case. `group_buy_campaign_no_delete_with_history` (migration
-- 20261005010000) is a BEFORE DELETE trigger on `group_buy_campaign` that
-- counts dependent evidence — qualifying unit events, refunds, bank payment
-- orders, acknowledgments, cancellation checks — and raises if any exists.
--
-- Order of events on `DELETE FROM group_buy_campaign`:
--   1. BEFORE DELETE on the campaign runs the history check. Any evidence and
--      the whole statement aborts; no child row is touched.
--   2. Only if that passes does the parent row go, and only then do the
--      cascades fire and reach the guard below.
--
-- So "parent row absent" genuinely means "a delete that the history guard has
-- already authorised". Had this migration landed first — or in the same
-- deploy — there would have been a window in which a campaign carrying
-- orders, units and acknowledgments became deletable. The owner locked that
-- ordering, and it is a safety property rather than a preference: the window
-- is minutes and the damage is permanent.
--
-- THE HISTORY TRIGGER REMAINS THE AUTHORITATIVE BOUNDARY. This guard is about
-- freezing CONFIGURATION after open; it was never the thing protecting
-- evidence, and it must not be relied on as such.

CREATE OR REPLACE FUNCTION group_buy_frozen_child_guard()
RETURNS TRIGGER AS $$
DECLARE
    campaign_status text;
    target_campaign uuid;
BEGIN
    target_campaign := COALESCE(NEW.campaign_id, OLD.campaign_id);
    SELECT status::text INTO campaign_status
      FROM group_buy_campaign WHERE id = target_campaign;

    -- PARENT ALREADY GONE => CASCADING DELETE, already authorised upstream.
    -- Checked with FOUND rather than `campaign_status IS NULL`, because those
    -- are not the same question: `status` is NOT NULL, so a NULL here can only
    -- mean "no row matched", but saying so explicitly is what stops the next
    -- reader from re-introducing the original conflation.
    IF NOT FOUND THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF campaign_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION
            'campaign % is %, so its tiers and eligible-variant prices are frozen (% rejected)',
            target_campaign, campaign_status, TG_OP
            USING ERRCODE = '23001'; -- restrict_violation
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
