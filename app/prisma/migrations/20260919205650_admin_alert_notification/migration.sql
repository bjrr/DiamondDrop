-- Slice 2 stage 2A (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §7/§15).
--
-- admin_alert_notification -- dedup ledger for the "notify the admin" half
-- of both failure state machines (price_calculation_failure,
-- migration 20260919090500; price_sync_failure, migration 20260919085156).
-- Neither of those tables is touched here. One row per (episode,
-- meaningful transition): the UNIQUE constraint on
-- (source_kind, source_id, event) IS the dedup -- see the model doc comment
-- in schema.prisma and app/db/repositories/adminAlertDispatch.server.ts.

-- CreateEnum
CREATE TYPE "admin_alert_source_kind" AS ENUM ('calculation_failure', 'sync_failure');

-- CreateEnum
CREATE TYPE "admin_alert_event" AS ENUM ('opened', 'suspended', 'resolved');

-- CreateEnum
CREATE TYPE "admin_alert_email_delivery_status" AS ENUM ('sent', 'skipped_unconfigured', 'failed');

-- CreateTable
CREATE TABLE "admin_alert_notification" (
    "id" UUID NOT NULL,
    "source_kind" "admin_alert_source_kind" NOT NULL,
    "source_id" UUID NOT NULL,
    "event" "admin_alert_event" NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "email_delivery_status" "admin_alert_email_delivery_status" NOT NULL,
    "email_delivery_reason" TEXT,
    "email_provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_alert_notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_alert_notification_master_variant_id_idx" ON "admin_alert_notification"("master_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_alert_notification_source_kind_source_id_event_key" ON "admin_alert_notification"("source_kind", "source_id", "event");

-- AddForeignKey
ALTER TABLE "admin_alert_notification" ADD CONSTRAINT "admin_alert_notification_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
