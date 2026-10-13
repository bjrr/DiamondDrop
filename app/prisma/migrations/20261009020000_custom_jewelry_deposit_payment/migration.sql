-- Slice 9 — the Design Deposit PAYMENT record.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- THE THIRD AND LAST OF THREE SEPARATE FACTS
-- ============================================================================
--   acceptance — the customer agreed to the terms
--   invoice    — we asked them for the money
--   payment    — the money arrived            <- this table
--
-- Three tables rather than one row with three nullable timestamps, and that
-- is deliberate. A single mutable row would make "agreed", "asked" and "paid"
-- fields that can be set, cleared and re-set; as separate append-only records
-- each is a thing that happened, in order, and none can be un-happened.
-- Conflating the last two in particular is how design work starts against
-- money that never arrived.
--
-- ============================================================================
-- FK TO THE INVOICE, UNIQUE
-- ============================================================================
-- A payment cannot exist without the invoice it pays — and therefore cannot
-- exist without the acceptance behind that invoice, since the invoice's own FK
-- already guarantees it. The chain is enforced at every link rather than
-- re-checked at the end.
--
-- UNIQUE because one invoice is paid once. Shopify can redeliver the same
-- `orders/paid` event, and the receive layer already dedupes by event id — but
-- redelivery is not the only way a second write could be attempted (a replayed
-- payload, a manual reconciliation script), and the index does not care which.
--
-- ============================================================================
-- WHAT IS RECORDED
-- ============================================================================
-- order_gid       The REAL Shopify order, not the draft. Also UNIQUE: one
--                 order pays one deposit, so a second invoice can never be
--                 marked paid by the same order.
-- amount/currency What actually arrived, from the order — NOT copied from the
--                 invoice. The handler refuses to record a payment whose
--                 amount differs from the invoice, so in practice these
--                 agree; storing the OBSERVED figure rather than the expected
--                 one is what makes that a verified fact instead of an
--                 assumption.
-- paid_at         Shopify's own timestamp for the payment, not our clock.

CREATE TABLE "custom_jewelry_deposit_payment" (
    "id" UUID NOT NULL,

    "invoice_id" UUID NOT NULL,

    /* The real order, not the draft order. */
    "order_gid" TEXT NOT NULL,

    /* OBSERVED, not copied from the invoice — see the header. */
    "amount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    /* Shopify's timestamp for the payment. */
    "paid_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_jewelry_deposit_payment_pkey" PRIMARY KEY ("id")
);

-- One invoice is paid once.
CREATE UNIQUE INDEX "custom_jewelry_deposit_payment_invoice_id_key"
    ON "custom_jewelry_deposit_payment"("invoice_id");

-- And one order pays one deposit — so the same order cannot be used to mark a
-- second invoice paid.
CREATE UNIQUE INDEX "custom_jewelry_deposit_payment_order_gid_key"
    ON "custom_jewelry_deposit_payment"("order_gid");

ALTER TABLE "custom_jewelry_deposit_payment"
  ADD CONSTRAINT "custom_jewelry_deposit_payment_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "custom_jewelry_deposit_invoice"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_jewelry_deposit_payment"
  ADD CONSTRAINT "custom_jewelry_deposit_payment_amount_positive"
  CHECK ("amount_minor_units" > 0);

-- ---------------------------------------------------------------------------
-- APPEND-ONLY, all three guards, reusing the shared functions.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "custom_jewelry_deposit_payment_no_update"
  BEFORE UPDATE ON "custom_jewelry_deposit_payment"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_deposit_payment_no_delete"
  BEFORE DELETE ON "custom_jewelry_deposit_payment"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_deposit_payment_no_truncate"
  BEFORE TRUNCATE ON "custom_jewelry_deposit_payment"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE "custom_jewelry_deposit_payment" IS
  'Evidence that a Design Deposit was actually PAID. Append-only. The amount is what was OBSERVED on the '
  'Shopify order, not copied from the invoice — the handler refuses a mismatch, and storing the observed '
  'figure is what makes that a verified fact rather than an assumption.';
