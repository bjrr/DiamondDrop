-- Slice 5 task 5-1 (docs/specs/SLICE-5-WARRANTY-CLAIMS.md, docs/WARRANTY-CLAIMS.md).
--
-- HAND-AUTHORED per the assigning message's escalation path: `prisma migrate
-- dev --create-only` refused (a checksum mismatch on a prior migration wanted
-- a full "public" schema reset), and `migrate reset` / a shadow-database
-- `migrate diff` fallback are both forbidden in this repo. This file is
-- written by hand, in this repo's established conventions, and is applied
-- with `migrate deploy` only. Verified afterwards with
-- `prisma migrate diff --from-schema-datasource prisma/schema.prisma
-- --to-schema-datamodel prisma/schema.prisma` reporting no difference (see
-- handoff for the actual command output).
--
-- M13 warranty_claim, M14 warranty_claim_event (append-only), M15
-- warranty_claim_upload (append-only, references only -- never bytes), M16
-- warranty_claim_remedy (idempotent by unique constraint, criterion 163),
-- plus warranty_claim_local_jeweller_authorization -- an INTERNAL-ONLY
-- satellite table for criteria 165-166, deliberately not columns on any of
-- the four tables above. See each table/column's doc comment in
-- schema.prisma for full reasoning; this file states the mechanics.
--
-- The state machine (criterion 168) is enforced at TWO layers, both derived
-- from the exact same transition table -- see app/domain/warranty/claimStatus.ts
-- for the pure function this migration's warranty_claim_guard trigger
-- mirrors. Changing one without the other is a bug.

-- CreateEnum
CREATE TYPE "warranty_claim_status" AS ENUM (
    'submitted',
    'under_review',
    'more_information_requested',
    'authorized_for_inspection',
    'in_transit_to_carat_for_us',
    'received_inspection_pending',
    'approved_covered',
    'denied_not_covered',
    'remedy_in_progress',
    'resolved',
    'closed'
);

-- CreateEnum
CREATE TYPE "warranty_coverage_decision" AS ENUM ('covered', 'not_covered');

-- CreateEnum
CREATE TYPE "warranty_remedy_kind" AS ENUM ('repair', 'replacement', 'refund', 'other');

-- CreateEnum
CREATE TYPE "warranty_claim_remedy_status" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "warranty_claim_upload_kind" AS ENUM ('photo', 'video');

-- CreateTable — M13
CREATE TABLE "warranty_claim" (
    "id" UUID NOT NULL,
    "claim_reference" TEXT NOT NULL,

    "order_ref" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "customer_ref" TEXT,

    "master_variant_id" UUID,
    "item_configuration_description" TEXT NOT NULL,

    "purchaser_name" TEXT NOT NULL,
    "purchaser_email" TEXT NOT NULL,

    "purchase_date" DATE,
    "delivery_date" DATE,
    "issue_first_noticed_date" DATE,

    "problem_description" TEXT NOT NULL,

    "had_impact_or_damage_event" BOOLEAN NOT NULL,
    "impact_or_damage_details" TEXT,

    "was_altered_after_delivery" BOOLEAN NOT NULL,
    "alteration_details" TEXT,

    "certificate_or_serial_identifier" TEXT,

    "accuracy_certification_acknowledgment_id" UUID NOT NULL,
    "coverage_not_established_acknowledgment_id" UUID NOT NULL,

    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "status" "warranty_claim_status" NOT NULL DEFAULT 'submitted',
    "paused_from_status" "warranty_claim_status",

    "authorized_at" TIMESTAMPTZ(6),
    "authorized_by_actor_ref" TEXT,

    "inbound_tracking_carrier" TEXT,
    "inbound_tracking_number" TEXT,
    "inbound_insurance_reference" TEXT,
    "inbound_insured_value_minor_units" BIGINT,
    "inbound_insured_value_currency" CHAR(3),

    "received_at" TIMESTAMPTZ(6),
    "package_condition" TEXT,
    "item_condition" TEXT,
    "inspection_notes" TEXT,
    "inspected_by_actor_ref" TEXT,

    "coverage_decision" "warranty_coverage_decision",
    "coverage_decision_reason" TEXT,
    "coverage_decided_at" TIMESTAMPTZ(6),
    "coverage_decided_by_actor_ref" TEXT,

    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warranty_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable — M14 (append-only)
CREATE TABLE "warranty_claim_event" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    "from_status" "warranty_claim_status",
    "to_status" "warranty_claim_status" NOT NULL,

    "actor_type" "actor_type" NOT NULL,
    "actor_ref" TEXT,
    "reason" TEXT,
    "metadata" JSONB,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranty_claim_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable — M15 (append-only; references only, never bytes)
CREATE TABLE "warranty_claim_upload" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    "kind" "warranty_claim_upload_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,

    "uploaded_by_actor_type" "actor_type" NOT NULL,
    "uploaded_by_actor_ref" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranty_claim_upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable — M16
CREATE TABLE "warranty_claim_remedy" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    "kind" "warranty_remedy_kind" NOT NULL,
    "status" "warranty_claim_remedy_status" NOT NULL DEFAULT 'pending',

    "refund_amount_minor_units" BIGINT,
    "currency" CHAR(3),

    "processor_reference" TEXT,
    "failure_reason" TEXT,

    "decided_by_actor_ref" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warranty_claim_remedy_pkey" PRIMARY KEY ("id")
);

-- CreateTable — INTERNAL ONLY (criteria 165-166). See schema.prisma's doc
-- comment on this model for why it is its own table.
CREATE TABLE "warranty_claim_local_jeweller_authorization" (
    "id" UUID NOT NULL,
    "remedy_id" UUID NOT NULL,

    "jeweller_name" TEXT NOT NULL,
    "jeweller_contact" TEXT,

    "authorized_scope" TEXT NOT NULL,
    "authorized_cost_minor_units" BIGINT NOT NULL,
    "authorized_cost_currency" CHAR(3) NOT NULL,
    "authorized_by_actor_ref" TEXT NOT NULL,
    "authorized_at" TIMESTAMPTZ(6) NOT NULL,

    "communications_log" TEXT,

    "invoice_reference" TEXT,
    "invoice_amount_minor_units" BIGINT,
    "invoice_amount_currency" CHAR(3),
    "payment_reference" TEXT,
    "reimbursement_reference" TEXT,

    "completion_evidence" TEXT,
    "completed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warranty_claim_local_jeweller_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warranty_claim_claim_reference_key" ON "warranty_claim"("claim_reference");
CREATE INDEX "warranty_claim_order_ref_idx" ON "warranty_claim"("order_ref");
CREATE INDEX "warranty_claim_status_idx" ON "warranty_claim"("status");
CREATE INDEX "warranty_claim_customer_ref_idx" ON "warranty_claim"("customer_ref");
CREATE INDEX "warranty_claim_master_variant_id_idx" ON "warranty_claim"("master_variant_id");

-- CreateIndex
CREATE INDEX "warranty_claim_event_claim_id_created_at_idx" ON "warranty_claim_event"("claim_id", "created_at");

-- CreateIndex
CREATE INDEX "warranty_claim_upload_claim_id_idx" ON "warranty_claim_upload"("claim_id");

-- CreateIndex — criterion 163: at most one remedy row per claim.
CREATE UNIQUE INDEX "warranty_claim_remedy_claim_id_key" ON "warranty_claim_remedy"("claim_id");

-- CreateIndex — at most one jeweller arrangement per remedy.
CREATE UNIQUE INDEX "warranty_claim_local_jeweller_authorization_remedy_id_key" ON "warranty_claim_local_jeweller_authorization"("remedy_id");

-- AddForeignKey
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_accuracy_certification_acknowledgment_id_fkey" FOREIGN KEY ("accuracy_certification_acknowledgment_id") REFERENCES "acknowledgment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_coverage_not_established_acknowledgment_i_fkey" FOREIGN KEY ("coverage_not_established_acknowledgment_id") REFERENCES "acknowledgment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warranty_claim_event" ADD CONSTRAINT "warranty_claim_event_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "warranty_claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warranty_claim_upload" ADD CONSTRAINT "warranty_claim_upload_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "warranty_claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warranty_claim_remedy" ADD CONSTRAINT "warranty_claim_remedy_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "warranty_claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warranty_claim_local_jeweller_authorization" ADD CONSTRAINT "warranty_claim_local_jeweller_authorization_remedy_id_fkey" FOREIGN KEY ("remedy_id") REFERENCES "warranty_claim_remedy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK — criterion 160: a denial without a reason is not a valid state.
-- Mirrors the coherence-CHECK style established on luxury_steal_order_check
-- and price_override.
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_denial_requires_reason" CHECK (
    "coverage_decision" IS DISTINCT FROM 'not_covered'
    OR ("coverage_decision_reason" IS NOT NULL AND length(trim("coverage_decision_reason")) > 0)
);

-- CHECK — coverage_decision agrees with status, in both directions: a
-- covered/not_covered decision is only visible once its matching status (or
-- a later status reachable only through it) has been reached, and no claim
-- can reach a decided-or-later status without the matching decision being
-- recorded. This is criterion 168's "decided before resolved" pinned at the
-- database level, independent of warranty_claim_guard below.
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_coverage_decision_status_coherent" CHECK (
    (
        "coverage_decision" = 'covered'
        AND "status" IN ('approved_covered', 'remedy_in_progress', 'resolved', 'closed')
    )
    OR (
        "coverage_decision" = 'not_covered'
        AND "status" IN ('denied_not_covered', 'resolved', 'closed')
    )
    OR (
        "coverage_decision" IS NULL
        AND "status" NOT IN ('approved_covered', 'denied_not_covered', 'remedy_in_progress', 'resolved', 'closed')
    )
);

-- CHECK — criterion 159, independent of warranty_claim_guard (which only
-- fires BEFORE UPDATE): no row, inserted or updated, may sit in a
-- decided-or-later status without a recorded receipt.
ALTER TABLE "warranty_claim" ADD CONSTRAINT "warranty_claim_decision_requires_receipt" CHECK (
    "status" NOT IN ('approved_covered', 'denied_not_covered', 'remedy_in_progress', 'resolved', 'closed')
    OR "received_at" IS NOT NULL
);

-- CHECK — refund money fields populated if and only if kind = refund.
-- Mirrors price_override_kind_bank_payment_price_coherent's coupling style.
ALTER TABLE "warranty_claim_remedy" ADD CONSTRAINT "warranty_claim_remedy_refund_money_coherent" CHECK (
    ("kind" = 'refund' AND "refund_amount_minor_units" IS NOT NULL AND "currency" IS NOT NULL)
    OR ("kind" <> 'refund' AND "refund_amount_minor_units" IS NULL AND "currency" IS NULL)
);

-- warranty_claim_guard — the database-level mirror of
-- app/domain/warranty/claimStatus.ts's transition table (criterion 168). Same
-- fail-closed shape as group_buy_campaign_guard (migration
-- 20260919060000_group_buy_campaign_status_transitions): the allowed edges
-- are stated exhaustively, so an unrecognised status added later has no legal
-- transition into it until someone decides one. BEFORE UPDATE only, matching
-- that precedent — application code (task 5-2's repository) is responsible
-- for every INSERT starting at the 'submitted' default; the CHECK
-- constraints above independently guard against an INSERT that tries to
-- skip straight to a decided-or-later status with no receipt.
--
-- more_information_requested's two exits are handled by comparing against
-- OLD.paused_from_status directly rather than naming a fixed destination —
-- this is what makes "ask for more info, then resume" return to EXACTLY
-- where it paused from and nowhere else (see that status's doc comment in
-- schema.prisma and the domain module's header for why a fixed pair of
-- static edges would allow a receipt-skipping shortcut).
CREATE OR REPLACE FUNCTION warranty_claim_guard()
RETURNS TRIGGER AS $$
BEGIN
    -- received_at is set once, by the one transition that means "receipt
    -- happened" (in_transit_to_carat_for_us -> received_inspection_pending).
    -- Never cleared, never backdated afterwards.
    IF OLD.received_at IS NOT NULL AND NEW.received_at IS DISTINCT FROM OLD.received_at THEN
        RAISE EXCEPTION
            'warranty claim %: received_at is set once and cannot change once recorded',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
               (OLD.status = 'submitted'                    AND NEW.status = 'under_review')
            OR (OLD.status = 'under_review'                 AND NEW.status IN ('more_information_requested', 'authorized_for_inspection'))
            OR (OLD.status = 'more_information_requested'   AND NEW.status = OLD.paused_from_status)
            OR (OLD.status = 'authorized_for_inspection'     AND NEW.status = 'in_transit_to_carat_for_us')
            OR (OLD.status = 'in_transit_to_carat_for_us'    AND NEW.status = 'received_inspection_pending')
            OR (OLD.status = 'received_inspection_pending'   AND NEW.status IN ('more_information_requested', 'approved_covered', 'denied_not_covered'))
            OR (OLD.status = 'approved_covered'               AND NEW.status = 'remedy_in_progress')
            OR (OLD.status = 'remedy_in_progress'             AND NEW.status = 'resolved')
            OR (OLD.status = 'denied_not_covered'             AND NEW.status = 'resolved')
            OR (OLD.status = 'resolved'                       AND NEW.status = 'closed')
        ) THEN
            RAISE EXCEPTION
                'warranty claim %: % -> % is not an allowed status transition',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    -- more_information_requested must always record where it paused from,
    -- and every other status must not carry a stale value.
    IF NEW.status = 'more_information_requested' AND NEW.paused_from_status IS NULL THEN
        RAISE EXCEPTION
            'warranty claim %: more_information_requested requires paused_from_status',
            OLD.id
            USING ERRCODE = '23001';
    END IF;
    IF NEW.status <> 'more_information_requested' AND NEW.paused_from_status IS NOT NULL THEN
        RAISE EXCEPTION
            'warranty claim %: paused_from_status must be null outside more_information_requested',
            OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER warranty_claim_guard
    BEFORE UPDATE ON "warranty_claim"
    FOR EACH ROW EXECUTE FUNCTION warranty_claim_guard();

-- Append-only enforcement (prevent_evidence_mutation / prevent_evidence_truncate,
-- migrations 20260913000100 / 20260914000000, reused unchanged by every
-- evidence table since).

CREATE TRIGGER warranty_claim_event_no_update
    BEFORE UPDATE ON "warranty_claim_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER warranty_claim_event_no_delete
    BEFORE DELETE ON "warranty_claim_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER warranty_claim_event_no_truncate
    BEFORE TRUNCATE ON "warranty_claim_event"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

CREATE TRIGGER warranty_claim_upload_no_update
    BEFORE UPDATE ON "warranty_claim_upload"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER warranty_claim_upload_no_delete
    BEFORE DELETE ON "warranty_claim_upload"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER warranty_claim_upload_no_truncate
    BEFORE TRUNCATE ON "warranty_claim_upload"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
