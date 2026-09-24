-- Slice 3 — Luxury Steals, task 3-1 (docs/specs/SLICE-3-LUXURY-STEALS.md).
--
-- M11: master_variant.is_luxury_steal — the authoritative, variant-grain
-- Luxury Steal assignment (D27, criteria 125-128, 146-150). Superseding
-- master_product.is_luxury_steal in authority, not in existence — see that
-- column's doc comment in schema.prisma for why it is left in place
-- unmigrated and flagged for architect follow-up rather than dropped here.
--
-- M12: luxury_steal_order_check — the append-only order-boundary evidence
-- (criteria 137-140). One row per Luxury Steal order LINE verified at
-- `orders/create` time (task 3-4 is the intended writer). Follows the
-- append-only convention established by migration 20260913000100 /
-- 20260914000000 and reused unchanged by every evidence table since.

-- CreateEnum
CREATE TYPE "luxury_steal_order_check_outcome" AS ENUM ('matched', 'unmatched');

-- AlterTable
ALTER TABLE "master_variant" ADD COLUMN     "is_luxury_steal" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "master_variant_is_luxury_steal_idx" ON "master_variant"("is_luxury_steal");

-- CreateTable
CREATE TABLE "luxury_steal_order_check" (
    "id" UUID NOT NULL,
    "order_ref" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "variant_ref" TEXT NOT NULL,
    "matched_acknowledgment_id" UUID,
    "outcome" "luxury_steal_order_check_outcome" NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "luxury_steal_order_check_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — idempotency (criterion 139): a redelivered orders/create
-- reads this back instead of writing a second hold or a second evidence row.
CREATE UNIQUE INDEX "luxury_steal_order_check_order_ref_line_ref_key" ON "luxury_steal_order_check"("order_ref", "line_ref");

-- CreateIndex
CREATE INDEX "luxury_steal_order_check_order_ref_idx" ON "luxury_steal_order_check"("order_ref");

-- CreateIndex
CREATE INDEX "luxury_steal_order_check_variant_ref_idx" ON "luxury_steal_order_check"("variant_ref");

-- AddForeignKey
ALTER TABLE "luxury_steal_order_check" ADD CONSTRAINT "luxury_steal_order_check_matched_acknowledgment_id_fkey" FOREIGN KEY ("matched_acknowledgment_id") REFERENCES "acknowledgment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Criterion 140: the outcome and the matched-acknowledgment reference must
-- never disagree. `matched` requires a non-null acknowledgment id;
-- `unmatched`, by definition, found none to point at. Mirrors the coherence
-- CHECK style already established on price_override
-- (price_override_kind_bank_payment_price_coherent).
ALTER TABLE "luxury_steal_order_check"
  ADD CONSTRAINT "luxury_steal_order_check_outcome_coherent" CHECK (
    (outcome = 'matched'   AND matched_acknowledgment_id IS NOT NULL)
    OR
    (outcome = 'unmatched' AND matched_acknowledgment_id IS NULL)
  );

-- Append-only enforcement (migration 20260913000100's prevent_evidence_mutation
-- / 20260914000000's prevent_evidence_truncate, reused unchanged by every
-- evidence table since). This is evidence of what was checked and found —
-- an editable or deletable row would defeat criterion 140's whole purpose.
CREATE TRIGGER luxury_steal_order_check_no_update
    BEFORE UPDATE ON "luxury_steal_order_check"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER luxury_steal_order_check_no_delete
    BEFORE DELETE ON "luxury_steal_order_check"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER luxury_steal_order_check_no_truncate
    BEFORE TRUNCATE ON "luxury_steal_order_check"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
