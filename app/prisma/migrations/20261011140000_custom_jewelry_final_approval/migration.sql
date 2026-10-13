-- Custom Jewelry final approval and purchase (owner workstream 2026-10-11).
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY THE PACKAGE IS A VERSIONED SNAPSHOT AND NOT A SET OF COLUMNS ON THE PROJECT
-- ============================================================================
-- Owner requirement: "A later CAD/spec edit must not rewrite what the customer
-- actually approved. If design changes after approval, require a new approval
-- version rather than mutating the old one."
--
-- A Custom Jewelry purchase is final sale with four named exceptions, and one
-- of them is "material failure to match the approved design/specifications".
-- That exception is only decidable if the approved design is recoverable
-- exactly as it stood when the customer clicked approve. Specs living on the
-- project would be overwritten by the next revision, and the evidence for a
-- claim would quietly become the current design rather than the approved one —
-- which is the same thing as having no evidence.
--
-- So each package is an immutable row, versioned per project, and approval
-- points at one. A revision issues version N+1 and supersedes N; it never
-- edits N.
--
-- ============================================================================
-- THE MONEY IS CARRIED ON BOTH BASES, FROZEN
-- ============================================================================
-- The owner allows either payment basis at final checkout: card/wallet on the
-- Regular/Card basis, Bank Payment on the Bank Payment basis. Both figures are
-- therefore frozen into the package, because the customer is approving "the
-- final price shown" and which figure that is depends on a path they choose
-- afterwards. Deriving one from the other at purchase time would mean the
-- approved price and the charged price came from different moments.
--
-- Bank Payment Price is the authoritative underlying figure and the Card price
-- is derived upward from it (`CLAUDE.md` rules 11-12). This table stores the
-- results, not the derivation.
--
-- ============================================================================
-- THE DEPOSIT IS A CREDIT, NOT A DISCOUNT
-- ============================================================================
-- Owner requirement, and the distinction has teeth: a discount reduces the
-- selling price, a credit reduces what is COLLECTED while the price stands.
-- The gross approved price survives in its own column on both the package and
-- the purchase, so "we only collected the balance" never erases what the piece
-- actually sold for — which is what margin, warranty reserve, refund economics
-- and the final-sale exceptions all reason about.
--
-- Three CHECKs enforce the arithmetic the owner named: the credit cannot exceed
-- the price it offsets, the balance cannot go negative, and the balance is
-- exactly price minus credit minus any benefit. A UNIQUE on the deposit payment
-- stops the same $49 being credited twice.

CREATE TYPE "custom_jewelry_approval_package_status" AS ENUM (
    -- Issued to the customer and awaiting their decision.
    'issued',
    -- The customer approved THIS version. Terminal.
    'approved',
    -- A later version replaced it before the customer approved. Terminal.
    'superseded'
);

CREATE TYPE "custom_jewelry_purchase_basis" AS ENUM ('card', 'bank_payment');

CREATE TYPE "custom_jewelry_purchase_status" AS ENUM (
    -- The payable object exists; nothing has been collected.
    'awaiting_payment',
    -- Money received and, for Bank Payment, verified by a human.
    'paid',
    -- Cancelled before payment.
    'cancelled'
);

-- ---------------------------------------------------------------------------
-- THE APPROVAL PACKAGE
-- ---------------------------------------------------------------------------
CREATE TABLE "custom_jewelry_approval_package" (
    "id" UUID NOT NULL,

    "project_id" UUID NOT NULL,

    /* Monotonic per project, starting at 1. A revision is version N+1; nothing
       ever reuses a number, because the number is how a customer's approval
       and a later claim both name the same design. */
    "version" INTEGER NOT NULL,

    "status" "custom_jewelry_approval_package_status" NOT NULL DEFAULT 'issued',

    /* ========================================================================
       THE SPECIFICATION, FROZEN
       ========================================================================
       Separate columns rather than one JSON blob for the fields the owner
       enumerated, because each is displayed as its own labelled row and a
       reviewer comparing an approved package against a claim should not have
       to parse JSON to find the ring size. The open-ended parts — stone
       details, agreed customizations — are JSONB, because their shape is
       genuinely per-piece and inventing columns for "accent stone 3" is how a
       schema ends up with twelve nullable stone columns.

       NULLABLE where the owner said "as applicable": a pendant has no ring
       size, and a plain band has no centre stone. NULL means "does not apply",
       which the display layer renders as absence rather than as blank. */
    "metal_type" TEXT NOT NULL,
    "metal_color" TEXT NOT NULL,
    "center_stone" JSONB,
    "accent_stones" JSONB,
    "dimensions" TEXT,
    "ring_size" TEXT,
    "engraving" TEXT,
    "construction_notes" TEXT,
    "agreed_customizations" JSONB,

    /* CAD, renderings and final design images, as references into the
       project's own upload records plus any externally hosted CAD reference.
       REFERENCES, NOT BYTES — the objects live in private R2, exactly as
       `CustomJewelryProjectUpload` records them. Frozen so a later re-render
       cannot change what the customer saw. */
    "media_references" JSONB NOT NULL,

    /* Production/timeline information that is ACTUALLY APPROVED. Free text a
       human writes per project, nullable because "we have not agreed a
       timeline" is a legitimate and honest state. Deliberately NOT generated
       from a template: the owner forbade unsupported turnaround promises, and
       a default sentence here is exactly how one would appear. */
    "approved_timeline_text" TEXT,

    /* ========================================================================
       THE MONEY, FROZEN ON BOTH BASES
       ======================================================================== */
    "currency" CHAR(3) NOT NULL,
    /* The authoritative underlying figure. */
    "bank_payment_price_minor_units" BIGINT NOT NULL,
    /* Derived upward from it under docs/BANK-CARD-PRICING.md, frozen here. */
    "regular_card_price_minor_units" BIGINT NOT NULL,

    /* The $49 already paid, and the credit it buys. Equal in the ordinary
       case; separate columns because "paid" is a historical fact about a
       transaction and "credit" is a decision about this package, and a
       part-credited deposit would be a policy change rather than a schema
       change. */
    "deposit_paid_minor_units" BIGINT NOT NULL,
    "deposit_credit_minor_units" BIGINT NOT NULL,
    /* WHICH deposit payment. The FK is what makes "the same deposit cannot be
       credited twice" enforceable rather than aspirational. */
    "deposit_payment_id" UUID,

    /* Balance on each basis. STORED, not computed on read: the owner requires
       the purchase record to preserve the balance, and a CHECK can only
       enforce an arithmetic relationship between columns that exist. */
    "bank_payment_balance_due_minor_units" BIGINT NOT NULL,
    "regular_card_balance_due_minor_units" BIGINT NOT NULL,

    /* ========================================================================
       THE COPY VERSIONS THE CUSTOMER WAS SHOWN
       ========================================================================
       Three separate versions, because the owner asked for the
       "warranty/final-sale copy version" and the "approval acknowledgment
       text/version" as distinct items. They genuinely move independently: the
       final-sale term could be revised without changing what the customer
       certifies. One field covering both would make either change look like
       the other. */
    "final_sale_copy_version" INTEGER NOT NULL,
    "warranty_copy_version" INTEGER NOT NULL,
    "approval_acknowledgment_policy_version" INTEGER NOT NULL,

    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_actor_ref" TEXT NOT NULL,

    /* ========================================================================
       THE APPROVAL
       ========================================================================
       `approved_by_customer_ref` is the AUTHENTICATED Shopify customer, and it
       is recorded here rather than only on the acknowledgment because the
       owner requires the frozen package to preserve the customer id. */
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_customer_ref" TEXT,
    /* The evidence row carrying the exact acknowledgment text the customer
       accepted, its policy version and its timestamp. A NOT NULL FK on an
       approved package, enforced by the CHECK below — an approval with no
       acknowledgment behind it is not an approval. */
    "approval_acknowledgment_id" UUID,

    "superseded_at" TIMESTAMPTZ(6),
    "superseded_by_version" INTEGER,
    "superseded_reason" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_jewelry_approval_package_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "custom_jewelry_project"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_deposit_payment_id_fkey"
  FOREIGN KEY ("deposit_payment_id") REFERENCES "custom_jewelry_deposit_payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_acknowledgment_id_fkey"
  FOREIGN KEY ("approval_acknowledgment_id") REFERENCES "acknowledgment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One version number per project, ever.
CREATE UNIQUE INDEX "custom_jewelry_approval_package_project_version_key"
    ON "custom_jewelry_approval_package"("project_id", "version");

-- AT MOST ONE ISSUED PACKAGE PER PROJECT. Two live packages would mean the
-- customer could approve either, and "which design did they approve" would be
-- decided by whichever link they happened to click.
CREATE UNIQUE INDEX "custom_jewelry_approval_package_one_issued_per_project"
    ON "custom_jewelry_approval_package"("project_id")
    WHERE "status" = 'issued';

-- AND AT MOST ONE APPROVED PACKAGE PER PROJECT. One piece, one approved
-- design. A second would make the final-sale exceptions ambiguous.
CREATE UNIQUE INDEX "custom_jewelry_approval_package_one_approved_per_project"
    ON "custom_jewelry_approval_package"("project_id")
    WHERE "status" = 'approved';

-- THE SAME DEPOSIT CANNOT BE CREDITED TWICE. The owner's requirement, as an
-- index rather than a check somebody remembers to run.
CREATE UNIQUE INDEX "custom_jewelry_approval_package_deposit_payment_key"
    ON "custom_jewelry_approval_package"("deposit_payment_id")
    WHERE "deposit_payment_id" IS NOT NULL;

CREATE INDEX "custom_jewelry_approval_package_status_idx"
    ON "custom_jewelry_approval_package"("status");

-- ---------------------------------------------------------------------------
-- COHERENCE
-- ---------------------------------------------------------------------------

-- Versions start at 1 and go up.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_version_positive" CHECK ("version" >= 1);

-- Prices are positive, and the card price is never BELOW the bank price. The
-- card price is derived by adding an uplift of at least 3% (CLAUDE.md rule 12),
-- so a card price under the bank price is arithmetically impossible and would
-- mean the two were transposed — which would sell the piece for less to the
-- customer paying more.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_prices_sane" CHECK (
    "bank_payment_price_minor_units" > 0
    AND "regular_card_price_minor_units" >= "bank_payment_price_minor_units"
  );

-- THE DEPOSIT CREDIT CANNOT EXCEED WHAT IT OFFSETS. Checked against the BANK
-- price, which is the lower of the two: a credit that fits the card price but
-- not the bank price would produce a negative balance the moment the customer
-- chose bank. Checking the smaller figure covers both.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_deposit_credit_fits" CHECK (
    "deposit_paid_minor_units" >= 0
    AND "deposit_credit_minor_units" >= 0
    AND "deposit_credit_minor_units" <= "deposit_paid_minor_units"
    AND "deposit_credit_minor_units" <= "bank_payment_price_minor_units"
  );

-- A CREDIT NEEDS A PAYMENT BEHIND IT. Crediting money nobody can point at is
-- how a $49 appears from nowhere.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_credit_has_payment" CHECK (
    "deposit_credit_minor_units" = 0 OR "deposit_payment_id" IS NOT NULL
  );

-- THE BALANCE IS EXACTLY PRICE MINUS CREDIT, ON EACH BASIS, AND NEVER
-- NEGATIVE. Stored and then checked, so a caller cannot write a balance that
-- disagrees with the figures beside it.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_balances_exact" CHECK (
    "bank_payment_balance_due_minor_units" =
        "bank_payment_price_minor_units" - "deposit_credit_minor_units"
    AND "regular_card_balance_due_minor_units" =
        "regular_card_price_minor_units" - "deposit_credit_minor_units"
    AND "bank_payment_balance_due_minor_units" >= 0
    AND "regular_card_balance_due_minor_units" >= 0
  );

-- AN APPROVAL CARRIES ITS CUSTOMER, ITS MOMENT AND ITS ACKNOWLEDGMENT. All
-- three or none: "approved, but we cannot say by whom or to what" is not an
-- approval, and this surface is the one the final-sale term rests on.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_approval_complete" CHECK (
    ("status" <> 'approved')
    OR ("approved_at" IS NOT NULL
        AND btrim(COALESCE("approved_by_customer_ref", '')) <> ''
        AND "approval_acknowledgment_id" IS NOT NULL)
  );

-- A superseded package says when and by which version.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_supersession_complete" CHECK (
    ("status" <> 'superseded')
    OR ("superseded_at" IS NOT NULL AND "superseded_by_version" IS NOT NULL
        AND "superseded_by_version" > "version")
  );

-- AN APPROVED PACKAGE IS NEVER SUPERSEDED. The owner requires a design change
-- after approval to be a NEW approval version — which means the customer
-- approves again. Quietly superseding what they already approved would leave
-- the piece final sale against a design they never saw.
ALTER TABLE "custom_jewelry_approval_package"
  ADD CONSTRAINT "custom_jewelry_approval_package_approved_not_superseded" CHECK (
    "approved_at" IS NULL OR "superseded_at" IS NULL
  );

-- ---------------------------------------------------------------------------
-- THE FINAL PURCHASE
-- ---------------------------------------------------------------------------
CREATE TABLE "custom_jewelry_final_purchase" (
    "id" UUID NOT NULL,

    "project_id" UUID NOT NULL,
    /* ONE PURCHASE PER APPROVED PACKAGE. This is what makes retries
       idempotent: a second creation attempt for the same package cannot
       insert. */
    "approval_package_id" UUID NOT NULL,

    "payment_basis" "custom_jewelry_purchase_basis" NOT NULL,
    "status" "custom_jewelry_purchase_status" NOT NULL DEFAULT 'awaiting_payment',

    "currency" CHAR(3) NOT NULL,

    /* ========================================================================
       THE GROSS PRICE SURVIVES. This column is the owner's instruction:
       "Never lose the gross approved price simply because only the balance is
       collected at final checkout."
       ======================================================================== */
    "gross_approved_price_minor_units" BIGINT NOT NULL,
    "deposit_credit_minor_units" BIGINT NOT NULL,
    /* The deposit's own payment reference, copied so the purchase record is
       self-contained evidence — a reader should not have to join three tables
       to answer "what was actually collected and why". */
    "deposit_payment_reference" TEXT,
    /* The Let Us Beat Your Quote benefit, if one was redeemed. Separate from
       the deposit credit, because one is a promotional benefit and the other
       is the customer's own money returning to them. Conflating them would
       make the deposit look like a discount, which the owner explicitly
       rejected. */
    "benefit_discount_minor_units" BIGINT NOT NULL DEFAULT 0,
    "balance_due_minor_units" BIGINT NOT NULL,

    /* THE PAYABLE OBJECT, in whichever of the two existing money systems
       applies. Exactly one is set, enforced below — reusing the Bank Payment
       machinery for bank and the draft-order path for card, rather than a
       second money system. */
    "bank_payment_order_id" UUID,
    "shopify_draft_order_gid" TEXT,
    "shopify_order_gid" TEXT,

    "paid_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_jewelry_final_purchase_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "custom_jewelry_project"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_approval_package_id_fkey"
  FOREIGN KEY ("approval_package_id") REFERENCES "custom_jewelry_approval_package"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_bank_payment_order_id_fkey"
  FOREIGN KEY ("bank_payment_order_id") REFERENCES "bank_payment_order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RETRIES CANNOT CREATE DUPLICATE FINAL PURCHASES. The owner's requirement, as
-- the database's answer rather than the application's.
CREATE UNIQUE INDEX "custom_jewelry_final_purchase_approval_package_key"
    ON "custom_jewelry_final_purchase"("approval_package_id");

CREATE UNIQUE INDEX "custom_jewelry_final_purchase_bank_payment_order_key"
    ON "custom_jewelry_final_purchase"("bank_payment_order_id")
    WHERE "bank_payment_order_id" IS NOT NULL;
CREATE UNIQUE INDEX "custom_jewelry_final_purchase_draft_order_key"
    ON "custom_jewelry_final_purchase"("shopify_draft_order_gid")
    WHERE "shopify_draft_order_gid" IS NOT NULL;
CREATE UNIQUE INDEX "custom_jewelry_final_purchase_order_key"
    ON "custom_jewelry_final_purchase"("shopify_order_gid")
    WHERE "shopify_order_gid" IS NOT NULL;

CREATE INDEX "custom_jewelry_final_purchase_status_idx"
    ON "custom_jewelry_final_purchase"("status");

-- The gross price is never lost, the credits never exceed it, and the balance
-- is exact. The same three properties as the package, restated on the record
-- that money is actually collected against — because this is the row a
-- reconciliation reads.
ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_amounts_exact" CHECK (
    "gross_approved_price_minor_units" > 0
    AND "deposit_credit_minor_units" >= 0
    AND "benefit_discount_minor_units" >= 0
    AND "deposit_credit_minor_units" + "benefit_discount_minor_units"
        <= "gross_approved_price_minor_units"
    AND "balance_due_minor_units" =
        "gross_approved_price_minor_units"
        - "deposit_credit_minor_units"
        - "benefit_discount_minor_units"
    AND "balance_due_minor_units" >= 0
  );

-- EXACTLY ONE PAYABLE OBJECT, matching the basis. A bank purchase has a bank
-- payment order; a card purchase has a draft order. A row with both would mean
-- two ways to collect the same balance.
ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_basis_object_coherent" CHECK (
    ("payment_basis" = 'bank_payment' AND "shopify_draft_order_gid" IS NULL)
    OR ("payment_basis" = 'card' AND "bank_payment_order_id" IS NULL)
  );

ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_paid_has_moment" CHECK (
    ("status" <> 'paid') OR ("paid_at" IS NOT NULL)
  );

ALTER TABLE "custom_jewelry_final_purchase"
  ADD CONSTRAINT "custom_jewelry_final_purchase_cancelled_has_reason" CHECK (
    ("status" <> 'cancelled')
    OR ("cancelled_at" IS NOT NULL AND btrim(COALESCE("cancellation_reason", '')) <> '')
  );

-- ---------------------------------------------------------------------------
-- IMMUTABILITY — the whole reason the package exists
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION custom_jewelry_approval_package_guard()
RETURNS TRIGGER AS $$
BEGIN
    -- EVERYTHING THE CUSTOMER SAW IS FROZEN. Not "should not change" — cannot.
    -- The final-sale term's "material failure to match the approved
    -- design/specifications" exception is only decidable against a design that
    -- still says what it said when they approved it.
    IF NEW."project_id" <> OLD."project_id"
       OR NEW."version" <> OLD."version"
       OR NEW."metal_type" <> OLD."metal_type"
       OR NEW."metal_color" <> OLD."metal_color"
       OR COALESCE(NEW."center_stone", '{}'::jsonb) <> COALESCE(OLD."center_stone", '{}'::jsonb)
       OR COALESCE(NEW."accent_stones", '{}'::jsonb) <> COALESCE(OLD."accent_stones", '{}'::jsonb)
       OR COALESCE(NEW."dimensions", '') <> COALESCE(OLD."dimensions", '')
       OR COALESCE(NEW."ring_size", '') <> COALESCE(OLD."ring_size", '')
       OR COALESCE(NEW."engraving", '') <> COALESCE(OLD."engraving", '')
       OR COALESCE(NEW."construction_notes", '') <> COALESCE(OLD."construction_notes", '')
       OR COALESCE(NEW."agreed_customizations", '{}'::jsonb) <> COALESCE(OLD."agreed_customizations", '{}'::jsonb)
       OR NEW."media_references" <> OLD."media_references"
       OR COALESCE(NEW."approved_timeline_text", '') <> COALESCE(OLD."approved_timeline_text", '')
       OR NEW."currency" <> OLD."currency"
       OR NEW."bank_payment_price_minor_units" <> OLD."bank_payment_price_minor_units"
       OR NEW."regular_card_price_minor_units" <> OLD."regular_card_price_minor_units"
       OR NEW."deposit_paid_minor_units" <> OLD."deposit_paid_minor_units"
       OR NEW."deposit_credit_minor_units" <> OLD."deposit_credit_minor_units"
       OR COALESCE(NEW."deposit_payment_id"::text, '') <> COALESCE(OLD."deposit_payment_id"::text, '')
       OR NEW."bank_payment_balance_due_minor_units" <> OLD."bank_payment_balance_due_minor_units"
       OR NEW."regular_card_balance_due_minor_units" <> OLD."regular_card_balance_due_minor_units"
       OR NEW."final_sale_copy_version" <> OLD."final_sale_copy_version"
       OR NEW."warranty_copy_version" <> OLD."warranty_copy_version"
       OR NEW."approval_acknowledgment_policy_version" <> OLD."approval_acknowledgment_policy_version"
       OR NEW."issued_at" <> OLD."issued_at"
       OR NEW."issued_by_actor_ref" <> OLD."issued_by_actor_ref"
    THEN
        RAISE EXCEPTION
            'custom_jewelry_approval_package: an approval package is immutable (package % v%). A design or '
            'price change is a NEW version that the customer approves again — never an edit to what they '
            'already approved.',
            OLD."id", OLD."version"
            USING ERRCODE = '23001';
    END IF;

    -- STAFF CANNOT SILENTLY EDIT A CUSTOMER-APPROVED PACKAGE IN PLACE. The
    -- owner's requirement; the immutability above already forbids every field,
    -- and this refuses the status move as well so an approved package cannot be
    -- walked back to 'issued' and re-approved against different content.
    IF OLD."status" = 'approved' AND NEW."status" <> 'approved' THEN
        RAISE EXCEPTION
            'custom_jewelry_approval_package: package % v% is approved and final. Issue a new version '
            'instead of reopening this one.', OLD."id", OLD."version"
            USING ERRCODE = '23001';
    END IF;

    IF OLD."status" = 'superseded' AND NEW."status" <> 'superseded' THEN
        RAISE EXCEPTION
            'custom_jewelry_approval_package: package % v% was superseded and cannot be revived.',
            OLD."id", OLD."version"
            USING ERRCODE = '23001';
    END IF;

    -- The approval is written once.
    IF OLD."approved_at" IS NOT NULL
       AND (NEW."approved_at" <> OLD."approved_at"
            OR COALESCE(NEW."approved_by_customer_ref", '') <> COALESCE(OLD."approved_by_customer_ref", '')
            OR COALESCE(NEW."approval_acknowledgment_id"::text, '')
               <> COALESCE(OLD."approval_acknowledgment_id"::text, ''))
    THEN
        RAISE EXCEPTION
            'custom_jewelry_approval_package: the approval record is immutable (package % v%).',
            OLD."id", OLD."version"
            USING ERRCODE = '23001';
    END IF;

    NEW."updated_at" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "custom_jewelry_approval_package_guard"
  BEFORE UPDATE ON "custom_jewelry_approval_package"
  FOR EACH ROW EXECUTE FUNCTION custom_jewelry_approval_package_guard();

-- Deleting a package would erase what a customer approved, which is the
-- evidence the final-sale exceptions rest on.
CREATE TRIGGER "custom_jewelry_approval_package_no_delete"
  BEFORE DELETE ON "custom_jewelry_approval_package"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_approval_package_no_truncate"
  BEFORE TRUNCATE ON "custom_jewelry_approval_package"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- ---------------------------------------------------------------------------
-- THE PURCHASE'S OWN GUARD
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION custom_jewelry_final_purchase_guard()
RETURNS TRIGGER AS $$
BEGIN
    -- THE MONEY IS FROZEN. A purchase whose gross price or credits could be
    -- edited after the fact is not a record of what was sold.
    IF NEW."project_id" <> OLD."project_id"
       OR NEW."approval_package_id" <> OLD."approval_package_id"
       OR NEW."payment_basis" <> OLD."payment_basis"
       OR NEW."currency" <> OLD."currency"
       OR NEW."gross_approved_price_minor_units" <> OLD."gross_approved_price_minor_units"
       OR NEW."deposit_credit_minor_units" <> OLD."deposit_credit_minor_units"
       OR COALESCE(NEW."deposit_payment_reference", '') <> COALESCE(OLD."deposit_payment_reference", '')
       OR NEW."benefit_discount_minor_units" <> OLD."benefit_discount_minor_units"
       OR NEW."balance_due_minor_units" <> OLD."balance_due_minor_units"
    THEN
        RAISE EXCEPTION
            'custom_jewelry_final_purchase: the purchase amounts are immutable (purchase %). The gross '
            'approved price, the deposit credit and the balance are what was sold and collected.',
            OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- FORWARD ONLY. A paid purchase does not become awaiting_payment, and a
    -- cancelled one is not revived — a new attempt is a new purchase against a
    -- new approval package.
    IF OLD."status" = 'paid' AND NEW."status" <> 'paid' THEN
        RAISE EXCEPTION
            'custom_jewelry_final_purchase: purchase % is paid; payment is not unmade by an update.',
            OLD."id"
            USING ERRCODE = '23001';
    END IF;
    IF OLD."status" = 'cancelled' AND NEW."status" <> 'cancelled' THEN
        RAISE EXCEPTION
            'custom_jewelry_final_purchase: purchase % was cancelled and cannot be revived.', OLD."id"
            USING ERRCODE = '23001';
    END IF;

    -- Payable and real-order references are write-once.
    IF OLD."bank_payment_order_id" IS NOT NULL
       AND NEW."bank_payment_order_id" <> OLD."bank_payment_order_id" THEN
        RAISE EXCEPTION
            'custom_jewelry_final_purchase: the bank payment order reference is immutable (purchase %).',
            OLD."id" USING ERRCODE = '23001';
    END IF;
    IF OLD."shopify_draft_order_gid" IS NOT NULL
       AND NEW."shopify_draft_order_gid" <> OLD."shopify_draft_order_gid" THEN
        RAISE EXCEPTION
            'custom_jewelry_final_purchase: the draft order reference is immutable (purchase %).',
            OLD."id" USING ERRCODE = '23001';
    END IF;
    IF OLD."shopify_order_gid" IS NOT NULL
       AND NEW."shopify_order_gid" <> OLD."shopify_order_gid" THEN
        RAISE EXCEPTION
            'custom_jewelry_final_purchase: the order reference is immutable (purchase %).',
            OLD."id" USING ERRCODE = '23001';
    END IF;

    NEW."updated_at" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "custom_jewelry_final_purchase_guard"
  BEFORE UPDATE ON "custom_jewelry_final_purchase"
  FOR EACH ROW EXECUTE FUNCTION custom_jewelry_final_purchase_guard();

CREATE TRIGGER "custom_jewelry_final_purchase_no_delete"
  BEFORE DELETE ON "custom_jewelry_final_purchase"
  FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER "custom_jewelry_final_purchase_no_truncate"
  BEFORE TRUNCATE ON "custom_jewelry_final_purchase"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- ---------------------------------------------------------------------------
-- THE PROJECT'S REMAINING STATES
-- ---------------------------------------------------------------------------
-- The enum already carries them: submitted, deposit_charged, awaiting_approval,
-- approved, purchased, closed. Nothing reached past `deposit_charged` before
-- now, so the transition rules for the rest were never enforced.
--
-- FORWARD ONLY, and NOT inferred from whether a page or a Shopify order
-- exists — the owner's instruction. A status is a fact we wrote, conditionally,
-- at the moment it became true.
CREATE OR REPLACE FUNCTION custom_jewelry_project_forward_only()
RETURNS TRIGGER AS $$
DECLARE
    old_rank INTEGER;
    new_rank INTEGER;
BEGIN
    IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;

    old_rank := CASE OLD."status"
        WHEN 'submitted' THEN 1
        WHEN 'deposit_charged' THEN 2
        WHEN 'awaiting_approval' THEN 3
        WHEN 'approved' THEN 4
        WHEN 'purchased' THEN 5
        WHEN 'closed' THEN 6
    END;
    new_rank := CASE NEW."status"
        WHEN 'submitted' THEN 1
        WHEN 'deposit_charged' THEN 2
        WHEN 'awaiting_approval' THEN 3
        WHEN 'approved' THEN 4
        WHEN 'purchased' THEN 5
        WHEN 'closed' THEN 6
    END;

    -- `closed` is reachable from anywhere: a project can be abandoned at any
    -- stage, and refusing that would leave dead projects in the active queue
    -- forever. Everything else moves up by any amount but never down.
    IF new_rank < old_rank THEN
        RAISE EXCEPTION
            'custom_jewelry_project: status moves forward only (project % tried % -> %).',
            OLD."id", OLD."status", NEW."status"
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "custom_jewelry_project_forward_only"
  BEFORE UPDATE ON "custom_jewelry_project"
  FOR EACH ROW EXECUTE FUNCTION custom_jewelry_project_forward_only();

COMMENT ON TABLE "custom_jewelry_approval_package" IS
  'An immutable, versioned snapshot of exactly what a Custom Jewelry customer was shown and approved: specs, '
  'media references, both price bases, the deposit credit, the balance on each basis, and the copy versions. '
  'A design change is a NEW version the customer approves again — never an edit to this one, because the '
  'final-sale exception for "material failure to match the approved design" is only decidable against a '
  'design that still says what it said at approval.';

COMMENT ON TABLE "custom_jewelry_final_purchase" IS
  'What was sold and what was collected. The gross approved price is preserved even though only the balance '
  'is charged, because the deposit is a CREDIT against the price rather than a discount to it. One purchase '
  'per approval package, which is what makes a retried creation idempotent.';
