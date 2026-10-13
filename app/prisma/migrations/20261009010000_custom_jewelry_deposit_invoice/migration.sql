-- Slice 9 — the Design Deposit INVOICE record.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- THE MONEY-CRITICAL INVARIANT IS ENFORCED BY THE SCHEMA, NOT BY A CHECK IN
-- THE ROUTE
-- ============================================================================
-- No deposit invoice may exist without a recorded acceptance of the deposit
-- terms. That is the whole point of the acceptance step: the customer must
-- have affirmatively agreed to the four disclosures BEFORE being asked for
-- money.
--
-- So this table's foreign key points at `custom_jewelry_deposit_acceptance`
-- and is NOT NULL — not at `custom_jewelry_project`, which would have let an
-- invoice exist for a project with no acceptance. An invoice without an
-- acceptance is now literally unrepresentable; a route that forgot to check
-- cannot create one, and neither can a careless manual INSERT.
--
-- The project is reachable through the acceptance (which is UNIQUE per
-- project), so no separate project_id column is needed and there is no way
-- for the two to disagree about which project this is.
--
-- ============================================================================
-- ONE OUTSTANDING INVOICE PER ACCEPTANCE
-- ============================================================================
-- UNIQUE on acceptance_id. Re-issuing an invoice for a deposit that already
-- has one would mean two live payment links for one $49 — and a customer who
-- paid both. Replacing an invoice is therefore not an UPDATE to this row
-- (the table is append-only); it is a cancellation recorded elsewhere plus a
-- new acceptance, which keeps the trail of what was asked for and when.
--
-- ============================================================================
-- WHAT IS *NOT* STORED
-- ============================================================================
-- NOT the invoice URL. Shopify's invoice URL is a live payment link; it is
-- already emailed to the customer by Shopify itself, and staff can reach it
-- from the Shopify admin via the draft-order gid stored here. Persisting a
-- payment link in our own database adds a second place it can leak from and
-- buys nothing.
--
-- NOT payment status. This records that an invoice was ISSUED. Whether the
-- money arrived is a separate fact with a separate record — conflating the
-- two is how design work starts against funds that never came.

CREATE TABLE "custom_jewelry_deposit_invoice" (
    "id" UUID NOT NULL,

    "acceptance_id" UUID NOT NULL,

    /* The Shopify draft order this invoice belongs to. */
    "draft_order_gid" TEXT NOT NULL,

    /* Frozen, exactly as on the acceptance — and asserted equal to it by the
       issuing code, so an invoice can never ask for an amount the customer
       did not authorize. */
    "amount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    "issued_by_actor_type" "actor_type" NOT NULL,
    "issued_by_actor_ref" TEXT,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_jewelry_deposit_invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_jewelry_deposit_invoice_acceptance_id_key"
    ON "custom_jewelry_deposit_invoice"("acceptance_id");

-- Looking up "which project is this Shopify draft order for?" when a webhook
-- arrives carrying only the order.
CREATE UNIQUE INDEX "custom_jewelry_deposit_invoice_draft_order_gid_key"
    ON "custom_jewelry_deposit_invoice"("draft_order_gid");

-- THE INVARIANT. NOT NULL + RESTRICT: an invoice cannot exist without the
-- acceptance that authorized it, and the acceptance cannot be removed out
-- from under it (it is append-only anyway, so RESTRICT is belt and braces).
ALTER TABLE "custom_jewelry_deposit_invoice"
  ADD CONSTRAINT "custom_jewelry_deposit_invoice_acceptance_id_fkey"
  FOREIGN KEY ("acceptance_id") REFERENCES "custom_jewelry_deposit_acceptance"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_jewelry_deposit_invoice"
  ADD CONSTRAINT "custom_jewelry_deposit_invoice_amount_positive"
  CHECK ("amount_minor_units" > 0);

-- ---------------------------------------------------------------------------
-- APPEND-ONLY, all three guards. Reuses the shared functions from migrations
-- 20260913000100 and 20260914000000 — a second implementation of "refuse to
-- change" is a second thing that can be weakened independently.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "custom_jewelry_deposit_invoice_no_update"
  BEFORE UPDATE ON "custom_jewelry_deposit_invoice"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_deposit_invoice_no_delete"
  BEFORE DELETE ON "custom_jewelry_deposit_invoice"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_deposit_invoice_no_truncate"
  BEFORE TRUNCATE ON "custom_jewelry_deposit_invoice"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE "custom_jewelry_deposit_invoice" IS
  'A Design Deposit invoice that was ISSUED. Append-only. The NOT NULL FK to '
  'custom_jewelry_deposit_acceptance is the money-critical invariant: no invoice can exist without the '
  'customer having affirmatively accepted the deposit terms first. Do not re-point this FK at the project, '
  'and do not add payment-status columns — whether the money arrived is a separate fact.';
