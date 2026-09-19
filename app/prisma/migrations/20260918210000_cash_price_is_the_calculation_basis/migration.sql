-- Owner-locked 2026-09-18: ALL pricing calculations are based on the
-- CASH-EQUIVALENT price. The credit-card price is derived only after the cash
-- price is final, as cash x 1.05, and never re-enters a calculation.
--
-- This migration carries no data change whatsoever. Every stored value already
-- WAS a cash price; the columns just did not say so. What changes is that a
-- reader can no longer mistake one for the other.
--
-- WHY RENAME AT ALL. "computed_price_minor_units" is the ambiguity that let the
-- storefront publish the internal cash figure as the customer-facing headline.
-- A name that cannot be misread is cheaper than the defect it prevents, and
-- these renames are free: PostgreSQL rewrites dependent CHECK expressions,
-- indexes and views automatically, so nothing below needs re-stating.
--
-- Constraint NAMES are renamed alongside their columns. Postgres does not do
-- that part, and a constraint called "..._price_positive" guarding a column
-- called "..._cash_price_minor_units" is exactly the kind of near-miss that
-- sends someone looking for a second constraint that does not exist.

-- price_calculation: the engine's stored answer is the CASH price.
ALTER TABLE "price_calculation"
  RENAME COLUMN "computed_price_minor_units" TO "cash_price_minor_units";

-- group_buy_campaign_variant: the frozen base that tier multipliers apply to.
ALTER TABLE "group_buy_campaign_variant"
  RENAME COLUMN "frozen_base_price_minor_units" TO "frozen_base_cash_price_minor_units";

ALTER TABLE "group_buy_campaign_variant"
  RENAME CONSTRAINT "group_buy_variant_price_positive"
  TO "group_buy_variant_cash_price_positive";

-- price_override: an owner override sets the CASH price. The floors that warn
-- about it are measured on cash, and the displayed card price is re-derived
-- from it rather than typed separately.
ALTER TABLE "price_override"
  RENAME COLUMN "override_price_minor_units" TO "override_cash_price_minor_units";

ALTER TABLE "price_override"
  RENAME CONSTRAINT "price_override_kind_price_coherent"
  TO "price_override_kind_cash_price_coherent";

-- price_sync_intent: the delta is cash-to-cash. Comparing a new cash price
-- against a previously published CARD price would read as a ~5% drop on every
-- variant and could trip the auto-apply tolerance in the wrong direction.
ALTER TABLE "price_sync_intent"
  RENAME COLUMN "previous_price_minor_units" TO "previous_cash_price_minor_units";

ALTER TABLE "price_sync_intent"
  RENAME COLUMN "previous_price_currency" TO "previous_cash_price_currency";

-- master_variant: the per-variant floor is a floor on CASH, consistent with
-- every other floor in the system.
ALTER TABLE "master_variant"
  RENAME COLUMN "min_price_minor_units" TO "min_cash_price_minor_units";

ALTER TABLE "master_variant"
  RENAME COLUMN "min_price_currency" TO "min_cash_price_currency";

-- pricing_profile: "card" -> "credit_card", matching the domain vocabulary.
-- The RULE ID VALUE stored in this column is unchanged
-- ("CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1"): it is a versioned identifier referenced
-- by historical calculations, and renaming a version id would orphan them.
ALTER TABLE "pricing_profile"
  RENAME COLUMN "card_price_rule_id" TO "credit_card_price_rule_id";

ALTER TABLE "pricing_profile"
  RENAME COLUMN "card_uplift_rate" TO "credit_card_uplift_rate";

ALTER TABLE "pricing_profile"
  RENAME CONSTRAINT "pricing_profile_card_uplift_rate_check"
  TO "pricing_profile_credit_card_uplift_rate_check";
