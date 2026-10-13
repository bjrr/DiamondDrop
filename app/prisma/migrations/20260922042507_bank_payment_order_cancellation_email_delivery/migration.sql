-- Slice 2C-b (docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §13/§14; owner
-- verification list on the live run). Closes two gaps: the cancellation
-- email's provider message id was discarded entirely, and its delivery
-- outcome lived only in a log line -- not queryable, not the "persistent"
-- record the owner's list requires.
--
-- A SEPARATE enum from `admin_alert_email_delivery_status`, deliberately,
-- even though the members are identical. That enum records whether the
-- ADMIN alert email was delivered; this one records whether the CUSTOMER
-- cancellation email was. Reusing one type for both would assert a
-- relationship between two independent sends (different recipients,
-- different failure modes) that does not exist -- see the enum's own doc
-- comment in schema.prisma.

-- CreateEnum
CREATE TYPE "bank_payment_cancellation_email_status" AS ENUM ('sent', 'skipped_unconfigured', 'failed');

-- AlterTable
ALTER TABLE "bank_payment_order" ADD COLUMN     "cancellation_email_attempted_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancellation_email_provider_message_id" TEXT,
ADD COLUMN     "cancellation_email_status" "bank_payment_cancellation_email_status";

-- COHERENCE. `bank_payment_order_status_coherent` (migration 20260919085156)
-- already governs cancelled_at/completed_at/verified_at against `status`;
-- these three constraints are kept SEPARATE from it rather than folded in,
-- matching this table's existing style of one single-purpose CHECK per
-- concern (see `bank_payment_order_verification_pairing`,
-- `bank_payment_order_cancellation_pairing` in that same migration).
--
-- Three invariants, not four: a cancelled order is NOT required to carry a
-- non-null `cancellation_email_status` here. Persisting the delivery
-- outcome is itself fallible (network/DB hiccup after the cancellation has
-- already committed), and the whole point of this feature is that such a
-- failure must never reverse the cancellation -- so a cancelled order with
-- a NULL email status is a valid, if unwelcome, state: the cancellation
-- happened and holds; the delivery record for it simply never got written.
ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_cancellation_email_implies_cancelled" CHECK (
    cancellation_email_status IS NULL OR status = 'cancelled'
  );

ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_cancellation_email_attempted_pairing" CHECK (
    (cancellation_email_status IS NULL) = (cancellation_email_attempted_at IS NULL)
  );

ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_cancellation_email_message_id_only_when_sent" CHECK (
    cancellation_email_provider_message_id IS NULL OR cancellation_email_status = 'sent'
  );
