-- CreateEnum
CREATE TYPE "price_recalculation_trigger" AS ENUM ('scheduled', 'staff', 'metal_price_entry');

-- AlterTable
ALTER TABLE "price_sync_intent" ADD COLUMN     "delta_minor_units" BIGINT;

-- CreateTable
CREATE TABLE "price_recalculation_run" (
    "id" UUID NOT NULL,
    "trigger" "price_recalculation_trigger" NOT NULL,
    "triggered_by" TEXT,
    "reason" TEXT,
    "as_of" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "computed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "auto_apply" INTEGER NOT NULL DEFAULT 0,
    "needs_approval" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "price_recalculation_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_recalculation_run_trigger_started_at_idx" ON "price_recalculation_run"("trigger", "started_at");

-- D15. A run record is written when the run STARTS and completed when it
-- finishes, so a run that crashes still leaves evidence that it happened. That
-- needs exactly one UPDATE, which is why this table cannot reuse the blanket
-- prevent_evidence_mutation() trigger used by the pure evidence tables.
--
-- What this permits: setting finished_at and the counts, once, on a row where
-- finished_at IS NULL.
-- What it refuses: re-completing a finished run, rewriting what triggered a run
-- or who asked for it, and changing the as-of instant a run resolved against —
-- all of which would let a past run be retold as something it was not.
CREATE OR REPLACE FUNCTION price_recalculation_run_completion_only()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.finished_at IS NOT NULL THEN
        RAISE EXCEPTION
            'price_recalculation_run % is already finished and cannot be modified',
            OLD.id
            USING ERRCODE = '23001'; -- restrict_violation
    END IF;

    IF NEW.id           IS DISTINCT FROM OLD.id
    OR NEW.trigger      IS DISTINCT FROM OLD.trigger
    OR NEW.triggered_by IS DISTINCT FROM OLD.triggered_by
    OR NEW.reason       IS DISTINCT FROM OLD.reason
    OR NEW.as_of        IS DISTINCT FROM OLD.as_of
    OR NEW.started_at   IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION
            'price_recalculation_run %: only finished_at and the counts may be updated',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.finished_at IS NULL THEN
        RAISE EXCEPTION
            'price_recalculation_run %: an update must set finished_at',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER price_recalculation_run_completion_only
    BEFORE UPDATE ON "price_recalculation_run"
    FOR EACH ROW EXECUTE FUNCTION price_recalculation_run_completion_only();

-- Deletion is never legitimate: it would erase the record that a pricing run
-- ever took place.
CREATE TRIGGER price_recalculation_run_no_delete
    BEFORE DELETE ON "price_recalculation_run"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
