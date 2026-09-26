-- D33 review follow-up (team-lead): the guest verification email's
-- fire-and-forget dispatch outcome was recorded only in logs -- not
-- queryable, not the durable record a support agent looking at THIS row
-- needs. Mirrors 20260922042507_bank_payment_order_cancellation_email_delivery
-- exactly in shape and reasoning: a SEPARATE enum from both
-- `bank_payment_cancellation_email_status` and
-- `admin_alert_email_delivery_status`, even though the members are
-- identical, because each records a different, independent email send -- see
-- WarrantyOrderLookupVerification.verificationEmailStatus's own doc comment
-- in schema.prisma.

-- CreateEnum
CREATE TYPE "warranty_order_lookup_verification_email_status" AS ENUM ('sent', 'skipped_unconfigured', 'failed');

-- AlterTable
ALTER TABLE "warranty_order_lookup_verification" ADD COLUMN     "verification_email_attempted_at" TIMESTAMPTZ(6),
ADD COLUMN     "verification_email_provider_message_id" TEXT,
ADD COLUMN     "verification_email_status" "warranty_order_lookup_verification_email_status";

-- Two invariants, matching the bank-payment twin's own pair (that migration
-- also has a third, "implies cancelled", constraint this table has no
-- analogue for -- every row here always attempts a dispatch, there is no
-- separate lifecycle status to condition on).
ALTER TABLE "warranty_order_lookup_verification"
  ADD CONSTRAINT "warranty_order_lookup_verification_email_attempted_pairing" CHECK (
    (verification_email_status IS NULL) = (verification_email_attempted_at IS NULL)
  );

ALTER TABLE "warranty_order_lookup_verification"
  ADD CONSTRAINT "warranty_order_lookup_verification_email_message_id_only_when_sent" CHECK (
    verification_email_provider_message_id IS NULL OR verification_email_status = 'sent'
  );
