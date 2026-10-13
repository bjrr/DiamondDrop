-- Group Buy Bank Payment checkout — REQUIRED cancellation-policy
-- acknowledgment FK (owner approval 2026-09-27,
-- app/app/domain/groupbuy/cancellationAcknowledgmentText.ts). Same
-- evidence-not-checkbox shape as `rma_request.return_policy_acknowledgment_id`
-- (migration 20260926010000_slice4_buy_now_rma_schema): NOT NULL, no boolean
-- "accepted" column — the existence of the referenced `acknowledgment` row is
-- the evidence.
--
-- ADDED AS A FOLLOW-UP MIGRATION, NOT A CHANGE TO
-- 20260927010000_group_buy_bank_payment_checkout, per this repo's migration-
-- immutability discipline (CLAUDE.md git discipline; this table's own
-- migration header) — even though that migration has not shipped to
-- production yet, it may already be applied to a shared dev/CI database, so
-- this stays a separate, additive migration rather than an edit to it.
--
-- NOT NULL WITH NO BACKFILL STEP, DELIBERATELY, UNLIKE
-- 20260926050000_bank_payment_order_customer_gid's sentinel backfill. That
-- precedent was needed because `bank_payment_order` already had real rows
-- when its NOT NULL column was added. `group_buy_bank_payment_order` cannot
-- have that problem: it was created by 20260927010000 in this SAME
-- uncommitted change set, has never been deployed to any environment
-- (including production, which has not run this batch of migrations yet),
-- and its row count was verified as 0 in the integration test database
-- immediately before authoring this migration. A NOT NULL FK with no
-- DEFAULT is exactly what "this order cannot exist without a recorded
-- acknowledgment" should mean at the database level, not merely the
-- application level — see the same reasoning in this migration's sibling,
-- 20260926010000_slice4_buy_now_rma_schema's `return_policy_acknowledgment_id`.
ALTER TABLE "group_buy_bank_payment_order" ADD COLUMN "cancellation_acknowledgment_id" UUID NOT NULL;

CREATE INDEX "group_buy_bank_payment_order_cancellation_ack_id_idx" ON "group_buy_bank_payment_order"("cancellation_acknowledgment_id");

ALTER TABLE "group_buy_bank_payment_order"
  ADD CONSTRAINT "group_buy_bank_payment_order_cancellation_ack_id_fkey"
  FOREIGN KEY ("cancellation_acknowledgment_id") REFERENCES "acknowledgment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "group_buy_bank_payment_order"."cancellation_acknowledgment_id" IS
  'REQUIRED (NOT NULL FK) -- the owner-approved 2026-09-27 Group Buy cancellation-policy acknowledgment (app/domain/groupbuy/cancellationAcknowledgmentText.ts). The checkout route refuses the request server-side, fail closed, when this acknowledgment is absent.';
