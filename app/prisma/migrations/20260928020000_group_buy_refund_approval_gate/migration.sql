-- OWNER DECISION (Group Buy settlement approval gating, 2026-09-28):
-- "The system calculates refunds, admin explicitly approves/processes them."
-- Mirrors `20260927030000_rma_remedy_approval_gate`'s reasoning and shape
-- exactly, adapted for `group_buy_refund`, which already has its own status
-- enum/transition table (`app/domain/groupbuy/refunds.ts`) that this
-- migration does NOT alter — that domain file is out of this task's scope.
-- Approval is layered ON TOP of the existing `releasable -> processing`
-- transition as an independent, structural precondition rather than a new
-- enum value, so the domain's transition table stays exactly as it is and
-- still correctly describes which STATE SHAPES are legal; this migration
-- additionally requires that a row may never REACH `processing` or `issued`
-- without a recorded reviewer and timestamp.
--
-- TWO LAYERS, NEITHER A ROUTE-LEVEL CHECK:
--   1. `group_buy_refund_requires_approval_before_processing` — a same-row
--      CHECK constraint: no refund may exist, via INSERT or UPDATE, in
--      `processing` or `issued` without `approved_at`/`approved_by_actor_ref`
--      recorded. Survives a script, a raw SQL statement, or a future caller
--      that forgets to go through `approveGroupBuyRefund` first — the same
--      "belt and braces" reasoning as `group_buy_refund_amount_matches_inputs`.
--   2. `group_buy_refund_approval_guard` — a BEFORE UPDATE trigger making
--      `approved_at`/`approved_by_actor_ref` write-once: recorded exactly
--      once by `approveGroupBuyRefund` and never cleared or changed
--      afterwards, the same "recorded fact, never revised" discipline as
--      `rma_remedy_guard`'s treatment of `approved_at`/`approved_by_actor_ref`.

-- AlterTable
ALTER TABLE "group_buy_refund" ADD COLUMN "approved_at" TIMESTAMPTZ(6);
ALTER TABLE "group_buy_refund" ADD COLUMN "approved_by_actor_ref" TEXT;

-- CHECK — the structural "issued without approval is impossible" guarantee.
ALTER TABLE "group_buy_refund" ADD CONSTRAINT "group_buy_refund_requires_approval_before_processing" CHECK (
    "status" NOT IN ('processing', 'issued')
    OR (
        "approved_at" IS NOT NULL
        AND "approved_by_actor_ref" IS NOT NULL
        AND btrim("approved_by_actor_ref") <> ''
    )
);

-- Write-once approval facts — mirrors rma_remedy_guard's identical clauses.
CREATE OR REPLACE FUNCTION group_buy_refund_approval_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        RAISE EXCEPTION
            'group buy refund %: approved_at is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF OLD.approved_by_actor_ref IS NOT NULL AND NEW.approved_by_actor_ref IS DISTINCT FROM OLD.approved_by_actor_ref THEN
        RAISE EXCEPTION
            'group buy refund %: approved_by_actor_ref is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER group_buy_refund_approval_guard
    BEFORE UPDATE ON "group_buy_refund"
    FOR EACH ROW EXECUTE FUNCTION group_buy_refund_approval_guard();
