-- Group Buy cancellation-acknowledgment order-boundary evidence (owner spec
-- 2026-09-27/28). Mirrors migration
-- 20260923010000_slice3_luxury_steal_variant_assignment_and_order_check's
-- luxury_steal_order_check table deliberately -- same class of material
-- evidence (owner's own words: "the Group Buy acknowledgment is the same
-- class of material evidence as Luxury Steals Final Sale"), same D28
-- order-time-verification discipline, same append-only shape and triggers.
--
-- ONE COLUMN THIS TABLE ADDS THAT luxury_steal_order_check DOES NOT:
-- mismatch_reason. Luxury Steals' order-time check has exactly one way to
-- fail (no matching acknowledgment id); this one has several distinct ways
-- (customer mismatch, campaign mismatch, stale policy version, etc. -- see
-- app/app/domain/groupbuy/cancellationOrderCheck.ts), and the owner's own
-- instruction ("persist the failed order check -- evidence, not just a log
-- line") is best served by a held order's evidence explaining WHY without a
-- human re-deriving it from raw column comparisons.

-- CreateEnum
CREATE TYPE "group_buy_order_cancellation_check_outcome" AS ENUM ('matched', 'unmatched');

-- CreateTable
CREATE TABLE "group_buy_order_cancellation_check" (
    "id" UUID NOT NULL,
    "order_ref" TEXT NOT NULL,
    "line_ref" TEXT NOT NULL,
    "campaign_ref" TEXT NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "matched_acknowledgment_id" UUID,
    "mismatch_reason" TEXT,
    "outcome" "group_buy_order_cancellation_check_outcome" NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_order_cancellation_check_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — idempotency: a redelivered orders/create reads this back
-- instead of writing a second hold, a second check row, or a second unit.
-- campaign_ref joins the key (unlike luxury_steal_order_check's bare
-- (order_ref, line_ref)) because a single line COULD belong to more than one
-- simultaneously-open campaign -- see this table's own schema.prisma comment.
CREATE UNIQUE INDEX "group_buy_order_cancellation_check_order_ref_line_ref_camp_key" ON "group_buy_order_cancellation_check"("order_ref", "line_ref", "campaign_ref");

-- CreateIndex
CREATE INDEX "group_buy_order_cancellation_check_order_ref_idx" ON "group_buy_order_cancellation_check"("order_ref");

-- CreateIndex
CREATE INDEX "group_buy_order_cancellation_check_campaign_ref_idx" ON "group_buy_order_cancellation_check"("campaign_ref");

-- CreateIndex
CREATE INDEX "group_buy_order_cancellation_check_master_variant_id_idx" ON "group_buy_order_cancellation_check"("master_variant_id");

-- AddForeignKey
ALTER TABLE "group_buy_order_cancellation_check" ADD CONSTRAINT "group_buy_order_cancellation_check_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_order_cancellation_check" ADD CONSTRAINT "group_buy_order_cancellation_check_matched_acknowledgment__fkey" FOREIGN KEY ("matched_acknowledgment_id") REFERENCES "acknowledgment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The outcome and the matched-acknowledgment reference must never disagree.
-- `matched` requires a non-null acknowledgment id; `unmatched`, by
-- definition, found none that verified. Mirrors
-- luxury_steal_order_check_outcome_coherent exactly.
ALTER TABLE "group_buy_order_cancellation_check"
  ADD CONSTRAINT "group_buy_order_cancellation_check_outcome_coherent" CHECK (
    (outcome = 'matched'   AND matched_acknowledgment_id IS NOT NULL)
    OR
    (outcome = 'unmatched' AND matched_acknowledgment_id IS NULL)
  );

-- Append-only enforcement (migration 20260913000100's prevent_evidence_mutation
-- / 20260914000000's prevent_evidence_truncate, reused unchanged by every
-- evidence table since, including luxury_steal_order_check).
CREATE TRIGGER group_buy_order_cancellation_check_no_update
    BEFORE UPDATE ON "group_buy_order_cancellation_check"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER group_buy_order_cancellation_check_no_delete
    BEFORE DELETE ON "group_buy_order_cancellation_check"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER group_buy_order_cancellation_check_no_truncate
    BEFORE TRUNCATE ON "group_buy_order_cancellation_check"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
