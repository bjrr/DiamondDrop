-- Slice 11 (subset) — Shipment Evidence (docs/specs/SLICE-11-SHIPMENT-
-- EVIDENCE.md, docs/specs/SLICE-11-READINESS.md). Hand-authored per this
-- repo's escalation path: `prisma migrate dev --create-only` refuses again
-- on the known-benign duplicate row in `_prisma_migrations` for
-- `20260922060000_bank_payment_verified_by_authenticated_identity` (wants a
-- full "public" schema reset). `migrate reset` and a shadow-database
-- `migrate diff` fallback remain forbidden. Written by hand in this repo's
-- conventions, applied with `migrate deploy` only, verified afterwards with
-- `prisma migrate diff --from-schema-datasource prisma/schema.prisma
-- --to-schema-datamodel prisma/schema.prisma` reporting no difference (see
-- handoff for the actual output).
--
-- ONE ROW PER OUTBOUND PACKAGE (`shipment`) plus its append-only
-- address-change history (`shipment_address_change_event`). Deliberately NO
-- enforcement tied to README's $100 signature threshold or "full order
-- value" insurance rule anywhere in this file — see schema.prisma's section
-- header above these two models and docs/specs/SLICE-11-READINESS.md G1.
-- This migration records what staff arranged, never what a policy threshold
-- would compute.

-- CreateTable — M-shipment
CREATE TABLE "shipment" (
    "id" UUID NOT NULL,

    "order_ref" TEXT NOT NULL,

    "carrier" TEXT NOT NULL,
    "service" TEXT,
    "tracking_number" TEXT NOT NULL,
    "ship_date" DATE NOT NULL,

    "insured_value_minor_units" BIGINT,
    "insured_value_currency" CHAR(3),
    "insurance_reference" TEXT,

    "signature_required" BOOLEAN NOT NULL DEFAULT false,
    "signature_required_set_by_actor_ref" TEXT,
    "signature_required_set_at" TIMESTAMPTZ(6),

    "delivered_at" TIMESTAMPTZ(6),
    "delivery_confirmation_reference" TEXT,
    "proof_of_signature_reference" TEXT,

    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "address_city" TEXT NOT NULL,
    "address_region" TEXT,
    "address_postal_code" TEXT NOT NULL,
    "address_country" TEXT NOT NULL,

    "entered_by_actor_ref" TEXT NOT NULL,
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable — append-only address-change history
CREATE TABLE "shipment_address_change_event" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,

    "from_address_line1" TEXT NOT NULL,
    "from_address_line2" TEXT,
    "from_address_city" TEXT NOT NULL,
    "from_address_region" TEXT,
    "from_address_postal_code" TEXT NOT NULL,
    "from_address_country" TEXT NOT NULL,

    "to_address_line1" TEXT NOT NULL,
    "to_address_line2" TEXT,
    "to_address_city" TEXT NOT NULL,
    "to_address_region" TEXT,
    "to_address_postal_code" TEXT NOT NULL,
    "to_address_country" TEXT NOT NULL,

    "reason" TEXT,

    "actor_type" "actor_type" NOT NULL,
    "actor_ref" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_address_change_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_order_ref_idx" ON "shipment"("order_ref");
CREATE INDEX "shipment_tracking_number_idx" ON "shipment"("tracking_number");
CREATE INDEX "shipment_address_change_event_shipment_id_created_at_idx" ON "shipment_address_change_event"("shipment_id", "created_at");

-- AddForeignKey
ALTER TABLE "shipment_address_change_event" ADD CONSTRAINT "shipment_address_change_event_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK — criterion 173: insured value and its currency present together or
-- absent together. Mirrors warranty_claim_remedy_refund_money_coherent's
-- coupling style (migration 20260925010000).
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_insured_value_coherent" CHECK (
    ("insured_value_minor_units" IS NULL AND "insured_value_currency" IS NULL)
    OR ("insured_value_minor_units" IS NOT NULL AND "insured_value_currency" IS NOT NULL)
);

-- CHECK — a positive insured amount when present. Not a threshold rule (no
-- comparison to any order figure — see docs/specs/SLICE-11-READINESS.md G1);
-- purely a sanity bound on the value itself, same spirit as
-- warranty_claim_remedy's refund-amount-positive check.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_insured_value_positive" CHECK (
    "insured_value_minor_units" IS NULL OR "insured_value_minor_units" > 0
);

-- CHECK — criterion 174: signatureRequiredSetAt/SetByActorRef are populated
-- together or not at all. Prevents a half-recorded provenance (a timestamp
-- with no actor, or vice versa) — the same coherence discipline as every
-- other "who/when" pair in this schema.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_signature_required_provenance_coherent" CHECK (
    ("signature_required_set_by_actor_ref" IS NULL AND "signature_required_set_at" IS NULL)
    OR ("signature_required_set_by_actor_ref" IS NOT NULL AND "signature_required_set_at" IS NOT NULL)
);

-- Append-only enforcement on the address-change history (prevent_evidence_mutation
-- / prevent_evidence_truncate, migrations 20260913000100 / 20260914000000,
-- reused unchanged by every evidence table since). NOT applied to `shipment`
-- itself, which is mutable by design (delivery confirmation, signature
-- provenance and address are all updated in place as a shipment progresses
-- — see this table's own model comment in schema.prisma) — the SAME
-- distinction `webhook_event`/`idempotency_key` and, this slice,
-- `warranty_claim` vs `warranty_claim_event` already draw.

CREATE TRIGGER shipment_address_change_event_no_update
    BEFORE UPDATE ON "shipment_address_change_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER shipment_address_change_event_no_delete
    BEFORE DELETE ON "shipment_address_change_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER shipment_address_change_event_no_truncate
    BEFORE TRUNCATE ON "shipment_address_change_event"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
