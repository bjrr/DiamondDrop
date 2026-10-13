-- Slice 2 stage 2A/2C, M5 + M6
-- (docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §6, owner §4, §8).
--
-- M5 -- price_sync_failure: one row per FAILURE EPISODE (see the model doc
-- comment in schema.prisma). M6 -- bank_payment_order /
-- bank_payment_order_line: the Bank Payment Checkout draft-order quote,
-- 24-hour guarantee and manual verification workflow.

-- CreateEnum
CREATE TYPE "price_sync_failure_alert_state" AS ENUM ('active', 'cleared', 'dismissed');

-- CreateEnum
CREATE TYPE "bank_payment_order_status" AS ENUM ('open', 'cancelled', 'completed');

-- CreateTable
CREATE TABLE "price_sync_failure" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "first_failed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT NOT NULL,
    "alert_state" "price_sync_failure_alert_state" NOT NULL DEFAULT 'active',
    "suspended_at" TIMESTAMPTZ(6),
    "dismissed_by" TEXT,
    "dismissed_reason" TEXT,
    "dismissed_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_sync_failure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_payment_order" (
    "id" UUID NOT NULL,
    "shopify_draft_order_gid" TEXT NOT NULL,
    "status" "bank_payment_order_status" NOT NULL DEFAULT 'open',
    "quoted_at" TIMESTAMPTZ(6) NOT NULL,
    "guarantee_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_payment_amount_minor_units" BIGINT,
    "verified_payment_currency" CHAR(3),
    "verified_payment_method" TEXT,
    "verified_payment_reference" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "shopify_order_gid" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bank_payment_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_payment_order_line" (
    "id" UUID NOT NULL,
    "bank_payment_order_id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "price_calculation_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "quoted_bank_payment_price_minor_units" BIGINT NOT NULL,
    "quoted_regular_card_price_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "eligible_at_quote_time" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_payment_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_sync_failure_master_variant_id_idx" ON "price_sync_failure"("master_variant_id");

-- CreateIndex
CREATE INDEX "price_sync_failure_alert_state_idx" ON "price_sync_failure"("alert_state");

-- CreateIndex
CREATE UNIQUE INDEX "bank_payment_order_shopify_draft_order_gid_key" ON "bank_payment_order"("shopify_draft_order_gid");

-- CreateIndex
CREATE UNIQUE INDEX "bank_payment_order_shopify_order_gid_key" ON "bank_payment_order"("shopify_order_gid");

-- CreateIndex
CREATE INDEX "bank_payment_order_status_idx" ON "bank_payment_order"("status");

-- CreateIndex
CREATE INDEX "bank_payment_order_line_bank_payment_order_id_idx" ON "bank_payment_order_line"("bank_payment_order_id");

-- AddForeignKey
ALTER TABLE "price_sync_failure" ADD CONSTRAINT "price_sync_failure_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_payment_order_line" ADD CONSTRAINT "bank_payment_order_line_bank_payment_order_id_fkey" FOREIGN KEY ("bank_payment_order_id") REFERENCES "bank_payment_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_payment_order_line" ADD CONSTRAINT "bank_payment_order_line_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_payment_order_line" ADD CONSTRAINT "bank_payment_order_line_price_calculation_id_fkey" FOREIGN KEY ("price_calculation_id") REFERENCES "price_calculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- price_sync_failure: at most one OPEN episode per variant (criterion 23's
-- "retries span multiple intents" only makes sense if there is exactly one
-- accumulating row to retry against). Mirrors
-- price_sync_intent_one_non_terminal_per_variant (migration 20260917011234).
-- Prisma cannot express a partial unique index, so this is raw SQL.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "price_sync_failure_one_open_per_variant"
    ON "price_sync_failure" ("master_variant_id")
    WHERE "resolved_at" IS NULL;

ALTER TABLE "price_sync_failure"
  ADD CONSTRAINT "price_sync_failure_attempt_count_positive" CHECK (attempt_count >= 1);

-- A dismissal is an attributed exception (by + reason + at), never a bare
-- flag -- see the model doc comment.
ALTER TABLE "price_sync_failure"
  ADD CONSTRAINT "price_sync_failure_dismiss_complete" CHECK (
    (dismissed_at IS NULL AND dismissed_by IS NULL AND dismissed_reason IS NULL)
    OR (dismissed_at IS NOT NULL AND dismissed_by IS NOT NULL
        AND btrim(dismissed_reason) <> '')
  );

-- alert_state names exactly which of the two resolving events (if either)
-- has happened, so the two can never silently disagree.
ALTER TABLE "price_sync_failure"
  ADD CONSTRAINT "price_sync_failure_alert_state_coherent" CHECK (
    (alert_state = 'active'    AND dismissed_at IS NULL)
    OR (alert_state = 'dismissed' AND dismissed_at IS NOT NULL)
    OR (alert_state = 'cleared'   AND resolved_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- bank_payment_order: F-16 money/currency pairing, and status/lifecycle
-- coherence -- an order in a given status carries exactly the timestamps
-- that status implies, never more, never fewer.
-- ---------------------------------------------------------------------------
ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_verification_pairing" CHECK (
    (verified_at IS NULL AND verified_by IS NULL
        AND verified_payment_amount_minor_units IS NULL
        AND verified_payment_currency IS NULL
        AND verified_payment_method IS NULL)
    OR (verified_at IS NOT NULL AND verified_by IS NOT NULL
        AND verified_payment_amount_minor_units IS NOT NULL
        AND verified_payment_currency IS NOT NULL
        AND verified_payment_method IS NOT NULL)
  );

ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_cancellation_pairing" CHECK (
    (cancelled_at IS NULL) = (cancellation_reason IS NULL)
  );

ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_status_coherent" CHECK (
    (status = 'open'      AND cancelled_at IS NULL AND completed_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND verified_at IS NOT NULL
        AND shopify_order_gid IS NOT NULL AND cancelled_at IS NULL)
  );

ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_guarantee_after_quote" CHECK (
    guarantee_expires_at > quoted_at
  );

ALTER TABLE "bank_payment_order_line"
  ADD CONSTRAINT "bank_payment_order_line_quantity_positive" CHECK (quantity > 0);

ALTER TABLE "bank_payment_order_line"
  ADD CONSTRAINT "bank_payment_order_line_prices_positive" CHECK (
    quoted_bank_payment_price_minor_units > 0
    AND quoted_regular_card_price_minor_units > 0
  );
