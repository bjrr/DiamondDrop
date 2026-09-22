-- Phase 2C-c revision, D23 (docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §19.1,
-- criteria 112-114). verified_by was free text; a typed name is unfalsifiable
-- evidence -- nothing stops a different person typing someone else's name.
-- Replaced by the AUTHENTICATED Shopify staff identity captured from the
-- online session (useOnlineTokens: true, app/shopify.server.ts):
-- session.onlineAccessInfo.associated_user.id and .email.
--
-- DATA CHECKED BEFORE WRITING THIS MIGRATION (dev database, 2026-09-22): 2
-- bank_payment_order rows have a non-null verified_by, both the literal
-- "livegate-admin" -- a placeholder from the 2C-a live gate, not a real
-- identity, and not backfillable to a real Shopify user id/email. Both rows
-- are disposable dev-only fixtures (spec §16, "Left on the dev store") and
-- both are STATUS = 'completed', so verified_at cannot simply be cleared --
-- bank_payment_order_status_coherent requires a completed order to carry a
-- verified_at. Backfilled below with an explicit, unmistakable placeholder
-- (user id 0, an .invalid email) rather than left NULL, which would violate
-- the reinstated pairing constraint, or silently invented as a plausible-
-- looking identity, which would misrepresent disposable dev data as evidence.

ALTER TABLE "bank_payment_order"
  DROP CONSTRAINT "bank_payment_order_verification_pairing";

ALTER TABLE "bank_payment_order"
  ADD COLUMN "verified_by_shopify_user_id" BIGINT,
  ADD COLUMN "verified_by_email" TEXT;

UPDATE "bank_payment_order"
SET "verified_by_shopify_user_id" = 0,
    "verified_by_email" = 'unattributed-legacy-fixture@caratforus.invalid'
WHERE "verified_at" IS NOT NULL;

ALTER TABLE "bank_payment_order"
  DROP COLUMN "verified_by";

-- Re-established with the two new columns in place of verified_by. Same
-- shape as before: every verification field is set together, or all are
-- NULL -- see migration 20260919085156's original constraint.
ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_verification_pairing" CHECK (
    (verified_at IS NULL AND verified_by_shopify_user_id IS NULL AND verified_by_email IS NULL
        AND verified_payment_amount_minor_units IS NULL
        AND verified_payment_currency IS NULL
        AND verified_payment_method IS NULL)
    OR (verified_at IS NOT NULL AND verified_by_shopify_user_id IS NOT NULL AND verified_by_email IS NOT NULL
        AND verified_payment_amount_minor_units IS NOT NULL
        AND verified_payment_currency IS NOT NULL
        AND verified_payment_method IS NOT NULL)
  );

COMMENT ON COLUMN "bank_payment_order"."verified_by_shopify_user_id" IS
  'D23: the AUTHENTICATED Shopify staff user id from the online session (session.onlineAccessInfo.associated_user.id) -- never a typed name.';
COMMENT ON COLUMN "bank_payment_order"."verified_by_email" IS
  'D23: the AUTHENTICATED Shopify staff email from the online session (session.onlineAccessInfo.associated_user.email) -- never a typed name.';
