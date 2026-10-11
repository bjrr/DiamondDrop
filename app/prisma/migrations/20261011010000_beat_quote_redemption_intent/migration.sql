-- Slice 10 — redemption of the 10%-off fallback benefit.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY A RESERVATION AND NOT JUST A `redeemed_at` STAMP
-- ============================================================================
-- Owner decision: redemption goes through a CaratForUs-controlled Draft Order
-- so the exact benefit amount is calculated BEFORE checkout. That creates a
-- gap — the draft order exists, the customer has not paid — and the benefit
-- must be unusable elsewhere during it without being spent.
--
-- Marking the benefit redeemed when the draft order is created would consume it
-- on an abandoned checkout. Marking it only at payment would let two
-- simultaneous checkouts both carry the discount. So the gap gets its own row
-- with its own lifecycle:
--
--   reserved       a draft order is being/has been created for this benefit
--   completed      a real order paid; the benefit is spent
--   released       abandoned or failed; the benefit is usable again
--   failed_review  order-time verification disagreed with what we calculated;
--                  a human must look before anything is called redeemed
--
-- `failed_review` is deliberately NOT a silent success and not a release. A
-- mismatch between the discount we calculated and the discount the order
-- actually carries is either our bug or someone's tampering, and both deserve
-- a person rather than an automatic verdict.
--
-- ============================================================================
-- THE CONCURRENCY BOUNDARY IS THE DATABASE, AS ALWAYS
-- ============================================================================
-- A partial UNIQUE index allows at most ONE `reserved` intent per benefit, and
-- another allows at most one `completed`. Two simultaneous redemption attempts
-- therefore converge on one usable purchase no matter what the application
-- does, and a second completion is unrepresentable rather than merely
-- unexpected.

CREATE TYPE "beat_quote_redemption_status" AS ENUM ('reserved', 'completed', 'released', 'failed_review');

-- ONLY THE ELIGIBLE SURFACES EXIST IN THIS TYPE. Amendment §3 excludes
-- Community Group Buys and Luxury Steals, so they are not members: a redemption
-- against one cannot be written at all, rather than being refused by a check
-- somebody has to remember. A later locked policy that changes this would add
-- an enum value, which is a visible migration.
CREATE TYPE "beat_quote_redemption_surface" AS ENUM ('buy_now', 'custom_jewelry');

CREATE TABLE "beat_quote_redemption_intent" (
    "id" UUID NOT NULL,

    "benefit_id" UUID NOT NULL,

    /* The AUTHENTICATED customer attempting redemption. Compared against the
       benefit's own customer_ref by the reserving code — the benefit is
       non-transferable, and a browser-supplied relationship is never trusted. */
    "customer_ref" TEXT NOT NULL,

    "surface" "beat_quote_redemption_surface" NOT NULL,

    /* ========================================================================
       THE CALCULATION, FROZEN AT RESERVATION
       ========================================================================
       Everything needed to re-derive and audit the discount, so order-time
       verification compares against what was actually promised rather than
       recomputing from a cart that may have changed.

       eligible_subtotal  MERCHANDISE ONLY. Excludes tax, shipping, duties,
                          tips and any non-merchandise charge, and excludes
                          Group Buy and Luxury Steals lines entirely. A
                          percentage of a total that includes tax is a bigger
                          benefit than the one promised.
       discount           min(10% of that subtotal, the benefit's own cap). */
    "eligible_subtotal_minor_units" BIGINT NOT NULL,
    "discount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    /* COPIED FROM THE BENEFIT AT RESERVATION, not read back at verification
       time. Two reasons: a CHECK can only reference columns in its own row, so
       the cap has to be here for the database to enforce it; and if the
       benefit's terms were ever corrected, this intent must still be judged
       against what it was actually created under. */
    "benefit_max_discount_minor_units" BIGINT NOT NULL,
    "benefit_expires_at" TIMESTAMPTZ(6) NOT NULL,

    /* A frozen snapshot of the lines the discount was calculated from.
       Evidence, not a working copy: order-time verification needs to know what
       we priced, and a cart is not a stable thing to point at. */
    "eligible_lines" JSONB NOT NULL,

    "draft_order_gid" TEXT,
    "order_gid" TEXT,

    "status" "beat_quote_redemption_status" NOT NULL DEFAULT 'reserved',
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "release_reason" TEXT,
    "review_reason" TEXT,

    CONSTRAINT "beat_quote_redemption_intent_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_benefit_id_fkey"
  FOREIGN KEY ("benefit_id") REFERENCES "beat_quote_fallback_benefit"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AT MOST ONE LIVE RESERVATION PER BENEFIT. This is what makes two concurrent
-- redemption attempts converge on one usable purchase.
CREATE UNIQUE INDEX "beat_quote_redemption_intent_one_reserved_per_benefit"
    ON "beat_quote_redemption_intent"("benefit_id")
    WHERE "status" = 'reserved';

-- AND AT MOST ONE COMPLETED REDEMPTION PER BENEFIT. Single use, as a
-- constraint rather than as a field somebody checks.
CREATE UNIQUE INDEX "beat_quote_redemption_intent_one_completed_per_benefit"
    ON "beat_quote_redemption_intent"("benefit_id")
    WHERE "status" = 'completed';

-- One draft order and one real order belong to one intent.
CREATE UNIQUE INDEX "beat_quote_redemption_intent_draft_order_gid_key"
    ON "beat_quote_redemption_intent"("draft_order_gid")
    WHERE "draft_order_gid" IS NOT NULL;
CREATE UNIQUE INDEX "beat_quote_redemption_intent_order_gid_key"
    ON "beat_quote_redemption_intent"("order_gid")
    WHERE "order_gid" IS NOT NULL;

CREATE INDEX "beat_quote_redemption_intent_status_idx" ON "beat_quote_redemption_intent"("status");
CREATE INDEX "beat_quote_redemption_intent_customer_ref_idx" ON "beat_quote_redemption_intent"("customer_ref");

-- ---------------------------------------------------------------------------
-- COHERENCE. Each makes a state policy forbids unrepresentable.
-- ---------------------------------------------------------------------------

-- Money must be positive and the discount cannot exceed either the benefit's
-- own frozen cap or the goods it is discounting. "maximum $100" and "you cannot
-- discount more than the merchandise" are both enforced here rather than
-- trusted to the calculation that produced them.
ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_amounts_sane" CHECK (
    "eligible_subtotal_minor_units" > 0
    AND "discount_minor_units" > 0
    AND "discount_minor_units" <= "benefit_max_discount_minor_units"
    AND "discount_minor_units" <= "eligible_subtotal_minor_units"
  );

-- A completed redemption names its order and its moment. "Redeemed, but we do
-- not know on what" is not a record of a redemption.
ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_completion_complete" CHECK (
    ("status" <> 'completed')
    OR ("completed_at" IS NOT NULL AND "order_gid" IS NOT NULL)
  );

-- A release carries its reason, so an abandoned checkout and a failed one are
-- distinguishable afterwards.
ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_release_has_reason" CHECK (
    ("status" <> 'released')
    OR ("released_at" IS NOT NULL AND btrim(COALESCE("release_reason", '')) <> '')
  );

-- And a review state says what disagreed.
ALTER TABLE "beat_quote_redemption_intent"
  ADD CONSTRAINT "beat_quote_redemption_intent_review_has_reason" CHECK (
    ("status" <> 'failed_review') OR (btrim(COALESCE("review_reason", '')) <> '')
  );

-- ---------------------------------------------------------------------------
-- THE STATE MACHINE, ENFORCED.
--
-- Legal: reserved -> completed | released | failed_review.
-- Nothing else moves. In particular a completed redemption is FINAL: it cannot
-- be released back into usability, re-pointed at another order, or re-valued.
-- The frozen calculation is immutable throughout, because order-time
-- verification compares against it — a mutable expectation verifies nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION beat_quote_redemption_intent_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."benefit_id" <> OLD."benefit_id"
       OR NEW."customer_ref" <> OLD."customer_ref"
       OR NEW."surface" <> OLD."surface"
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

    IF OLD."status" <> 'reserved' AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: % is terminal (intent %). A completed redemption cannot be '
            'released, and a released or reviewed one is resolved by a NEW reservation, not by editing '
            'this row.',
            OLD."status", OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- The draft order reference is written once, when the draft is created.
    IF OLD."draft_order_gid" IS NOT NULL AND NEW."draft_order_gid" <> OLD."draft_order_gid" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: the draft order reference is immutable (intent %).', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- As is the real order reference, once set.
    IF OLD."order_gid" IS NOT NULL AND NEW."order_gid" <> OLD."order_gid" THEN
        RAISE EXCEPTION
            'beat_quote_redemption_intent: the redemption order reference is immutable (intent %).', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "beat_quote_redemption_intent_guard"
  BEFORE UPDATE ON "beat_quote_redemption_intent"
  FOR EACH ROW EXECUTE FUNCTION beat_quote_redemption_intent_guard();

-- Deleting an intent would erase the record of a benefit having been offered
-- against a purchase. A reservation that should not have happened is RELEASED.
CREATE TRIGGER "beat_quote_redemption_intent_no_delete"
  BEFORE DELETE ON "beat_quote_redemption_intent"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "beat_quote_redemption_intent_no_truncate"
  BEFORE TRUNCATE ON "beat_quote_redemption_intent"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE "beat_quote_redemption_intent" IS
  'The reservation gap between calculating a fallback discount and the customer paying. Partial UNIQUE '
  'indexes allow one reserved and one completed intent per benefit, which is what makes concurrent '
  'redemption attempts converge on one usable purchase. The frozen calculation is immutable because '
  'order-time verification compares against it. Group Buy and Luxury Steals are absent from the surface '
  'enum, so a redemption against them is unrepresentable rather than merely refused.';
