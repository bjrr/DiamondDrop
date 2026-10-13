-- CreateTable
CREATE TABLE "price_override" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "price_calculation_id" UUID,
    "override_price_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "breached_floors" JSONB NOT NULL,
    "warning_shown" TEXT,
    "reason" TEXT NOT NULL,
    "overridden_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_override_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_override_master_variant_id_created_at_idx" ON "price_override"("master_variant_id", "created_at");

-- AddForeignKey
ALTER TABLE "price_override" ADD CONSTRAINT "price_override_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_override" ADD CONSTRAINT "price_override_price_calculation_id_fkey" FOREIGN KEY ("price_calculation_id") REFERENCES "price_calculation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An override is evidence of a deliberate departure from a calculated price.
-- Append-only for the same reason as the other evidence tables: the record of
-- who overrode a price, what they were warned about and why they did it must
-- survive a later bug, a careless script, or someone who would rather it read
-- differently.
CREATE TRIGGER price_override_no_update
    BEFORE UPDATE ON "price_override"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER price_override_no_delete
    BEFORE DELETE ON "price_override"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- A reason is required by D14, and an empty string is not a reason. The NOT
-- NULL constraint alone would accept ''.
ALTER TABLE "price_override"
  ADD CONSTRAINT "price_override_reason_not_blank" CHECK (btrim(reason) <> '');

ALTER TABLE "price_override"
  ADD CONSTRAINT "price_override_actor_not_blank" CHECK (btrim(overridden_by) <> '');

-- A negative or zero override price is not a price. Overrides may breach the
-- MARGIN floors deliberately (that is the point), but they may not produce a
-- value that is not money.
ALTER TABLE "price_override"
  ADD CONSTRAINT "price_override_price_positive" CHECK (override_price_minor_units > 0);
