-- CreateEnum
CREATE TYPE "group_buy_unit_event_kind" AS ENUM ('purchased', 'cancelled', 'refunded');

-- AlterTable
ALTER TABLE "group_buy_campaign" ADD COLUMN     "final_qualifying_units" INTEGER,
ADD COLUMN     "final_tier_number" INTEGER;

-- CreateTable
CREATE TABLE "group_buy_unit_event" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "kind" "group_buy_unit_event_kind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "order_ref" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_unit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_buy_unit_event_campaign_id_line_ref_idx" ON "group_buy_unit_event"("campaign_id", "line_ref");

-- CreateIndex
CREATE INDEX "group_buy_unit_event_campaign_id_created_at_idx" ON "group_buy_unit_event"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_unit_event_campaign_id_external_ref_key" ON "group_buy_unit_event"("campaign_id", "external_ref");

-- AddForeignKey
ALTER TABLE "group_buy_unit_event" ADD CONSTRAINT "group_buy_unit_event_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "group_buy_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_unit_event" ADD CONSTRAINT "group_buy_unit_event_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The ledger is EVIDENCE: append-only, like every other history table here.
-- README §430 requires retaining qualifying-unit history and cancellations, and
-- a cancellation that can be edited away is not a record of anything. A
-- correction is a new compensating event, never an edit.
CREATE TRIGGER group_buy_unit_event_no_update
    BEFORE UPDATE ON "group_buy_unit_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER group_buy_unit_event_no_delete
    BEFORE DELETE ON "group_buy_unit_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- Quantity is always positive; direction comes from `kind`. A ledger that
-- encoded direction in both places could disagree with itself.
ALTER TABLE "group_buy_unit_event"
  ADD CONSTRAINT "group_buy_unit_event_quantity_positive" CHECK (quantity > 0);

ALTER TABLE "group_buy_unit_event"
  ADD CONSTRAINT "group_buy_unit_event_refs_not_blank"
  CHECK (btrim(order_ref) <> '' AND btrim(line_ref) <> '' AND btrim(external_ref) <> '');

-- The locked close values travel together: a campaign cannot be half-closed
-- with a unit count but no tier, or a tier reached by an unrecorded count.
ALTER TABLE "group_buy_campaign"
  ADD CONSTRAINT "group_buy_close_lock_complete" CHECK (
    (final_qualifying_units IS NULL AND final_tier_number IS NULL)
    OR (final_qualifying_units IS NOT NULL AND final_tier_number IS NOT NULL)
  );

ALTER TABLE "group_buy_campaign"
  ADD CONSTRAINT "group_buy_final_units_non_negative"
  CHECK (final_qualifying_units IS NULL OR final_qualifying_units >= 0);

-- Once locked, the final count and tier are immutable — that is what "lock"
-- means. Extends the existing frozen-basis guard rather than adding a second
-- trigger on the same table, so the ordering between them cannot surprise.
CREATE OR REPLACE FUNCTION group_buy_campaign_guard()
RETURNS TRIGGER AS $$
BEGIN
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

    IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
        RAISE EXCEPTION 'campaign % cannot return to draft once opened', OLD.id
            USING ERRCODE = '23001';
    END IF;

    -- The close lock.
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
