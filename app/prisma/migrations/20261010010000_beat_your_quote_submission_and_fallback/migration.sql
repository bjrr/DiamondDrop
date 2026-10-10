-- Slice 10 — "Let Us Beat Your Quote!" submissions and the 10%-off fallback.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- Authoritative sources, in precedence order:
--   1. docs/LET-US-BEAT-YOUR-QUOTE-AMENDMENT.md  (owner-locked 2026-09-13)
--   2. docs/LET-US-BEAT-YOUR-QUOTE.md            (owner-locked)
--
-- THE AMENDMENT CONTROLS AND IT INVERTS THE ORIGINAL'S HEADLINE RULE. The
-- original §2 is titled "Active Online Listed Item — Guarantee Eligible When
-- Qualified"; amendment §1 supersedes it entirely — an online listing is
-- review-only with no guarantee and no fallback. The same applies to a
-- competing Group Buy. Exactly ONE path carries the guarantee: a custom quote
-- at most 7 calendar days old that CaratForUs has verified.
--
-- ============================================================================
-- MVP1 REVIEW IS MANUAL, AND THE SCHEMA REFLECTS THAT
-- ============================================================================
-- The specification's Implementation Principle forbids "an automated engine
-- that commits CaratForUs to matching or beating a competitor based solely on
-- uploaded documents or scraped prices". So nothing here records a decision to
-- match a price; the columns capture intake, the frozen age/treatment, the
-- reviewer's verification outcome, and whatever offer a human then made.

CREATE TYPE "beat_quote_submission_kind" AS ENUM ('custom_quote', 'online_listing', 'competing_group_buy');

-- 'pending' is the initial state and is deliberately NOT eligible for the
-- guarantee: treating "not yet checked" as acceptable is how an unverifiable
-- quote earns a $100 benefit.
CREATE TYPE "beat_quote_verification_outcome" AS ENUM ('pending', 'verified', 'rejected');

-- Derived at intake from kind + age + verification, never chosen by the
-- customer. The spec: "The system should determine eligibility from the
-- submitted information rather than requiring the customer to classify their
-- own guarantee status."
CREATE TYPE "beat_quote_treatment" AS ENUM ('guarantee', 'review_only');

CREATE TYPE "beat_quote_submission_status" AS ENUM (
    'submitted',
    'in_review',
    -- CaratForUs made an offer at or below the competitor price. For a
    -- guarantee submission this FULFILS the guarantee and owes no fallback
    -- (amendment §4 case 5).
    'offer_made',
    -- CaratForUs cannot match or beat. For a guarantee submission this is the
    -- state that owes a fallback (amendment §4 case 6).
    'declined_cannot_beat',
    -- Not a qualifying submission at all: fabricated, altered, unverifiable,
    -- non-comparable. Owes nothing (original §"10%-Off Fallback Rules").
    'rejected',
    'customer_accepted',
    'closed'
);

CREATE TABLE "beat_quote_submission" (
    "id" UUID NOT NULL,

    /* Customer-facing reference, e.g. "BQ-7Q2MPX4N". Unambiguous alphabet so
       it survives being read aloud to support, same as every other reference
       in this schema. */
    "submission_reference" TEXT NOT NULL,

    /* The authenticated Shopify customer WHEN there is one. The spec asks for
       the account id "if available", so this is nullable — the feature is an
       acquisition tool and must not require an account to use. */
    "customer_ref" TEXT,

    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,

    "kind" "beat_quote_submission_kind" NOT NULL,

    /* ========================================================================
       THE FROZEN ELIGIBILITY FACTS
       ========================================================================
       quote_issued_on, submitted_on, quote_age_calendar_days and treatment are
       all computed ONCE, at intake, and never recomputed.

       A quote does not become ineligible because review took four days. If
       `treatment` were derived at read time from `now()`, a submission that was
       guarantee-eligible when it arrived would silently lose the guarantee
       while sitting in a queue — the customer's position changing because of
       our latency. Freezing is the same discipline the Group Buy campaign
       applies to its price basis at open.

       DATE, not timestamptz, for the two dates. The rule is stated in CALENDAR
       days and calendar days are a property of a place, not of an instant: a
       quote dated the 1st submitted late on the 8th is 7 days old locally and 8
       in UTC, and that single day is the whole difference between a guaranteed
       match-or-beat plus $100 and a discretionary review. */
    "quote_issued_on" DATE,
    "submitted_on" DATE NOT NULL,
    "quote_age_calendar_days" INTEGER,
    "treatment" "beat_quote_treatment" NOT NULL,

    "competitor_seller_name" TEXT,
    "competitor_website" TEXT,
    /* The live product/Group Buy URL. STORED AS TEXT AND NEVER FETCHED
       SERVER-SIDE — a server that retrieves a customer-supplied URL is an SSRF
       primitive. Staff open it in a browser, where it is an ordinary untrusted
       link. Same treatment as Custom Jewelry's inspiration links. */
    "listing_url" TEXT,

    /* Integer minor units plus a currency, never a float (CLAUDE.md rule 6).
       Overseas sellers are explicitly in scope, so the currency is not
       assumed. */
    "competitor_price_minor_units" BIGINT,
    "competitor_price_currency" CHAR(3),

    /* The like-for-like specification package, as submitted. Free text plus
       files (recorded separately); the spec lists ~15 possible attributes and
       says CaratForUs "may decline guarantee eligibility when the submitted
       information is insufficient", so this is evidence for a human rather
       than a structured schema to validate against. */
    "specifications" TEXT,

    /* Competitor SERVICE terms — explicitly NOT terms CaratForUs promises to
       match (original §"Required Competitor-Service Information"). Nullable
       because every question supports "I don't know". */
    "competitor_timeline" TEXT,
    "competitor_return_policy" TEXT,
    "competitor_warranty" TEXT,

    "status" "beat_quote_submission_status" NOT NULL DEFAULT 'submitted',
    "verification" "beat_quote_verification_outcome" NOT NULL DEFAULT 'pending',

    /* CaratForUs's own verification evidence, captured at verification time:
       what was checked, where, and when. The spec is explicit that
       "customer-provided screenshots alone do not establish eligibility". */
    "verification_evidence" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_actor_ref" TEXT,

    /* Whatever offer a human made, if any. */
    "offered_price_minor_units" BIGINT,
    "offered_price_currency" CHAR(3),
    "offer_terms_shown" TEXT,
    "decision_reason" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_actor_ref" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beat_quote_submission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "beat_quote_submission_submission_reference_key"
    ON "beat_quote_submission"("submission_reference");
CREATE INDEX "beat_quote_submission_customer_ref_idx" ON "beat_quote_submission"("customer_ref");
CREATE INDEX "beat_quote_submission_status_idx" ON "beat_quote_submission"("status");
CREATE INDEX "beat_quote_submission_treatment_idx" ON "beat_quote_submission"("treatment");

-- ---------------------------------------------------------------------------
-- COHERENCE CONSTRAINTS. Each one makes a state that policy forbids
-- unrepresentable, rather than relying on application code to avoid writing
-- it.
-- ---------------------------------------------------------------------------

-- A custom quote has an issue date and an age; the other two kinds have
-- NEITHER, because amendment §1 removes the age rule for them entirely ("There
-- is no 7-day age rule for an active online listing because the listing is
-- review-only"). Storing an age for them would invite someone to compare it
-- against 7.
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_age_only_for_custom_quote" CHECK (
    ("kind" = 'custom_quote' AND "quote_issued_on" IS NOT NULL AND "quote_age_calendar_days" IS NOT NULL)
    OR
    ("kind" <> 'custom_quote' AND "quote_issued_on" IS NULL AND "quote_age_calendar_days" IS NULL)
  );

-- THE AMENDMENT, AS A DATABASE CONSTRAINT. Only a custom quote may ever carry
-- the guarantee treatment. An online listing or competing Group Buy marked
-- 'guarantee' is not a bug to be found in review — it cannot be written.
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_guarantee_requires_custom_quote" CHECK (
    "treatment" = 'review_only' OR "kind" = 'custom_quote'
  );

-- And the 7-day window, likewise. A guarantee treatment on a quote older than
-- the window is unrepresentable. The window is inlined deliberately: a CHECK
-- cannot reference a constant, and a policy change would be a new migration
-- anyway, which is the right amount of friction for this number.
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_guarantee_within_window" CHECK (
    "treatment" = 'review_only'
    OR ("quote_age_calendar_days" >= 0 AND "quote_age_calendar_days" <= 7)
  );

-- Both halves of a money amount or neither, for each of the two prices.
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_competitor_price_coherent" CHECK (
    ("competitor_price_minor_units" IS NULL) = ("competitor_price_currency" IS NULL)
  );
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_offered_price_coherent" CHECK (
    ("offered_price_minor_units" IS NULL) = ("offered_price_currency" IS NULL)
  );
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_prices_non_negative" CHECK (
    COALESCE("competitor_price_minor_units", 0) >= 0 AND COALESCE("offered_price_minor_units", 0) >= 0
  );

-- A verification outcome that is not 'pending' is a decision somebody made, so
-- it carries who and when. An audit trail with an anonymous verdict on a
-- $100-bearing decision is not an audit trail.
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_verification_attributed" CHECK (
    "verification" = 'pending'
    OR ("verified_at" IS NOT NULL AND "verified_by_actor_ref" IS NOT NULL)
  );

-- ===========================================================================
-- THE 10%-OFF FALLBACK BENEFIT (amendment §3)
-- ===========================================================================
CREATE TABLE "beat_quote_fallback_benefit" (
    "id" UUID NOT NULL,

    /* ========================================================================
       THE DUPLICATE-ISSUANCE CONSTRAINT
       ========================================================================
       Amendment §3: "Duplicate/retried issuance must not create multiple
       fallback benefits from the same qualifying outcome." Case 8 of §4 repeats
       it. UNIQUE on submission_id is what makes that true — not a check in the
       issuing code, which is enforced by whoever remembers to call it. A
       retried job, a double-clicked button and two concurrent requests all
       lose to the index. */
    "submission_id" UUID NOT NULL,

    /* What the customer quotes to redeem. UNIQUE, and unguessable — generated
       from CSPRNG bytes, never a sequence. */
    "benefit_code" TEXT NOT NULL,

    /* NOT NULL, unlike the submission's. Amendment §3 says non-transferable,
       which is meaningless without an identity to bind to — so a benefit
       cannot be issued to nobody even though a submission can be made by an
       unauthenticated visitor. */
    "customer_ref" TEXT NOT NULL,

    /* ========================================================================
       THE TERMS, FROZEN AT ISSUANCE
       ========================================================================
       Stored rather than read from a constant at redemption time. If the owner
       later changes the benefit to 15% or a $150 cap, every ALREADY-ISSUED
       benefit must still be worth exactly what its holder was promised.
       Reading today's constant at redemption would silently restate a
       customer's benefit months after the fact. */
    "percent" SMALLINT NOT NULL,
    "max_discount_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    /* Stored, not derived, for the same reason: a change to the validity period
       must not retroactively expire or extend what is already out there. */
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    /* SINGLE USE. NULL until spent; set exactly once, enforced by the trigger
       below rather than by convention. */
    "redeemed_at" TIMESTAMPTZ(6),
    /* "redemption order where used" (amendment §3). */
    "redemption_order_ref" TEXT,
    "redemption_discount_minor_units" BIGINT,

    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    /* "any manual override/reason" (amendment §3). */
    "override_reason" TEXT,
    "override_by_actor_ref" TEXT,

    "issued_by_actor_type" "actor_type" NOT NULL,
    "issued_by_actor_ref" TEXT,

    CONSTRAINT "beat_quote_fallback_benefit_pkey" PRIMARY KEY ("id")
);

-- ONE BENEFIT PER QUALIFYING OUTCOME. See the column comment.
CREATE UNIQUE INDEX "beat_quote_fallback_benefit_submission_id_key"
    ON "beat_quote_fallback_benefit"("submission_id");
CREATE UNIQUE INDEX "beat_quote_fallback_benefit_benefit_code_key"
    ON "beat_quote_fallback_benefit"("benefit_code");
CREATE INDEX "beat_quote_fallback_benefit_customer_ref_idx"
    ON "beat_quote_fallback_benefit"("customer_ref");
-- One order cannot spend two benefits.
CREATE UNIQUE INDEX "beat_quote_fallback_benefit_redemption_order_ref_key"
    ON "beat_quote_fallback_benefit"("redemption_order_ref")
    WHERE "redemption_order_ref" IS NOT NULL;

ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "beat_quote_submission"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The terms must be positive and the window must run forwards.
ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_terms_positive" CHECK (
    "percent" > 0 AND "percent" <= 100 AND "max_discount_minor_units" > 0
  );
ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_expires_after_issue" CHECK ("expires_at" > "issued_at");

-- A redemption is a timestamp AND the order it was spent on AND the amount.
-- "Redeemed, but we do not know where or for how much" is not a record of a
-- redemption, and amendment §3 requires the order.
ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_redemption_complete" CHECK (
    ("redeemed_at" IS NULL AND "redemption_order_ref" IS NULL AND "redemption_discount_minor_units" IS NULL)
    OR
    ("redeemed_at" IS NOT NULL AND "redemption_order_ref" IS NOT NULL
     AND "redemption_discount_minor_units" IS NOT NULL AND "redemption_discount_minor_units" >= 0)
  );

-- THE CAP, AS A CONSTRAINT. A redemption may never exceed the benefit's own
-- frozen maximum. "maximum discount $100" is the term a rounding change or an
-- arithmetic slip would break, so the database refuses the over-discount
-- rather than trusting the calculation.
ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_redemption_within_cap" CHECK (
    "redemption_discount_minor_units" IS NULL
    OR "redemption_discount_minor_units" <= "max_discount_minor_units"
  );

-- A revocation carries its reason. Amendment §3 requires the reason for any
-- manual override, and a revoked benefit with no stated reason is exactly the
-- record a dispute needs and would not find.
ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_revocation_has_reason" CHECK (
    ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND btrim(COALESCE("revoked_reason", '')) <> '')
  );

ALTER TABLE "beat_quote_fallback_benefit"
  ADD CONSTRAINT "beat_quote_fallback_benefit_override_has_reason" CHECK (
    ("override_reason" IS NULL AND "override_by_actor_ref" IS NULL)
    OR (btrim(COALESCE("override_reason", '')) <> '' AND "override_by_actor_ref" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- SINGLE USE, AND THE TERMS ARE IMMUTABLE.
--
-- NOT APPEND-ONLY, deliberately — and for the same reason
-- `warranty_claim_upload_destination` is not: this row has a legitimate
-- lifecycle. `redeemed_at` moves from NULL to a timestamp exactly once, and a
-- benefit can be revoked. Making the table append-only would make redemption
-- impossible; leaving it unguarded would make un-redeeming possible.
--
-- So the trigger permits only the transitions policy allows, and refuses:
--   - un-redeeming (a timestamp back to NULL, or changed to another instant)
--   - re-pointing a redemption at a different order
--   - editing the frozen terms, the issuance instant, the expiry, the code,
--     the customer it was issued to, or the submission it came from
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION beat_quote_fallback_benefit_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."submission_id" <> OLD."submission_id"
       OR NEW."benefit_code" <> OLD."benefit_code"
       OR NEW."customer_ref" <> OLD."customer_ref"
       OR NEW."percent" <> OLD."percent"
       OR NEW."max_discount_minor_units" <> OLD."max_discount_minor_units"
       OR NEW."currency" <> OLD."currency"
       OR NEW."issued_at" <> OLD."issued_at"
       OR NEW."expires_at" <> OLD."expires_at"
    THEN
        RAISE EXCEPTION
            'beat_quote_fallback_benefit: the issued terms are immutable (benefit %). '
            'A different benefit is a new row, not an edit.', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- Single use: once spent, the redemption cannot be moved or undone.
    IF OLD."redeemed_at" IS NOT NULL AND (
         NEW."redeemed_at" IS NULL
         OR NEW."redeemed_at" <> OLD."redeemed_at"
         OR NEW."redemption_order_ref" <> OLD."redemption_order_ref"
         OR NEW."redemption_discount_minor_units" <> OLD."redemption_discount_minor_units"
       )
    THEN
        RAISE EXCEPTION
            'beat_quote_fallback_benefit: a redemption is single use and final (benefit %). '
            'It cannot be undone, moved to another order, or re-valued.', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- A revocation likewise stands. Reversing one would erase the record that
    -- it happened.
    IF OLD."revoked_at" IS NOT NULL AND (NEW."revoked_at" IS NULL OR NEW."revoked_at" <> OLD."revoked_at") THEN
        RAISE EXCEPTION
            'beat_quote_fallback_benefit: a revocation cannot be reversed (benefit %).', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "beat_quote_fallback_benefit_guard"
  BEFORE UPDATE ON "beat_quote_fallback_benefit"
  FOR EACH ROW EXECUTE FUNCTION beat_quote_fallback_benefit_guard();

-- Deleting a benefit would erase the record of a promise made to a customer.
-- Revocation is how one stops being usable.
CREATE TRIGGER "beat_quote_fallback_benefit_no_delete"
  BEFORE DELETE ON "beat_quote_fallback_benefit"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "beat_quote_fallback_benefit_no_truncate"
  BEFORE TRUNCATE ON "beat_quote_fallback_benefit"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

COMMENT ON TABLE "beat_quote_submission" IS
  'Let Us Beat Your Quote submissions. quote_age_calendar_days and treatment are FROZEN at intake and must '
  'never be recomputed — a quote does not become ineligible because review took four days. Only a '
  'custom_quote may carry treatment=guarantee (amendment §1 makes online listings and competing Group Buys '
  'review-only); CHECK constraints enforce that.';

COMMENT ON TABLE "beat_quote_fallback_benefit" IS
  'The 10%-off, $100-cap, 90-day fallback. UNIQUE on submission_id IS the duplicate-issuance rule from '
  'amendment §3. The terms are frozen at issuance so a later policy change cannot restate what a holder was '
  'already promised. Single use and revocation-finality are enforced by trigger, not convention.';
