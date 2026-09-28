-- OWNER DECISION (late-window RMA approval gating, 2026-09-27,
-- docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md §4). "Do not automatically
-- issue money or store credit merely because the RMA was submitted or the
-- package was received." See `app/app/domain/rma/remedy.ts`'s header for the
-- full reasoning; this file states the mechanics.
--
-- Depends on the enum value added by the prior migration
-- (`20260927020000_rma_remedy_status_approved_enum_value`) -- split into two
-- migrations because `ALTER TYPE ... ADD VALUE` cannot be used in the same
-- transaction as a comparison against the new value (see that migration's
-- own comment).
--
-- TWO LAYERS, BOTH STRUCTURAL, NEITHER A ROUTE-LEVEL CHECK:
--   1. `rma_remedy_requires_approval_once_left_pending` — a same-row CHECK
--      constraint: no remedy may exist, via INSERT or UPDATE, in any status
--      other than `pending` without a recorded reviewer and timestamp. This
--      is the guarantee that survives a script, a raw SQL statement, or a
--      future caller that forgets to go through the repository -- the same
--      "belt and braces over the domain calculation" reasoning as
--      `rma_remedy_amount_matches_inputs`.
--   2. `rma_remedy_guard` — a BEFORE UPDATE trigger mirroring
--      `app/app/domain/rma/remedy.ts`'s `ALLOWED_REMEDY_TRANSITIONS` table
--      exactly (same discipline as `rma_request_guard` for the request state
--      machine). `processing` is reachable ONLY from `approved`, never from
--      `pending` -- so even a caller that supplies a syntactically valid
--      `approved_at`/`approved_by_actor_ref` out of band still cannot walk a
--      remedy from `pending` straight to `processing`/`issued` in one write.
--      Also makes `approved_at`/`approved_by_actor_ref` immutable once set,
--      the same "recorded fact, never revised" discipline as
--      `rma_request.received_at` in `rma_request_guard`.

-- AlterTable
ALTER TABLE "rma_remedy" ADD COLUMN "approved_at" TIMESTAMPTZ(6);
ALTER TABLE "rma_remedy" ADD COLUMN "approved_by_actor_ref" TEXT;

-- CHECK — the structural "issued without approval is impossible" guarantee.
ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_requires_approval_once_left_pending" CHECK (
    "status" = 'pending'
    OR (
        "approved_at" IS NOT NULL
        AND "approved_by_actor_ref" IS NOT NULL
        AND btrim("approved_by_actor_ref") <> ''
    )
);

-- rma_remedy_guard — the database-level mirror of
-- app/app/domain/rma/remedy.ts's ALLOWED_REMEDY_TRANSITIONS table. Same
-- fail-closed shape as rma_request_guard: allowed edges are stated
-- exhaustively, so an unrecognised status added later has no legal
-- transition into it until someone decides one. BEFORE UPDATE only;
-- application code is responsible for every INSERT starting at the
-- 'pending' default, and the CHECK constraint above independently guards
-- against an INSERT that tries to start anywhere else without approval
-- already recorded.
CREATE OR REPLACE FUNCTION rma_remedy_guard()
RETURNS TRIGGER AS $$
BEGIN
    -- approved_at/approved_by_actor_ref are recorded exactly once, by
    -- approveRmaRemedy, and never change or clear afterwards -- mirrors
    -- rma_request_guard's treatment of received_at.
    IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        RAISE EXCEPTION
            'rma remedy %: approved_at is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF OLD.approved_by_actor_ref IS NOT NULL AND NEW.approved_by_actor_ref IS DISTINCT FROM OLD.approved_by_actor_ref THEN
        RAISE EXCEPTION
            'rma remedy %: approved_by_actor_ref is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'pending'                   AND NEW.status = 'approved')
            OR (OLD.status = 'approved'                   AND NEW.status = 'processing')
            OR (OLD.status = 'processing'                 AND NEW.status IN ('issued', 'failed', 'staff_review_required'))
            OR (OLD.status = 'failed'                     AND NEW.status = 'processing')
            OR (OLD.status = 'staff_review_required'      AND NEW.status = 'processing')
        ) THEN
            RAISE EXCEPTION
                'rma remedy %: % -> % is not an allowed status transition',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rma_remedy_guard
    BEFORE UPDATE ON "rma_remedy"
    FOR EACH ROW EXECUTE FUNCTION rma_remedy_guard();
