-- Slice 2 stage 2A, M3 + M4 column
-- (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §6, owner §3.1,
-- criteria 17-19).
--
-- pricing_input_change is the owner's "any persisted change to a
-- price-affecting input triggers immediate recalculation" record (§3.1) AND
-- the grouping key criterion 11's bulk-approval action resolves a set of
-- price_sync_intent rows from: every price_recalculation_run sharing one
-- pricing_input_change_id was caused by the SAME underlying edit, so every
-- intent descending from those runs can be approved in one action.
--
-- The `input_change` trigger value is added here but not compared against
-- in this transaction -- see 20260919084408's header for why, and see the
-- follow-up migration for the CHECK constraint that does compare against it.

-- CreateEnum
CREATE TYPE "pricing_input_change_kind" AS ENUM ('metal_reference_price', 'stone_cost', 'cost_component', 'labor_rate', 'pricing_profile', 'ring_size_band', 'variant_weight_override', 'master_variant_stone', 'master_variant', 'master_product', 'manual');

-- AlterEnum
ALTER TYPE "price_recalculation_trigger" ADD VALUE 'input_change';

-- AlterTable
ALTER TABLE "price_recalculation_run" ADD COLUMN     "pricing_input_change_id" UUID;

-- CreateTable
CREATE TABLE "pricing_input_change" (
    "id" UUID NOT NULL,
    "kind" "pricing_input_change_kind" NOT NULL,
    "entity_id" TEXT,
    "changed_by" TEXT,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_input_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_input_change_kind_changed_at_idx" ON "pricing_input_change"("kind", "changed_at");

-- AddForeignKey
ALTER TABLE "price_recalculation_run" ADD CONSTRAINT "price_recalculation_run_pricing_input_change_id_fkey" FOREIGN KEY ("pricing_input_change_id") REFERENCES "pricing_input_change"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- price_recalculation_run_completion_only (migration 20260917072310) already
-- refuses to change `trigger`, `triggered_by`, `reason` or `as_of` on an
-- update -- "all of which would let a past run be retold as something it was
-- not". `pricing_input_change_id` is exactly that kind of fact and must join
-- the same immutable list, or a run's recorded cause could be silently
-- repointed after the fact. CREATE OR REPLACE, reusing the existing function
-- name and trigger binding rather than adding a second trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION price_recalculation_run_completion_only()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.finished_at IS NOT NULL THEN
        RAISE EXCEPTION
            'price_recalculation_run % is already finished and cannot be modified',
            OLD.id
            USING ERRCODE = '23001'; -- restrict_violation
    END IF;

    IF NEW.id                      IS DISTINCT FROM OLD.id
    OR NEW.trigger                 IS DISTINCT FROM OLD.trigger
    OR NEW.triggered_by            IS DISTINCT FROM OLD.triggered_by
    OR NEW.reason                  IS DISTINCT FROM OLD.reason
    OR NEW.as_of                   IS DISTINCT FROM OLD.as_of
    OR NEW.started_at              IS DISTINCT FROM OLD.started_at
    OR NEW.pricing_input_change_id IS DISTINCT FROM OLD.pricing_input_change_id THEN
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
