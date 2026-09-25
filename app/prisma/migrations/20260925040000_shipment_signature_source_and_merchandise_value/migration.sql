-- D29-D31 wiring (docs/ARCHITECTURE-MVP1.md, resolved 2026-09-25;
-- app/app/domain/shipping/**, committed 7fc17f0). Closes the gap flagged in
-- that handoff: the schema could record THAT a signature was required, but
-- not WHY (rule vs. a named staff override), and had nowhere to record the
-- service actually used or the computed D29 merchandise value alongside
-- what was actually insured.
--
-- Hand-authored per this repo's established escalation path:
-- `prisma migrate dev --create-only` refused again on the known-benign
-- duplicate row in `_prisma_migrations` for
-- `20260922060000_bank_payment_verified_by_authenticated_identity` (wants a
-- full "public" schema reset). Did not run `migrate reset` or a
-- shadow-database `migrate diff`. Applied with `migrate deploy` only,
-- verified afterwards with `prisma migrate diff --from-schema-datasource
-- prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma`
-- reporting no difference (see handoff for the actual output).

-- CreateEnum
CREATE TYPE "signature_required_source" AS ENUM ('rule', 'staff_override');

-- CreateEnum
CREATE TYPE "signature_service_used" AS ENUM ('none', 'standard', 'adult_signature_required');

-- AlterTable
ALTER TABLE "shipment"
    ADD COLUMN "computed_merchandise_value_minor_units" BIGINT,
    ADD COLUMN "computed_merchandise_value_currency" CHAR(3),
    ADD COLUMN "signature_required_source" "signature_required_source" NOT NULL DEFAULT 'rule',
    ADD COLUMN "signature_service_used" "signature_service_used";

-- CHECK — D29's computed merchandise value: present together or absent
-- together, mirroring shipment_insured_value_coherent's coupling style.
-- Deliberately NOT compared to insured_value_minor_units anywhere in this
-- migration — see that column's doc comment in schema.prisma (D30/G2): the
-- two are allowed to differ visibly.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_computed_merchandise_value_coherent" CHECK (
    ("computed_merchandise_value_minor_units" IS NULL AND "computed_merchandise_value_currency" IS NULL)
    OR ("computed_merchandise_value_minor_units" IS NOT NULL AND "computed_merchandise_value_currency" IS NOT NULL)
);

-- CHECK — non-negative (not strictly positive: a shipment's merchandise
-- value can legitimately be zero, e.g. an all-promotional-item package —
-- computeShipmentMerchandiseValue permits this too).
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_computed_merchandise_value_non_negative" CHECK (
    "computed_merchandise_value_minor_units" IS NULL OR "computed_merchandise_value_minor_units" >= 0
);

-- CHECK — D31's accountability requirement, structurally: the override
-- provenance pair (signature_required_set_by_actor_ref /
-- signature_required_set_at) is populated if and only if
-- signature_required_source = 'staff_override'. This SUPERSEDES, in
-- substance, the looser "both or neither" coherence
-- (shipment_signature_required_provenance_coherent) added by migration
-- 20260925020000 -- that one still holds and is not dropped (migrations are
-- forward-only, never edited), but this is now the operative rule: a
-- 'rule'-sourced row can never carry an actor/timestamp, and a
-- 'staff_override'-sourced row can never lack one.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_signature_source_coherent" CHECK (
    (
        "signature_required_source" = 'staff_override'
        AND "signature_required_set_by_actor_ref" IS NOT NULL
        AND "signature_required_set_at" IS NOT NULL
    )
    OR (
        "signature_required_source" = 'rule'
        AND "signature_required_set_by_actor_ref" IS NULL
        AND "signature_required_set_at" IS NULL
    )
);

-- CHECK — an override can only ever REQUIRE a stricter service (D31: "that
-- is an override, not the default"; the customer may not waive a required
-- signature, and nothing here lets staff waive one on the customer's
-- behalf either). Mirrors the domain's own structural guarantee
-- (StaffSignatureOverride has no `required` field at all) at the database
-- layer: a 'staff_override' row is only ever valid with signature_required
-- = true.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_signature_override_requires_true" CHECK (
    "signature_required_source" <> 'staff_override' OR "signature_required" = true
);
