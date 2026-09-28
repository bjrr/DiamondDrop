-- Closes the storageKey trust gap flagged in the R2 adapter handoff: the
-- warranty claim intake route used to accept `storageKey` as an opaque
-- client-supplied string, with nothing to verify a destination was ever
-- actually issued for it. See `WarrantyClaimUploadDestination`'s doc comment
-- in schema.prisma for the full reasoning (why `claim_id` is NOT a foreign
-- key here, and why this table is deliberately NOT append-only unlike every
-- other table this slice added).
--
-- HAND-AUTHORED, following this repo's established escalation path for this
-- exact situation (see `20260925010000_slice5_warranty_claims_schema`'s own
-- header): no local dev database is reachable from this environment to run
-- `prisma migrate dev`, and `migrate reset` / a shadow-database `migrate
-- diff` fallback are both forbidden. Written by hand in this repo's
-- conventions; applied with `migrate deploy` only.

-- CreateTable
CREATE TABLE "warranty_claim_upload_destination" (
    "id" UUID NOT NULL,

    "claim_id" UUID NOT NULL,
    "customer_ref" TEXT NOT NULL,

    "kind" "warranty_claim_upload_kind" NOT NULL,
    "content_type" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,

    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "warranty_claim_upload_destination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warranty_claim_upload_destination_storage_key_key" ON "warranty_claim_upload_destination"("storage_key");

-- CreateIndex
CREATE INDEX "warranty_claim_upload_destination_claim_id_idx" ON "warranty_claim_upload_destination"("claim_id");

-- Deliberately NO foreign key from claim_id to warranty_claim(id) — see the
-- model comment. Deliberately NO append-only trigger — this table is a
-- single-use reservation ticket (consumed_at moves from NULL to a timestamp
-- exactly once via an atomic conditional UPDATE), not evidence of the
-- claim's content, the same distinction migration
-- `20260913000100_append_only_evidence_triggers` already draws for
-- webhook_event/idempotency_key.
