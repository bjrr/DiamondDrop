-- docs/BANK-CARD-PRICING.md, owner-locked 2026-09-18.
--
-- "Cash Price" / "Cash-equivalent Price" becomes BANK PAYMENT PRICE, and the
-- derived display price becomes the REGULAR/CARD PRICE. Eligible bank methods
-- are Zelle, bank transfer, designated ACH, wire, and future approved
-- bank/manual methods.
--
-- NO VALUE CHANGES ANYWHERE IN THIS FILE. Every stored amount already WAS the
-- authoritative selling price; only its name moves. The one behavioural change
-- shipping alongside this — the tiered card uplift with a $5 ceiling — lives in
-- application code under a NEW versioned rule id, precisely so that no stored
-- row has to be rewritten and every historical calculation still reproduces.
--
-- WHY RENAME RATHER THAN LEAVE THE COLUMNS ALONE. The policy permits keeping
-- internal names, but "cash_price_minor_units" and "bank payment price" in the
-- same system means every future reader has to establish they are the same
-- thing. That ambiguity has already cost this project once: an under-specified
-- "price" column is what let the storefront publish the internal figure as the
-- customer-facing headline.
--
-- PostgreSQL rewrites dependent CHECK expressions, indexes and views on a
-- column rename, so nothing below needs re-stating. Constraint NAMES are
-- renamed alongside their columns because Postgres does not do that part, and a
-- constraint still called "..._cash_..." guarding a bank-payment column is the
-- kind of near-miss that sends someone hunting for a second constraint.

-- price_calculation: the engine's stored answer.
ALTER TABLE "price_calculation"
  RENAME COLUMN "cash_price_minor_units" TO "bank_payment_price_minor_units";

-- group_buy_campaign_variant: the frozen base tier multipliers apply to.
ALTER TABLE "group_buy_campaign_variant"
  RENAME COLUMN "frozen_base_cash_price_minor_units"
  TO "frozen_base_bank_payment_price_minor_units";

ALTER TABLE "group_buy_campaign_variant"
  RENAME CONSTRAINT "group_buy_variant_cash_price_positive"
  TO "group_buy_variant_bank_payment_price_positive";

-- price_override: an owner override sets the Bank Payment Price.
ALTER TABLE "price_override"
  RENAME COLUMN "override_cash_price_minor_units"
  TO "override_bank_payment_price_minor_units";

ALTER TABLE "price_override"
  RENAME CONSTRAINT "price_override_kind_cash_price_coherent"
  TO "price_override_kind_bank_payment_price_coherent";

-- price_sync_intent: the auto-apply delta is bank-to-bank.
ALTER TABLE "price_sync_intent"
  RENAME COLUMN "previous_cash_price_minor_units"
  TO "previous_bank_payment_price_minor_units";

ALTER TABLE "price_sync_intent"
  RENAME COLUMN "previous_cash_price_currency"
  TO "previous_bank_payment_price_currency";

-- master_variant: the per-variant floor is a floor on the Bank Payment Price.
ALTER TABLE "master_variant"
  RENAME COLUMN "min_cash_price_minor_units" TO "min_bank_payment_price_minor_units";

ALTER TABLE "master_variant"
  RENAME COLUMN "min_cash_price_currency" TO "min_bank_payment_price_currency";

-- pricing_profile.
--
-- `fixed_card_uplift_rate` is named for what it now is: the SINGLE FIXED rate,
-- read only by the superseded CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1 rule. The
-- current tiered rule carries its own locked table in code, so that changing a
-- tier threshold or rate requires a new rule id and review rather than an
-- UPDATE that would silently re-price every historical calculation.
--
-- The RULE ID VALUES stored in the renamed column are untouched. They are
-- versioned identifiers referenced by stored calculations; renaming one would
-- orphan the rows that point at it.
ALTER TABLE "pricing_profile"
  RENAME COLUMN "credit_card_price_rule_id" TO "regular_card_price_rule_id";

ALTER TABLE "pricing_profile"
  RENAME COLUMN "credit_card_uplift_rate" TO "fixed_card_uplift_rate";

ALTER TABLE "pricing_profile"
  RENAME CONSTRAINT "pricing_profile_credit_card_uplift_rate_check"
  TO "pricing_profile_fixed_card_uplift_rate_check";

-- payment_basis: the enum a refund is settled against.
--
-- RENAME VALUE, not a new type: the mapping is exactly one-to-one, so every
-- existing row keeps its meaning and no backfill can get it wrong. 'cash' rows
-- were bank-method payments under the old vocabulary and are bank-method
-- payments under the new one.
ALTER TYPE "payment_basis" RENAME VALUE 'cash' TO 'bank_payment';
ALTER TYPE "payment_basis" RENAME VALUE 'credit_card' TO 'card';

COMMENT ON COLUMN "group_buy_refund"."payment_basis" IS
  'Which price the customer paid: bank_payment (Zelle/bank transfer/designated ACH/wire/approved manual) or card (Regular/Card Price). paid_per_unit_minor_units and final_per_unit_minor_units are both expressed in this basis.';

COMMENT ON COLUMN "price_calculation"."bank_payment_price_minor_units" IS
  'The authoritative Bank Payment Price. Markup, margin floor, minimum profit and variant floors are all measured on this. The Regular/Card Price is derived from it by the versioned rule on the pricing profile and is not stored.';
