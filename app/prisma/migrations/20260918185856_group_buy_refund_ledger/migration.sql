-- CreateEnum
CREATE TYPE "group_buy_refund_status" AS ENUM ('pending', 'releasable', 'processing', 'issued', 'failed', 'not_owed');

-- CreateTable
CREATE TABLE "group_buy_refund" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "order_ref" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "customer_ref" TEXT,
    "paid_per_unit_minor_units" BIGINT NOT NULL,
    "final_per_unit_minor_units" BIGINT NOT NULL,
    "qualifying_units" INTEGER NOT NULL,
    "refund_amount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "group_buy_refund_status" NOT NULL DEFAULT 'pending',
    "processor_reference" TEXT,
    "failure_reason" TEXT,
    "override_by" TEXT,
    "override_reason" TEXT,
    "override_at" TIMESTAMPTZ(6),
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_buy_refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_buy_refund_event" (
    "id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "from_status" "group_buy_refund_status",
    "to_status" "group_buy_refund_status" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_refund_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_buy_refund_campaign_id_status_idx" ON "group_buy_refund"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_refund_campaign_id_line_ref_key" ON "group_buy_refund"("campaign_id", "line_ref");

-- CreateIndex
CREATE INDEX "group_buy_refund_event_refund_id_created_at_idx" ON "group_buy_refund_event"("refund_id", "created_at");

-- AddForeignKey
ALTER TABLE "group_buy_refund" ADD CONSTRAINT "group_buy_refund_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "group_buy_campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_refund" ADD CONSTRAINT "group_buy_refund_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_refund_event" ADD CONSTRAINT "group_buy_refund_event_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "group_buy_refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The transition history is EVIDENCE (§173 "history"): append-only, so a
-- refund that failed twice before succeeding cannot be tidied into one that
-- worked first time.
CREATE TRIGGER group_buy_refund_event_no_update
    BEFORE UPDATE ON "group_buy_refund_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER group_buy_refund_event_no_delete
    BEFORE DELETE ON "group_buy_refund_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- Money never moves backwards and units are whole pieces.
ALTER TABLE "group_buy_refund"
  ADD CONSTRAINT "group_buy_refund_amounts_non_negative" CHECK (
    paid_per_unit_minor_units >= 0
    AND final_per_unit_minor_units >= 0
    AND refund_amount_minor_units >= 0
    AND qualifying_units >= 0
  );

-- The stored amount must equal the stored inputs, floored at zero.
--
-- Belt and braces over the domain function, and worth the duplication: this
-- column is what gets paid. A bug that computed it correctly and then wrote the
-- wrong value would be invisible in every unit test of the calculation, because
-- the calculation would be right.
ALTER TABLE "group_buy_refund"
  ADD CONSTRAINT "group_buy_refund_amount_matches_inputs" CHECK (
    refund_amount_minor_units =
      GREATEST(paid_per_unit_minor_units - final_per_unit_minor_units, 0) * qualifying_units
  );

-- An issued refund must say where the money went; a failed one must say why.
ALTER TABLE "group_buy_refund"
  ADD CONSTRAINT "group_buy_refund_issued_has_reference" CHECK (
    status <> 'issued'
    OR (processor_reference IS NOT NULL AND btrim(processor_reference) <> '' AND issued_at IS NOT NULL)
  );

ALTER TABLE "group_buy_refund"
  ADD CONSTRAINT "group_buy_refund_failed_has_reason" CHECK (
    status <> 'failed' OR (failure_reason IS NOT NULL AND btrim(failure_reason) <> '')
  );

-- Released means shipped. A refund cannot be past the hold without recording
-- when the hold ended — that timestamp is the audit trail for the owner's
-- "hold through QC, process at shipping" rule.
ALTER TABLE "group_buy_refund"
  ADD CONSTRAINT "group_buy_refund_released_has_timestamp" CHECK (
    status IN ('pending', 'not_owed') OR released_at IS NOT NULL
  );

-- An override is an attributed exception; it cannot be half-recorded.
ALTER TABLE "group_buy_refund"
  ADD CONSTRAINT "group_buy_refund_override_complete" CHECK (
    (override_by IS NULL AND override_reason IS NULL AND override_at IS NULL)
    OR (override_by IS NOT NULL AND btrim(override_by) <> ''
        AND override_reason IS NOT NULL AND btrim(override_reason) <> ''
        AND override_at IS NOT NULL)
  );

-- ISSUED IS TERMINAL, enforced at the database.
--
-- §371: "Duplicate/retried refund ... must not create duplicate customer
-- value." The domain's transition table already refuses it, but this is the
-- guarantee that survives a script, a retry loop, or a future caller that
-- forgets to go through the service. Once the money has gone out, the row
-- cannot be moved back into a payable state.
CREATE OR REPLACE FUNCTION group_buy_refund_issued_is_terminal()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'issued' AND NEW.status <> 'issued' THEN
        RAISE EXCEPTION
            'refund % is already issued; it cannot be moved to % (that would risk paying twice)',
            OLD.id, NEW.status
            USING ERRCODE = '23001';
    END IF;

    IF OLD.status = 'issued'
       AND (NEW.refund_amount_minor_units IS DISTINCT FROM OLD.refund_amount_minor_units
            OR NEW.processor_reference IS DISTINCT FROM OLD.processor_reference) THEN
        RAISE EXCEPTION
            'refund %: the amount and processor reference are settled once issued',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER group_buy_refund_issued_terminal
    BEFORE UPDATE ON "group_buy_refund"
    FOR EACH ROW EXECUTE FUNCTION group_buy_refund_issued_is_terminal();
