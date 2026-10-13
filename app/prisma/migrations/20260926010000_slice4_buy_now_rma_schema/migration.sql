-- Slice 4 (docs/specs/SLICE-4-BUY-NOW-RMA.md, docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md).
--
-- HAND-AUTHORED per this repo's established escalation path: `prisma migrate
-- dev --create-only` refused with the known benign checksum mismatch on
-- `20260922060000_bank_payment_verified_by_authenticated_identity` (wants a
-- full "public" schema reset). `migrate reset` and a shadow-database
-- `migrate diff` are both forbidden here. This file is written by hand, in
-- this repo's established conventions, and is applied with `migrate deploy`
-- only. Verified afterwards with `prisma migrate diff --from-schema-datasource
-- prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma` reporting
-- no difference (see handoff for the actual command output).
--
-- rma_request (window/eligibility/remedy-choice/deadlines/receipt/condition),
-- rma_event (append-only), rma_remedy (idempotent by unique constraint,
-- criteria 196/204). See each table/column's doc comment in schema.prisma
-- for full reasoning; this file states the mechanics.
--
-- The state machine (criterion 200) is enforced at TWO layers, both derived
-- from the same transition table -- see app/domain/rma/status.ts for the
-- pure function this migration's rma_request_guard trigger mirrors. Changing
-- one without the other is a bug, same discipline as warranty_claim_guard
-- (migration 20260925010000_slice5_warranty_claims_schema).

-- CreateEnum
CREATE TYPE "rma_window_kind" AS ENUM ('standard', 'late');

-- CreateEnum
CREATE TYPE "rma_reason_category" AS ENUM (
    'buyer_remorse',
    'size_fit',
    'style_preference',
    'alleged_defect',
    'wrong_item_or_specification',
    'transit_damage',
    'materially_not_as_described',
    'other'
);

-- CreateEnum
CREATE TYPE "rma_remedy_kind" AS ENUM ('refund_original_payment', 'merchandise_credit');

-- CreateEnum
CREATE TYPE "rma_condition_decision" AS ENUM ('accepted', 'rejected');

-- CreateEnum
CREATE TYPE "rma_status" AS ENUM (
    'submitted',
    'approved',
    'denied',
    'return_shipped',
    'expired',
    'received_inspection_pending',
    'inspection_passed',
    'inspection_failed',
    'remedy_in_progress',
    'resolved',
    'closed'
);

-- CreateEnum
CREATE TYPE "rma_remedy_status" AS ENUM ('pending', 'processing', 'issued', 'failed', 'staff_review_required');

-- CreateTable — M-rma-request
CREATE TABLE "rma_request" (
    "id" UUID NOT NULL,
    "rma_reference" TEXT NOT NULL,

    "order_ref" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "customer_ref" TEXT,

    "master_variant_id" UUID,
    "item_configuration_description" TEXT NOT NULL,

    "purchaser_email" TEXT NOT NULL,

    "carrier_confirmed_delivery_date" DATE NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calendar_days_since_delivery" INTEGER NOT NULL,

    "reason_category" "rma_reason_category" NOT NULL,
    "reason_explanation" TEXT NOT NULL,

    "requested_remedy_kind" "rma_remedy_kind",

    "confirms_unworn_beyond_inspection" BOOLEAN NOT NULL,
    "confirms_undamaged" BOOLEAN NOT NULL,
    "confirms_unaltered_after_delivery" BOOLEAN NOT NULL,
    "confirms_original_packaging_included" BOOLEAN NOT NULL,

    "is_personalized_or_altered" BOOLEAN NOT NULL,
    "has_product_specific_return_override" BOOLEAN NOT NULL DEFAULT false,

    "return_policy_acknowledgment_id" UUID NOT NULL,

    "status" "rma_status" NOT NULL DEFAULT 'submitted',

    "window_kind" "rma_window_kind" NOT NULL,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_actor_ref" TEXT,
    "eligible_merchandise_amount_minor_units" BIGINT NOT NULL,
    "eligible_merchandise_amount_currency" CHAR(3) NOT NULL,
    "receive_by_deadline" DATE,

    "denied_at" TIMESTAMPTZ(6),
    "denied_by_actor_ref" TEXT,
    "denial_reason" TEXT,

    "return_tracking_carrier" TEXT,
    "return_tracking_number" TEXT,
    "return_insurance_reference" TEXT,
    "return_insured_value_minor_units" BIGINT,
    "return_insured_value_currency" CHAR(3),
    "return_shipped_at" TIMESTAMPTZ(6),

    "expired_at" TIMESTAMPTZ(6),

    "received_at" TIMESTAMPTZ(6),
    "package_condition" TEXT,
    "item_condition" TEXT,
    "inspection_notes" TEXT,
    "inspected_by_actor_ref" TEXT,

    "condition_decision" "rma_condition_decision",
    "condition_decision_reason" TEXT,
    "condition_decided_at" TIMESTAMPTZ(6),
    "condition_decided_by_actor_ref" TEXT,

    "manual_override_reason" TEXT,
    "manual_override_by_actor_ref" TEXT,

    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rma_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable — append-only
CREATE TABLE "rma_event" (
    "id" UUID NOT NULL,
    "rma_id" UUID NOT NULL,

    "from_status" "rma_status",
    "to_status" "rma_status" NOT NULL,

    "actor_type" "actor_type" NOT NULL,
    "actor_ref" TEXT,
    "reason" TEXT,
    "metadata" JSONB,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rma_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable — the remedy execution record
CREATE TABLE "rma_remedy" (
    "id" UUID NOT NULL,
    "rma_id" UUID NOT NULL,

    "kind" "rma_remedy_kind" NOT NULL,
    "status" "rma_remedy_status" NOT NULL DEFAULT 'pending',

    "eligible_merchandise_amount_minor_units" BIGINT NOT NULL,
    "merchandise_amount_minor_units" BIGINT NOT NULL,
    "restocking_fee_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    "shopify_tax_adjustment_minor_units" BIGINT,
    "actual_refund_or_credit_minor_units" BIGINT,

    "processor_reference" TEXT,
    "failure_reason" TEXT,
    "staff_review_reason" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "issued_at" TIMESTAMPTZ(6),

    CONSTRAINT "rma_remedy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rma_request_rma_reference_key" ON "rma_request"("rma_reference");
CREATE INDEX "rma_request_order_ref_idx" ON "rma_request"("order_ref");
CREATE INDEX "rma_request_status_idx" ON "rma_request"("status");
CREATE INDEX "rma_request_customer_ref_idx" ON "rma_request"("customer_ref");
CREATE INDEX "rma_request_master_variant_id_idx" ON "rma_request"("master_variant_id");

-- CreateIndex
CREATE INDEX "rma_event_rma_id_created_at_idx" ON "rma_event"("rma_id", "created_at");

-- CreateIndex — criterion 196/204: at most one remedy row per RMA.
CREATE UNIQUE INDEX "rma_remedy_rma_id_key" ON "rma_remedy"("rma_id");

-- AddForeignKey
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_return_policy_acknowledgment_id_fkey" FOREIGN KEY ("return_policy_acknowledgment_id") REFERENCES "acknowledgment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rma_event" ADD CONSTRAINT "rma_event_rma_id_fkey" FOREIGN KEY ("rma_id") REFERENCES "rma_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_rma_id_fkey" FOREIGN KEY ("rma_id") REFERENCES "rma_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK — criterion 188: the customer's remedy choice exists if and only if
-- the window is late (policy §4). Standard-window requests have no choice.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_requested_remedy_coherent" CHECK (
    ("window_kind" = 'late' AND "requested_remedy_kind" IS NOT NULL)
    OR ("window_kind" = 'standard' AND "requested_remedy_kind" IS NULL)
);

-- CHECK — criterion 191: money is never negative before it even reaches the
-- remedy row.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_eligible_amount_non_negative" CHECK (
    "eligible_merchandise_amount_minor_units" >= 0
);

-- CHECK — an approval-or-later status requires the approval facts to exist;
-- submitted/denied requires them absent. Mirrors
-- warranty_claim_decision_requires_receipt's "gate a whole class of statuses
-- on one recorded fact" shape.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_deadline_requires_approval" CHECK (
    (
        "status" IN ('submitted', 'denied')
        AND "approved_at" IS NULL
        AND "receive_by_deadline" IS NULL
    )
    OR (
        "status" NOT IN ('submitted', 'denied')
        AND "approved_at" IS NOT NULL
        AND "receive_by_deadline" IS NOT NULL
    )
);

-- CHECK — criterion 180/181's denial reason. Mirrors
-- warranty_claim_denial_requires_reason.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_denial_requires_reason" CHECK (
    "status" <> 'denied'
    OR ("denial_reason" IS NOT NULL AND length(trim("denial_reason")) > 0 AND "denied_at" IS NOT NULL)
);

-- CHECK — criterion 202: a condition decision cannot exist without a status
-- that has actually reached (or passed) a decided state, in both directions.
-- Mirrors warranty_claim_coverage_decision_status_coherent.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_condition_decision_status_coherent" CHECK (
    (
        "condition_decision" = 'accepted'
        AND "status" IN ('inspection_passed', 'remedy_in_progress', 'resolved', 'closed')
    )
    OR (
        "condition_decision" = 'rejected'
        AND "status" IN ('inspection_failed', 'resolved', 'closed')
    )
    OR (
        "condition_decision" IS NULL
        AND "status" NOT IN ('inspection_passed', 'inspection_failed', 'remedy_in_progress', 'resolved', 'closed')
    )
);

-- CHECK — criterion 202, independent of rma_request_guard (which only fires
-- BEFORE UPDATE): no row, inserted or updated, may sit in a decided-or-later
-- status without a recorded receipt.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_decision_requires_receipt" CHECK (
    "status" NOT IN ('inspection_passed', 'inspection_failed', 'remedy_in_progress', 'resolved', 'closed')
    OR "received_at" IS NOT NULL
);

-- CHECK — criterion 202: a rejected condition decision without a reason is
-- not a valid state.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_condition_rejection_requires_reason" CHECK (
    "condition_decision" IS DISTINCT FROM 'rejected'
    OR ("condition_decision_reason" IS NOT NULL AND length(trim("condition_decision_reason")) > 0)
);

-- CHECK — criterion 198: return-shipment insured value is money, present
-- together or absent together with its currency. Mirrors
-- shipment_insured_value_coherent.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_return_insured_value_coherent" CHECK (
    ("return_insured_value_minor_units" IS NULL AND "return_insured_value_currency" IS NULL)
    OR ("return_insured_value_minor_units" IS NOT NULL AND "return_insured_value_currency" IS NOT NULL)
);

-- CHECK — a manual override is an attributed exception; it cannot be
-- half-recorded. Mirrors group_buy_refund_override_complete.
ALTER TABLE "rma_request" ADD CONSTRAINT "rma_request_manual_override_complete" CHECK (
    ("manual_override_reason" IS NULL AND "manual_override_by_actor_ref" IS NULL)
    OR ("manual_override_reason" IS NOT NULL AND length(trim("manual_override_reason")) > 0
        AND "manual_override_by_actor_ref" IS NOT NULL AND length(trim("manual_override_by_actor_ref")) > 0)
);

-- CHECK — criteria 189-191: money never negative, and the stored remedy
-- amount is checked against its own recorded inputs, independent of the
-- domain function that computed it. Belt and braces over the domain
-- calculation, same reasoning as group_buy_refund_amount_matches_inputs:
-- "this column is what gets paid."
ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_amounts_non_negative" CHECK (
    "eligible_merchandise_amount_minor_units" >= 0
    AND "merchandise_amount_minor_units" >= 0
    AND "restocking_fee_minor_units" >= 0
);

ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_amount_matches_inputs" CHECK (
    "merchandise_amount_minor_units" + "restocking_fee_minor_units" = "eligible_merchandise_amount_minor_units"
);

-- CHECK — criterion 186: a restocking fee only ever applies to the
-- late-window refund-to-original-payment choice; the 100%-credit choice and
-- the standard-window 100% refund both always carry a zero fee.
ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_restocking_fee_only_for_refund_kind" CHECK (
    "restocking_fee_minor_units" = 0 OR "kind" = 'refund_original_payment'
);

-- CHECK — an issued remedy must say where the money/credit went; a failed
-- one must say why; staff_review_required must say why (criterion 194,
-- D7's fail-closed instruction). Mirrors group_buy_refund_issued_has_reference
-- / group_buy_refund_failed_has_reason.
ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_issued_has_reference" CHECK (
    "status" <> 'issued'
    OR (
        "processor_reference" IS NOT NULL AND btrim("processor_reference") <> ''
        AND "issued_at" IS NOT NULL
        AND "actual_refund_or_credit_minor_units" IS NOT NULL
    )
);

ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_failed_has_reason" CHECK (
    "status" <> 'failed' OR ("failure_reason" IS NOT NULL AND btrim("failure_reason") <> '')
);

ALTER TABLE "rma_remedy" ADD CONSTRAINT "rma_remedy_staff_review_has_reason" CHECK (
    "status" <> 'staff_review_required'
    OR ("staff_review_reason" IS NOT NULL AND btrim("staff_review_reason") <> '')
);

-- rma_request_guard — the database-level mirror of
-- app/domain/rma/status.ts's transition table (criterion 200). Same
-- fail-closed shape as warranty_claim_guard: allowed edges are stated
-- exhaustively, so an unrecognised status added later has no legal
-- transition into it until someone decides one. BEFORE UPDATE only;
-- application code (a later repository task) is responsible for every
-- INSERT starting at the 'submitted' default, and the CHECK constraints
-- above independently guard against an INSERT that tries to skip straight
-- to a decided-or-later status.
--
-- Also enforces criterion 184/185: window_kind, calendar_days_since_delivery
-- and the eligible-merchandise-amount snapshot are set once, at creation,
-- and never change — the "historical fact, never recomputed" guarantee
-- pinned at the database layer, not merely by convention.
CREATE OR REPLACE FUNCTION rma_request_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.window_kind IS DISTINCT FROM OLD.window_kind THEN
        RAISE EXCEPTION
            'rma request %: window_kind is set once at creation and cannot change',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.calendar_days_since_delivery IS DISTINCT FROM OLD.calendar_days_since_delivery THEN
        RAISE EXCEPTION
            'rma request %: calendar_days_since_delivery is a snapshot at request time and cannot change',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.eligible_merchandise_amount_minor_units IS DISTINCT FROM OLD.eligible_merchandise_amount_minor_units
       OR NEW.eligible_merchandise_amount_currency IS DISTINCT FROM OLD.eligible_merchandise_amount_currency THEN
        RAISE EXCEPTION
            'rma request %: the eligible merchandise amount is a snapshot at request time and cannot change',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    -- received_at is set once, by the one transition that means "receipt
    -- happened." Never cleared, never backdated afterwards.
    IF OLD.received_at IS NOT NULL AND NEW.received_at IS DISTINCT FROM OLD.received_at THEN
        RAISE EXCEPTION
            'rma request %: received_at is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'submitted'                     AND NEW.status IN ('approved', 'denied'))
            OR (OLD.status = 'approved'                       AND NEW.status IN ('return_shipped', 'received_inspection_pending', 'expired'))
            OR (OLD.status = 'return_shipped'                 AND NEW.status IN ('received_inspection_pending', 'expired'))
            OR (OLD.status = 'received_inspection_pending'    AND NEW.status IN ('inspection_passed', 'inspection_failed'))
            OR (OLD.status = 'inspection_passed'              AND NEW.status = 'remedy_in_progress')
            OR (OLD.status = 'remedy_in_progress'             AND NEW.status = 'resolved')
            OR (OLD.status = 'inspection_failed'              AND NEW.status = 'resolved')
            OR (OLD.status = 'resolved'                       AND NEW.status = 'closed')
        ) THEN
            RAISE EXCEPTION
                'rma request %: % -> % is not an allowed status transition',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rma_request_guard
    BEFORE UPDATE ON "rma_request"
    FOR EACH ROW EXECUTE FUNCTION rma_request_guard();

-- ISSUED IS TERMINAL, enforced at the database (criterion 196/204).
--
-- Policy §13 criterion 11: "Duplicate/retried refund or credit ... must not
-- create duplicate value." The domain's transition table already refuses
-- it; this is the guarantee that survives a script, a retry loop, or a
-- future caller that forgets to go through the service. Mirrors
-- group_buy_refund_issued_is_terminal exactly.
CREATE OR REPLACE FUNCTION rma_remedy_issued_is_terminal()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'issued' AND NEW.status <> 'issued' THEN
        RAISE EXCEPTION
            'rma remedy % is already issued; it cannot be moved to % (that would risk paying/crediting twice)',
            OLD.id, NEW.status
            USING ERRCODE = '23001';
    END IF;

    IF OLD.status = 'issued'
       AND (
           NEW.merchandise_amount_minor_units IS DISTINCT FROM OLD.merchandise_amount_minor_units
           OR NEW.restocking_fee_minor_units IS DISTINCT FROM OLD.restocking_fee_minor_units
           OR NEW.actual_refund_or_credit_minor_units IS DISTINCT FROM OLD.actual_refund_or_credit_minor_units
           OR NEW.processor_reference IS DISTINCT FROM OLD.processor_reference
       ) THEN
        RAISE EXCEPTION
            'rma remedy %: the amounts and processor reference are settled once issued',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rma_remedy_issued_terminal
    BEFORE UPDATE ON "rma_remedy"
    FOR EACH ROW EXECUTE FUNCTION rma_remedy_issued_is_terminal();

-- Append-only enforcement (prevent_evidence_mutation / prevent_evidence_truncate,
-- migrations 20260913000100 / 20260914000000, reused unchanged).

CREATE TRIGGER rma_event_no_update
    BEFORE UPDATE ON "rma_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER rma_event_no_delete
    BEFORE DELETE ON "rma_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER rma_event_no_truncate
    BEFORE TRUNCATE ON "rma_event"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
