-- D32 — insurance provider-adapter seam: coverage provider identity +
-- verification provenance (docs/ARCHITECTURE-MVP1.md D32, resolved
-- 2026-09-25). `app/app/insurance/**` owns every provider-specific concept;
-- this table stores only an OPAQUE provider id string plus a staff
-- verification attestation — nothing here references Jewelers Mutual or any
-- other provider by name.
--
-- Hand-authored per this repo's established escalation path (see
-- 20260925020000/20260925040000's own migration headers): `prisma migrate
-- dev --create-only` refuses on the known-benign duplicate
-- `_prisma_migrations` row for `20260922060000_bank_payment_verified_by_
-- authenticated_identity` (wants a full "public" schema reset). Did not run
-- `migrate reset` or a shadow-database `migrate diff`. Applied with
-- `migrate deploy` only, verified afterwards with `prisma migrate diff
-- --from-schema-datasource prisma/schema.prisma --to-schema-datamodel
-- prisma/schema.prisma` reporting no difference (see handoff for the actual
-- output).

-- AlterTable
ALTER TABLE "shipment"
    ADD COLUMN "insurance_provider_id" TEXT,
    ADD COLUMN "insurance_coverage_verified_at" TIMESTAMPTZ(6),
    ADD COLUMN "insurance_coverage_verified_by_actor_ref" TEXT;

-- CHECK — verification provenance present together or absent together, same
-- coupling style as every other who/when pair in this schema
-- (shipment_signature_required_provenance_coherent, warranty_claim's
-- authorized_at/authorized_by_actor_ref, etc.).
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_insurance_verification_provenance_coherent" CHECK (
    ("insurance_coverage_verified_at" IS NULL AND "insurance_coverage_verified_by_actor_ref" IS NULL)
    OR ("insurance_coverage_verified_at" IS NOT NULL AND "insurance_coverage_verified_by_actor_ref" IS NOT NULL)
);

-- CHECK — staff cannot verify coverage that was never recorded: a verified
-- row must carry both a provider id and a reference to have verified.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_insurance_verification_requires_provider_and_reference" CHECK (
    "insurance_coverage_verified_at" IS NULL
    OR ("insurance_provider_id" IS NOT NULL AND "insurance_reference" IS NOT NULL)
);

-- CHECK — a named provider is meaningless without a reference to that
-- provider's policy/certificate.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_insurance_provider_requires_reference" CHECK (
    "insurance_provider_id" IS NULL OR "insurance_reference" IS NOT NULL
);
