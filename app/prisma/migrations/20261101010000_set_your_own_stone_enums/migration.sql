-- Set Your Own Stone — enum types ONLY, deliberately alone in this migration.
--
-- Prisma wraps each migration file in a transaction, and Postgres will not
-- let a newly added enum value be USED in the same transaction that adds it.
-- Splitting guarantees these are committed before the tables that reference
-- them are created, rather than relying on a version-dependent nuance. The
-- beat-quote upload migration pair does the same thing for the same reason.
--
-- NOT CREATED HERE: a stone-type enum. The pricing engine already defines
-- "stone_type" (natural_diamond, lab_diamond, moissanite, colored_gemstone,
-- accent_melee) for master_variant_stone, and this feature reuses it rather
-- than introducing a second vocabulary for the same concept. The three
-- customer-facing choices in docs/SET-YOUR-OWN-STONE.md §4 are a narrowing
-- enforced at the route boundary, not a new type.

-- Centre-stone shapes, shared by a customer's stone and by a ready setting's
-- compatibility row — so "oval stone, oval mounting" is a type-level fact
-- rather than two strings that happen to agree.
CREATE TYPE "stone_shape" AS ENUM (
  'round',
  'oval',
  'cushion',
  'princess',
  'emerald',
  'radiant',
  'pear',
  'marquise',
  'asscher',
  'heart'
);

-- The verdict the matching service reached (§11).
CREATE TYPE "stone_compatibility_status" AS ENUM (
  'automatic',
  'review_required',
  'no_match'
);

-- WHICH RULE produced that verdict. §10 requires recording the "rule/data
-- used to derive" a compatibility status: months later, "why was this shown
-- to the customer" needs an answer that does not depend on replaying mutable
-- configuration.
CREATE TYPE "stone_compatibility_rule" AS ENUM (
  'not_eligible',
  'shape_mismatch',
  'vendor_range_inside',
  'vendor_range_outside',
  'exact_nominal',
  'approved_tolerance',
  'review_band',
  'outside_all_rules'
);

CREATE TYPE "stone_session_status" AS ENUM (
  'open',
  'setting_submitted',
  'handed_to_custom'
);

-- The customer is supplying the centre stone (§9.1). ADDITIVE: every
-- existing custom_jewelry_project row keeps its current value, and the
-- intake route's own request schema still decides which values it accepts,
-- so widening the type does not widen the public contract by itself.
ALTER TYPE "custom_jewelry_starting_point" ADD VALUE IF NOT EXISTS 'customer_stone';
