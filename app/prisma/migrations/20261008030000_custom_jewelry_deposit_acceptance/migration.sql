-- Slice 9 — the Design Deposit acceptance record.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON custom_jewelry_project
-- ============================================================================
-- A project row is MUTABLE: status advances, contact details get corrected,
-- `updated_at` moves. This record must not be. It is the evidence that a
-- specific customer accepted specific text at a specific moment before money
-- moved, and it is append-only at the database level — the same treatment
-- every other acknowledgment-bearing evidence table in this schema gets, and
-- for the same reason: the only way to be sure evidence was not quietly
-- adjusted later is to make adjusting it impossible.
--
-- ONE ACCEPTANCE PER PROJECT, enforced by a UNIQUE constraint on project_id
-- rather than by the route checking first. A double-submitted form, a
-- retried request, or two tabs must not be able to produce two acceptance
-- rows for one deposit — and "the route checks" is not a guarantee, it is an
-- intention. The route still handles the conflict gracefully; this makes the
-- bad state unrepresentable regardless.
--
-- ============================================================================
-- WHAT IS RECORDED AND WHY EACH PIECE
-- ============================================================================
-- acknowledgment_id   The Acknowledgment row — which carries the EXACT TEXT
--                     shown, the policy version it came from, the
--                     affirmative-action label the customer actually
--                     clicked, and the timestamp. NOT NULL: an acceptance
--                     without the text it accepted is not evidence of
--                     anything.
-- amount/currency     The deposit as integer MINOR UNITS plus a currency,
--                     frozen at acceptance. Never recomputed later and never
--                     read from a constant at display time: if the deposit
--                     price ever changes, this row must still say what THIS
--                     customer authorized. A disclosure saying $49 beside a
--                     charge of something else is the worst failure this
--                     surface can have, and a frozen amount is what makes
--                     the two provably agree after the fact.
-- customer_ref        The AUTHENTICATED identity, from the App Proxy's
--                     signed `logged_in_customer_id` only. NOT NULL — unlike
--                     the enquiry, which is deliberately open to signed-out
--                     visitors, authorizing a charge requires an account
--                     (docs/REQUIRED-CUSTOMER-ACCOUNTS.md; owner decision
--                     2026-10-05).
--
-- NO CHARGE IS RECORDED HERE. This table says the customer authorized the
-- deposit, not that it was collected. Collection is a separate step with its
-- own record, deliberately: conflating "agreed to pay" with "paid" is how a
-- customer gets design work started against money that never arrived.

CREATE TABLE "custom_jewelry_deposit_acceptance" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,

    "acknowledgment_id" UUID NOT NULL,

    "amount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    "customer_ref" TEXT NOT NULL,

    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_jewelry_deposit_acceptance_pkey" PRIMARY KEY ("id")
);

-- ONE per project. See the header.
CREATE UNIQUE INDEX "custom_jewelry_deposit_acceptance_project_id_key"
    ON "custom_jewelry_deposit_acceptance"("project_id");

CREATE INDEX "custom_jewelry_deposit_acceptance_customer_ref_idx"
    ON "custom_jewelry_deposit_acceptance"("customer_ref");

ALTER TABLE "custom_jewelry_deposit_acceptance"
  ADD CONSTRAINT "custom_jewelry_deposit_acceptance_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "custom_jewelry_project"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not CASCADE. Deleting a project must not be able to silently
-- destroy the record of a customer authorizing a charge.
ALTER TABLE "custom_jewelry_deposit_acceptance"
  ADD CONSTRAINT "custom_jewelry_deposit_acceptance_acknowledgment_id_fkey"
  FOREIGN KEY ("acknowledgment_id") REFERENCES "acknowledgment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A deposit of zero or a negative deposit is not a deposit. Both are signals
-- that the amount was assembled rather than taken from the pinned constant.
ALTER TABLE "custom_jewelry_deposit_acceptance"
  ADD CONSTRAINT "custom_jewelry_deposit_acceptance_amount_positive"
  CHECK ("amount_minor_units" > 0);

-- ---------------------------------------------------------------------------
-- APPEND-ONLY, at the database level.
--
-- Reuses `prevent_evidence_mutation()` (migration 20260913000100) and
-- `prevent_evidence_truncate()` (20260914000000) — the same two functions
-- every other append-only evidence table in this schema uses. Not new ones:
-- a second implementation of "refuse to change" is a second thing that can
-- be weakened independently.
--
-- ALL THREE TRIGGERS, not just UPDATE and DELETE. The truncate guard exists
-- as a separate migration precisely because the first pass at append-only
-- protection covered row-level mutation and left TRUNCATE — which is neither
-- an UPDATE nor a DELETE — able to empty the table. An evidence table with
-- two of the three guards looks protected and is not.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "custom_jewelry_deposit_acceptance_no_update"
  BEFORE UPDATE ON "custom_jewelry_deposit_acceptance"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_deposit_acceptance_no_delete"
  BEFORE DELETE ON "custom_jewelry_deposit_acceptance"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_deposit_acceptance_no_truncate"
  BEFORE TRUNCATE ON "custom_jewelry_deposit_acceptance"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE "custom_jewelry_deposit_acceptance" IS
  'Evidence that a customer affirmatively accepted the Design Deposit terms BEFORE any charge. '
  'Append-only. Records authorization, NOT collection — do not add payment-status columns here; '
  'a separate record covers whether the money actually arrived.';
