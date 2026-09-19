-- Raised by the QA and security review of Slice 1 (T10), finding 1.
--
-- `group_buy_campaign_guard()` blocked two things: returning to `draft`, and
-- editing the frozen pricing basis or the locked final count. It did NOT block
-- `closed -> open`, `cancelled -> open`, or `open -> cancelled -> open`.
--
-- WHY THAT MATTERS EVEN THOUGH NO CODE CAN DO IT. The trigger's own comment
-- says its purpose is to survive "a careless script, or a manual UPDATE run at
-- 2am" — and reopening a settled campaign is exactly the transition that
-- escaped it. `openGroupBuyCampaign` only accepts draft->open and
-- `closeGroupBuyCampaign` only open->closed, so application code cannot reach
-- it today; a guard that only holds while the application is well-behaved is
-- not the guard this table was given.
--
-- WHAT REOPENING WOULD DO. `recordUnitEvent` gates on the campaign being open,
-- so a reopened campaign would start accepting new qualifying units. The final
-- count and tier are separately locked, so the settled TIER could not move —
-- but the App Proxy would resume serving live progress for a campaign that had
-- already settled, and the ledger would accumulate units after close that no
-- refund calculation would ever see. Confusing rather than directly
-- exploitable, which is why this is hardening and not a fix.
--
-- An explicit allowed-transition table replaces the two ad-hoc checks. Stating
-- what IS permitted, rather than enumerating what is not, is what makes a
-- future status value fail closed: add one to the enum without adding it here
-- and every transition involving it is rejected until someone decides what it
-- should do.

CREATE OR REPLACE FUNCTION group_buy_campaign_guard()
RETURNS TRIGGER AS $$
BEGIN
    -- The frozen pricing basis is immutable from the moment the campaign opens.
    IF OLD.status <> 'draft' THEN
        IF NEW.pricing_profile_id IS DISTINCT FROM OLD.pricing_profile_id
        OR NEW.profile_version    IS DISTINCT FROM OLD.profile_version
        OR NEW.snapshot_id        IS DISTINCT FROM OLD.snapshot_id
        OR NEW.frozen_as_of       IS DISTINCT FROM OLD.frozen_as_of
        OR NEW.currency           IS DISTINCT FROM OLD.currency
        OR NEW.opened_at          IS DISTINCT FROM OLD.opened_at THEN
            RAISE EXCEPTION
                'campaign % is %: its frozen pricing basis cannot be changed',
                OLD.id, OLD.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    -- Returning to draft keeps its own diagnostic, checked first. It is the
    -- transition someone is most likely to attempt by hand — "let me just put
    -- it back and re-open it" — and "cannot return to draft once opened" tells
    -- them why, where the generic message below would only tell them no.
    IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
        RAISE EXCEPTION 'campaign % cannot return to draft once opened', OLD.id
            USING ERRCODE = '23001';
    END IF;

    -- THE ALLOWED TRANSITIONS, exhaustively. Anything absent is refused.
    --
    --   draft -> open       publication, after tier safety and the price ladder
    --   open  -> closed     settlement; locks the final count and tier
    --   open  -> cancelled  withdrawn while live
    --
    -- `draft -> cancelled` is deliberately NOT here. The existing
    -- `group_buy_campaign_open_is_frozen` CHECK already requires any non-draft
    -- campaign to carry a frozen pricing basis, and a draft has none — so the
    -- database refuses it either way. Listing it as allowed would state a
    -- capability the schema does not have. An unopened campaign nobody has
    -- joined is deleted, not cancelled.
    --
    -- Notably absent, and now impossible: reopening a `closed` or `cancelled`
    -- campaign, and any transition out of a terminal state. A no-op update
    -- (status unchanged) is permitted, since that is how every other column on
    -- this row is edited.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'draft' AND NEW.status = 'open')
            OR (OLD.status = 'open'  AND NEW.status IN ('closed', 'cancelled'))
        ) THEN
            RAISE EXCEPTION
                'campaign %: % -> % is not an allowed status transition',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    -- The close lock: once a final count exists it is the settled fact every
    -- refund is computed from.
    IF OLD.final_qualifying_units IS NOT NULL
       AND (NEW.final_qualifying_units IS DISTINCT FROM OLD.final_qualifying_units
            OR NEW.final_tier_number IS DISTINCT FROM OLD.final_tier_number) THEN
        RAISE EXCEPTION
            'campaign %: the final unit count and tier are locked at close and cannot be changed',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
