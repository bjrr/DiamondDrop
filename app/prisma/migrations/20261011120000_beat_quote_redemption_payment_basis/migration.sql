-- Slice 10 — the fallback benefit on either payment basis (owner decision
-- 2026-10-11).
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHAT THE OWNER DECIDED, AND WHY IT IS NOT STACKING
-- ============================================================================
-- The 10%-off fallback benefit may be used on Card OR Bank Payment, and the
-- benefit is calculated from the eligible merchandise subtotal ON THE BASIS THE
-- CUSTOMER CHOSE:
--
--   card          10% of the eligible Regular/Card merchandise subtotal
--   bank_payment  10% of the eligible Bank Payment merchandise subtotal
--
-- both still capped at the benefit's own maximum.
--
-- Bank Payment Price is NOT a promotional discount — it is the underlying
-- payment-basis price (`CLAUDE.md` rule 11 makes it the authoritative selling
-- price, with the Card price derived upward from it). So using the fallback
-- benefit on Bank Payment is not the prohibited stacking of amendment §3, and
-- nothing in this schema or its code may treat the bank basis as a promotion.
--
-- THE CUSTOMER CHOOSES, AND IS SHOWN WHAT THEY CHOSE. The owner was explicit:
-- do not compare the two behind the scenes and silently pick one. The basis is
-- therefore recorded per intent — not derived, not inferred, and frozen with
-- the rest of the calculation, because the discount only means anything
-- alongside the basis it was computed on.
--
-- ============================================================================
-- `failed_review` BECOMES AN ACTIVE HOLD, AND THAT IS THE IMPORTANT PART
-- ============================================================================
-- It was terminal. That is now wrong in a way that would have cost a benefit.
--
-- The owner requires that an AMBIGUOUS payment outcome — in doubt, received but
-- unverified, otherwise uncertain — must NOT auto-release, and must route to
-- staff review. If review were a terminal state sitting outside the
-- one-reservation index, moving an intent into it would have freed the benefit
-- for a second reservation while the first discounted checkout was still
-- payable. Exactly the double-use the reservation exists to prevent.
--
-- So the partial UNIQUE index now covers BOTH non-terminal states, and the
-- invariant it enforces is stated in the terms that actually matter: at most one
-- ACTIVE HOLD per benefit, where a hold is active whether it is proceeding
-- normally or waiting for a human.
--
-- Terminal is now exactly `completed` and `released` — the two states in which
-- the benefit's fate is settled. `failed_review` can still be resolved, by a
-- person, into either of them.

-- ---------------------------------------------------------------------------
-- 1. THE PAYMENT BASIS
-- ---------------------------------------------------------------------------
CREATE TYPE "beat_quote_redemption_payment_basis" AS ENUM ('card', 'bank_payment');

-- DEFAULT 'card' for the column's creation only, then dropped: every intent
-- that existed before this migration was a Card redemption, because that was
-- the only path the route offered. Leaving the default in place would let a
-- future INSERT omit the basis and silently get 'card' — and a bank redemption
-- recorded as a card one would be audited against the wrong subtotal.
ALTER TABLE "beat_quote_redemption_intent"
  ADD COLUMN "payment_basis" "beat_quote_redemption_payment_basis" NOT NULL DEFAULT 'card';
ALTER TABLE "beat_quote_redemption_intent"
  ALTER COLUMN "payment_basis" DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 2. THE BANK PAYMENT ORDER THIS RESERVATION BELONGS TO
-- ---------------------------------------------------------------------------
-- A Bank Payment redemption's payable object is a `bank_payment_order` whose
-- funds a human verifies by hand — not a Shopify order that paid itself. The
-- link is what lets verification redeem the right benefit and lets cancellation
-- release the right reservation.
--
-- NULLABLE because of the order of operations, not because it is optional: the
-- discount has to be calculated before the draft order can carry it, and the
-- `bank_payment_order` row is written after that draft exists. So the intent is
-- reserved first and the link attached immediately after, write-once, exactly
-- as `draft_order_gid` is.
ALTER TABLE "beat_quote_redemption_intent"
  ADD COLUMN "bank_payment_order_id" UUID;

ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_bank_payment_order_id_fkey"
  FOREIGN KEY ("bank_payment_order_id") REFERENCES "bank_payment_order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One bank payment order carries at most one benefit.
CREATE UNIQUE INDEX "beat_quote_redemption_intent_bank_payment_order_id_key"
    ON "beat_quote_redemption_intent"("bank_payment_order_id")
    WHERE "bank_payment_order_id" IS NOT NULL;

-- A CARD redemption must never name a bank payment order, and a COMPLETED bank
-- redemption must name one. "Redeemed on Bank Payment, but we cannot say which
-- order's funds were verified" is not a record of a redemption.
ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_basis_coherent" CHECK (
    ("payment_basis" = 'card' AND "bank_payment_order_id" IS NULL)
    OR ("payment_basis" = 'bank_payment'
        AND ("status" <> 'completed' OR "bank_payment_order_id" IS NOT NULL))
  );

-- ---------------------------------------------------------------------------
-- 3. RECONCILIATION — A PAYMENT THAT ARRIVED AFTER WE LET THE BENEFIT GO
-- ---------------------------------------------------------------------------
-- Owner decision, verbatim in substance: a late payment arriving after a
-- reservation has already been released must not silently resurrect or consume
-- the benefit. That order and payment are held for staff reconciliation.
--
-- WRITABLE ON A TERMINAL ROW, WHICH NOTHING ELSE HERE IS. These two columns
-- record an external fact about an ORDER — money turned up — rather than
-- changing the redemption's outcome. The status stays `released`, because it
-- genuinely was released; resurrecting it would be the silent consumption the
-- owner forbade. Write-once, enforced by the trigger below.
ALTER TABLE "beat_quote_redemption_intent"
  ADD COLUMN "reconciliation_required_at" TIMESTAMPTZ(6);
ALTER TABLE "beat_quote_redemption_intent"
  ADD COLUMN "reconciliation_reason" TEXT;

ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_reconciliation_has_reason" CHECK (
    ("reconciliation_required_at" IS NULL AND "reconciliation_reason" IS NULL)
    OR ("reconciliation_required_at" IS NOT NULL
        AND btrim(COALESCE("reconciliation_reason", '')) <> '')
  );

CREATE INDEX "beat_quote_redemption_intent_reconciliation_idx"
    ON "beat_quote_redemption_intent"("reconciliation_required_at")
    WHERE "reconciliation_required_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. STAFF RELEASE EVIDENCE
-- ---------------------------------------------------------------------------
-- The owner's release control is not a button that clears a row: before the
-- benefit becomes available again, the Shopify payable object must be proven
-- incapable of completing with that benefit. These columns are the evidence
-- that sequence actually ran, stored next to the thing it released rather than
-- only in an audit event — a release whose Shopify reference nobody recorded
-- cannot be checked afterwards.
ALTER TABLE "beat_quote_redemption_intent"
  ADD COLUMN "released_by_actor_ref" TEXT;
ALTER TABLE "beat_quote_redemption_intent"
  ADD COLUMN "release_shopify_ref" TEXT;

-- ---------------------------------------------------------------------------
-- 5. ONE ACTIVE HOLD PER BENEFIT — the index that now says what it means
-- ---------------------------------------------------------------------------
DROP INDEX "beat_quote_redemption_intent_one_reserved_per_benefit";

-- A HOLD IS ACTIVE WHETHER IT IS PROCEEDING OR WAITING FOR A HUMAN. See this
-- file's header: with review outside this index, flagging an ambiguous payment
-- would have freed the benefit while its discounted checkout was still payable.
CREATE UNIQUE INDEX "beat_quote_redemption_intent_one_active_hold_per_benefit"
    ON "beat_quote_redemption_intent"("benefit_id")
    WHERE "status" IN ('reserved', 'failed_review');

-- ---------------------------------------------------------------------------
-- 6. THE STATE MACHINE, RESTATED
--
-- Legal:  reserved      -> completed | released | failed_review
--         failed_review -> completed | released
-- Terminal: completed, released.
--
-- `failed_review -> reserved` is deliberately NOT legal. A human resolving a
-- review decides the benefit's fate; they do not hand it back to the automatic
-- path that could not decide. If the customer should get another go, that is a
-- release followed by a NEW reservation, which recalculates — which is also
-- what the owner requires for a recreated Bank Payment order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION beat_quote_redemption_intent_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."benefit_id" <> OLD."benefit_id"
       OR NEW."customer_ref" <> OLD."customer_ref"
       OR NEW."surface" <> OLD."surface"
       -- The basis is part of the frozen calculation: a discount means nothing
       -- without the subtotal it came from, and the subtotal depends on it.
       OR NEW."payment_basis" <> OLD."payment_basis"
       OR NEW."eligible_subtotal_minor_units" <> OLD."eligible_subtotal_minor_units"
       OR NEW."discount_minor_units" <> OLD."discount_minor_units"
       OR NEW."currency" <> OLD."currency"
       OR NEW."benefit_max_discount_minor_units" <> OLD."benefit_max_discount_minor_units"
       OR NEW."benefit_expires_at" <> OLD."benefit_expires_at"
       OR NEW."eligible_lines" <> OLD."eligible_lines"
       OR NEW."reserved_at" <> OLD."reserved_at"
    THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: the reserved calculation is immutable (intent %). '
            'Order-time verification compares against it; a mutable expectation verifies nothing.',
            OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- TERMINAL IS NOW `completed` AND `released` ONLY. `failed_review` holds the
    -- benefit and waits for a person, so it must still be resolvable.
    IF OLD."status" IN ('completed', 'released') AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: % is terminal (intent %). A completed redemption cannot be '
            'released, and a released one is resolved by a NEW reservation — which recalculates — not by '
            'editing this row.',
            OLD."status", OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- A review cannot be handed back to the automatic path. See the header.
    IF OLD."status" = 'failed_review' AND NEW."status" = 'reserved' THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: a reviewed redemption cannot return to reserved (intent %). '
            'A person resolves it to completed or released; another attempt is a new reservation.',
            OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- Write-once references. Each names a real thing in Shopify or in our own
    -- bank-payment records, and re-pointing one would move a benefit onto a
    -- different purchase after the fact.
    IF OLD."draft_order_gid" IS NOT NULL AND NEW."draft_order_gid" <> OLD."draft_order_gid" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: the draft order reference is immutable (intent %).', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    IF OLD."order_gid" IS NOT NULL AND NEW."order_gid" <> OLD."order_gid" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: the redemption order reference is immutable (intent %).', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    IF OLD."bank_payment_order_id" IS NOT NULL
       AND NEW."bank_payment_order_id" <> OLD."bank_payment_order_id" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: the bank payment order reference is immutable (intent %).', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- Reconciliation is recorded once. A second late payment against the same
    -- released reservation is a new audit event, not an overwrite of the first
    -- one — overwriting would erase the earlier discrepancy.
    IF OLD."reconciliation_required_at" IS NOT NULL
       AND (NEW."reconciliation_required_at" <> OLD."reconciliation_required_at"
            OR COALESCE(NEW."reconciliation_reason", '') <> COALESCE(OLD."reconciliation_reason", ''))
    THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: reconciliation is recorded once (intent %). A further '
            'discrepancy is a new audit event, not an edit that erases the first.',
            OLD."id"
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN "beat_quote_redemption_intent"."payment_basis" IS
  'Which payment basis the customer chose, and therefore which merchandise subtotal the benefit was '
  'calculated from. Frozen with the rest of the calculation. Bank Payment Price is the underlying '
  'payment-basis price rather than a promotional discount, so a bank-basis redemption is not stacking.';

COMMENT ON COLUMN "beat_quote_redemption_intent"."bank_payment_order_id" IS
  'The bank payment order whose manually verified funds will redeem this benefit. Null for card '
  'redemptions, and null between reserving and attaching for bank ones. Write-once.';

COMMENT ON COLUMN "beat_quote_redemption_intent"."reconciliation_required_at" IS
  'Set when money arrived against an order whose reservation had already been released. The status '
  'stays released on purpose: resurrecting it would be the silent consumption the owner forbade. A '
  'person reconciles the order and the payment.';
