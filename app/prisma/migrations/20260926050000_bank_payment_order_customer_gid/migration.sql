-- docs/REQUIRED-CUSTOMER-ACCOUNTS.md (LOCKED, approved 2026-09-26) §4/§9 case
-- 2 -- security fix. `apps.carat.bank-checkout.tsx` had ZERO reference to the
-- authenticated Shopify customer identity: an anonymous visitor could create
-- a real Shopify draft order and invoice using only a browser-supplied
-- `email` field, which is never proof of who is asking. Signature
-- verification proves the request came through Shopify's App Proxy, not who
-- the caller is.
--
-- `customer_gid` is the AUTHENTICATED identity (the signed App Proxy
-- `logged_in_customer_id`, normalized to `gid://shopify/Customer/<id>`) --
-- never the request body's `email`, which remains the invoice/delivery
-- contact only.
--
-- NOT NULL, DELIBERATELY (architect review, 2026-09-26). A first pass left
-- this column nullable because a DB-level NOT NULL broke pre-existing test
-- fixtures in other slices (guaranteeSweep, verification, completeOrder,
-- slice2SchemaGuards, the live cancellation-email harness) that constructed
-- a `bank_payment_order` row with no customer identity. That was backwards:
-- those fixtures were encoding the pre-fix world the policy makes impossible,
-- and the constraint failing to compile against them was it doing its job.
-- Each fixture has been updated in the same change to supply an authenticated
-- `gid://shopify/Customer/<id>` rather than relaxing this column to
-- accommodate them -- the constraint is what catches the NEXT route,
-- backfill, or script that forgets this, not just this one.
--
-- THIS MIGRATION RUNS AGAINST PRODUCTION, NOT JUST DEV. The app is live at
-- https://caratforus.fly.dev with `release_command = "npx prisma migrate
-- deploy"`, so this backfill executes against the real production
-- `bank_payment_order` table, not only the disposable dev database.
--
-- DATA CHECKED BEFORE WRITING THIS MIGRATION (dev database, 2026-09-26): all
-- 16 existing bank_payment_order rows there were created through the
-- anonymous-checkout defect this change closes, or through live gates
-- (`tests/live/slice2cB.cancellationEmail.ts` and siblings) that deliberately
-- exercise real Admin API / production-adjacent paths with synthetic
-- addresses. Every one carries a synthetic `@example.com`/`caratforus.com`
-- test address or an intentionally-invalid one ("not-a-valid-address").
-- PRODUCTION ROWS, if any exist at deploy time, are expected to be the SAME
-- kind of artefact: this app has no customer-facing traffic yet, so any
-- production `bank_payment_order` row predating this column is a live-gate
-- or manual-verification artefact, not a real customer's order, and carries
-- no authenticated identity that could be recovered from Shopify after the
-- fact (the defect this migration closes is precisely that the anonymous
-- path never captured one). The sentinel below is therefore the TRUTHFUL
-- value for every row this migration will actually touch, not a convenience
-- backfill for dev only -- same precedent as migration
-- 20260922060000_bank_payment_verified_by_authenticated_identity's
-- verified_by backfill (an unmistakable placeholder, never a plausible-
-- looking invented identity).
--
-- IF THIS ASSUMPTION EVER STOPS HOLDING -- i.e. a `bank_payment_order` row
-- is found that represents a REAL customer's order placed before this
-- column existed (once the storefront has genuine Bank Payment traffic) --
-- DO NOT let a future blanket backfill/migration silently sentinel it.
-- Whoever next touches this table must instead: (1) identify those specific
-- rows (e.g. by `shopifyDraftOrderGid`/`completedAt` predating this
-- migration's deploy date, cross-referenced against the Shopify Admin API
-- for a real customer on the underlying order), and (2) migrate THOSE rows
-- in a separate, targeted, two-step migration that backfills the real
-- customer gid where recoverable and leaves an explicit, reviewed decision
-- (not a default sentinel) for any row where it is not. This paragraph is
-- the flag for that check -- it belongs here, not only in a chat log.

ALTER TABLE "bank_payment_order" ADD COLUMN "customer_gid" TEXT;

UPDATE "bank_payment_order"
SET "customer_gid" = 'gid://shopify/Customer/0'
WHERE "customer_gid" IS NULL;

ALTER TABLE "bank_payment_order" ALTER COLUMN "customer_gid" SET NOT NULL;

CREATE INDEX "bank_payment_order_customer_gid_idx" ON "bank_payment_order"("customer_gid");

COMMENT ON COLUMN "bank_payment_order"."customer_gid" IS
  'docs/REQUIRED-CUSTOMER-ACCOUNTS.md -- the AUTHENTICATED Shopify customer identity (signed App Proxy logged_in_customer_id), never the browser-supplied email. NOT NULL: every row is created by a route that refuses anonymous requests.';
