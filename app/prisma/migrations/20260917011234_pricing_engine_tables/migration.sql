-- CreateEnum
CREATE TYPE "metal" AS ENUM ('sterling_silver', 'gold', 'platinum');

-- CreateEnum
CREATE TYPE "purity" AS ENUM ('925', '10k', '14k', '18k', 'pt950');

-- CreateEnum
CREATE TYPE "metal_price_source" AS ENUM ('manual', 'feed');

-- CreateEnum
CREATE TYPE "stone_type" AS ENUM ('natural_diamond', 'lab_diamond', 'moissanite', 'colored_gemstone', 'accent_melee');

-- CreateEnum
CREATE TYPE "stone_cost_kind" AS ENUM ('per_stone', 'per_carat');

-- CreateEnum
CREATE TYPE "cost_component_type" AS ENUM ('metal_loss', 'cad', 'casting', 'setting', 'polishing', 'assembly', 'qc', 'packaging', 'shipping', 'insurance', 'warranty_reserve', 'supplier_fee', 'other', 'payment_processing');

-- CreateEnum
CREATE TYPE "cost_component_basis" AS ENUM ('cost_side', 'revenue_side');

-- CreateEnum
CREATE TYPE "cost_component_value_kind" AS ENUM ('fixed', 'per_stone', 'percentage');

-- CreateEnum
CREATE TYPE "pricing_profile_code" AS ENUM ('buy_now', 'group_buy', 'custom', 'wholesale', 'friends_family', 'marketplace');

-- CreateEnum
CREATE TYPE "size_axis" AS ENUM ('ring_size_us', 'length_inches', 'none');

-- CreateEnum
CREATE TYPE "master_product_status" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "master_variant_status" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "price_calculation_status" AS ENUM ('computed', 'failed');

-- CreateEnum
CREATE TYPE "price_sync_decision" AS ENUM ('auto_apply', 'needs_approval');

-- CreateEnum
CREATE TYPE "price_sync_intent_status" AS ENUM ('pending_approval', 'approved', 'rejected', 'syncing', 'synced', 'failed', 'superseded');

-- CreateTable
CREATE TABLE "metal_price" (
    "id" UUID NOT NULL,
    "metal" "metal" NOT NULL,
    "purity" "purity" NOT NULL,
    "price_per_gram" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "source" "metal_price_source" NOT NULL,
    "entered_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metal_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stone_cost" (
    "id" UUID NOT NULL,
    "stone_type" "stone_type" NOT NULL,
    "shape" TEXT NOT NULL,
    "carat_min" DECIMAL(8,3) NOT NULL,
    "carat_max" DECIMAL(8,3) NOT NULL,
    "color" TEXT,
    "clarity" TEXT,
    "cut_grade" TEXT,
    "lab_status" TEXT,
    "supplier_ref" TEXT,
    "cost_kind" "stone_cost_kind" NOT NULL,
    "cost_minor_units" BIGINT,
    "cost_per_carat" DECIMAL(18,6),
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stone_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_component" (
    "id" UUID NOT NULL,
    "component_type" "cost_component_type" NOT NULL,
    "basis" "cost_component_basis" NOT NULL,
    "value_kind" "cost_component_value_kind" NOT NULL,
    "amount_minor_units" BIGINT,
    "currency" CHAR(3),
    "rate" DECIMAL(9,6),
    "effective_from" TIMESTAMP(3) NOT NULL,
    "entered_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_profile" (
    "id" UUID NOT NULL,
    "code" "pricing_profile_code" NOT NULL,
    "version" INTEGER NOT NULL,
    "margin_model" TEXT NOT NULL,
    "target_gross_margin_rate" DECIMAL(9,6) NOT NULL,
    "min_gross_margin_rate" DECIMAL(9,6) NOT NULL,
    "min_dollar_profit_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rounding_rule_id" TEXT NOT NULL,
    "price_ending_rule_id" TEXT NOT NULL,
    "auto_apply_tolerance_bps" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "is_placeholder" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_product" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "size_axis" "size_axis" NOT NULL,
    "allowed_size_min" DECIMAL(6,2) NOT NULL,
    "allowed_size_max" DECIMAL(6,2) NOT NULL,
    "size_increment" DECIMAL(6,2) NOT NULL,
    "base_size" DECIMAL(6,2) NOT NULL,
    "offered_metals" "metal"[],
    "shopify_product_gid" TEXT,
    "is_luxury_steal" BOOLEAN NOT NULL DEFAULT false,
    "status" "master_product_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_variant" (
    "id" UUID NOT NULL,
    "master_product_id" UUID NOT NULL,
    "metal" "metal" NOT NULL,
    "purity" "purity" NOT NULL,
    "band_id" UUID,
    "base_weight_grams" DECIMAL(10,4) NOT NULL,
    "weight_per_full_size_grams" DECIMAL(10,4) NOT NULL,
    "min_price_minor_units" BIGINT,
    "min_price_currency" CHAR(3),
    "shopify_variant_gid" TEXT,
    "status" "master_variant_status" NOT NULL DEFAULT 'draft',
    "last_synced_price_calculation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ring_size_band" (
    "id" UUID NOT NULL,
    "master_product_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "size_min" DECIMAL(6,2) NOT NULL,
    "size_max" DECIMAL(6,2) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ring_size_band_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_weight_override" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "size" DECIMAL(6,2) NOT NULL,
    "weight_grams" DECIMAL(10,4) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_weight_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_variant_stone" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "stone_type" "stone_type" NOT NULL,
    "shape" TEXT NOT NULL,
    "carat" DECIMAL(8,3) NOT NULL,
    "color" TEXT,
    "clarity" TEXT,
    "cut_grade" TEXT,
    "lab_status" TEXT,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_variant_stone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_calculation" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "pricing_profile_id" UUID NOT NULL,
    "profile_version" INTEGER NOT NULL,
    "engine_version" TEXT NOT NULL,
    "rounding_rule_id" TEXT NOT NULL,
    "price_ending_rule_id" TEXT NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "cost_basis_size" DECIMAL(6,2),
    "landed_cost_minor_units" BIGINT NOT NULL,
    "computed_price_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "price_calculation_status" NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_calculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_sync_intent" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "price_calculation_id" UUID NOT NULL,
    "decision" "price_sync_decision" NOT NULL,
    "status" "price_sync_intent_status" NOT NULL,
    "previous_price_minor_units" BIGINT,
    "previous_price_currency" CHAR(3),
    "delta_bps" INTEGER,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "reason" TEXT,
    "synced_at" TIMESTAMP(3),
    "shopify_variant_gid" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_sync_intent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metal_price_metal_purity_idx" ON "metal_price"("metal", "purity");

-- CreateIndex
CREATE UNIQUE INDEX "metal_price_metal_purity_effective_from_key" ON "metal_price"("metal", "purity", "effective_from");

-- CreateIndex
CREATE INDEX "stone_cost_stone_type_shape_idx" ON "stone_cost"("stone_type", "shape");

-- CreateIndex
CREATE UNIQUE INDEX "stone_cost_stone_type_shape_carat_min_carat_max_color_clari_key" ON "stone_cost"("stone_type", "shape", "carat_min", "carat_max", "color", "clarity", "cut_grade", "lab_status", "supplier_ref", "effective_from");

-- CreateIndex
CREATE INDEX "cost_component_component_type_idx" ON "cost_component"("component_type");

-- CreateIndex
CREATE UNIQUE INDEX "cost_component_component_type_value_kind_effective_from_key" ON "cost_component"("component_type", "value_kind", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_profile_code_version_key" ON "pricing_profile"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "master_product_shopify_product_gid_key" ON "master_product"("shopify_product_gid");

-- CreateIndex
CREATE INDEX "master_product_status_idx" ON "master_product"("status");

-- CreateIndex
CREATE UNIQUE INDEX "master_variant_shopify_variant_gid_key" ON "master_variant"("shopify_variant_gid");

-- CreateIndex
CREATE UNIQUE INDEX "master_variant_last_synced_price_calculation_id_key" ON "master_variant"("last_synced_price_calculation_id");

-- CreateIndex
CREATE INDEX "master_variant_status_idx" ON "master_variant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "master_variant_master_product_id_metal_purity_band_id_key" ON "master_variant"("master_product_id", "metal", "purity", "band_id");

-- CreateIndex
CREATE INDEX "ring_size_band_master_product_id_idx" ON "ring_size_band"("master_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_weight_override_master_variant_id_size_key" ON "variant_weight_override"("master_variant_id", "size");

-- CreateIndex
CREATE UNIQUE INDEX "master_variant_stone_master_variant_id_position_key" ON "master_variant_stone"("master_variant_id", "position");

-- CreateIndex
CREATE INDEX "price_calculation_master_variant_id_created_at_idx" ON "price_calculation"("master_variant_id", "created_at");

-- CreateIndex
CREATE INDEX "price_calculation_status_idx" ON "price_calculation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "price_calculation_run_id_master_variant_id_key" ON "price_calculation"("run_id", "master_variant_id");

-- CreateIndex
CREATE INDEX "price_sync_intent_master_variant_id_idx" ON "price_sync_intent"("master_variant_id");

-- CreateIndex
CREATE INDEX "price_sync_intent_status_idx" ON "price_sync_intent"("status");

-- AddForeignKey
ALTER TABLE "master_variant" ADD CONSTRAINT "master_variant_master_product_id_fkey" FOREIGN KEY ("master_product_id") REFERENCES "master_product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_variant" ADD CONSTRAINT "master_variant_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "ring_size_band"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_variant" ADD CONSTRAINT "master_variant_last_synced_price_calculation_id_fkey" FOREIGN KEY ("last_synced_price_calculation_id") REFERENCES "price_calculation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ring_size_band" ADD CONSTRAINT "ring_size_band_master_product_id_fkey" FOREIGN KEY ("master_product_id") REFERENCES "master_product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_weight_override" ADD CONSTRAINT "variant_weight_override_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_variant_stone" ADD CONSTRAINT "master_variant_stone_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_calculation" ADD CONSTRAINT "price_calculation_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_calculation" ADD CONSTRAINT "price_calculation_pricing_profile_id_fkey" FOREIGN KEY ("pricing_profile_id") REFERENCES "pricing_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_calculation" ADD CONSTRAINT "price_calculation_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_sync_intent" ADD CONSTRAINT "price_sync_intent_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_sync_intent" ADD CONSTRAINT "price_sync_intent_price_calculation_id_fkey" FOREIGN KEY ("price_calculation_id") REFERENCES "price_calculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints (docs/specs/SLICE-1-PRICING.md §7.2). Prisma's schema
-- language cannot express CHECK, so these are hand-written here, in the same
-- migration that creates the tables they constrain — the same pattern slice
-- 0 used for its append-only triggers (raw SQL alongside generated DDL).
-- ---------------------------------------------------------------------------

-- stone_cost: exactly one of cost_minor_units / cost_per_carat is populated,
-- and it agrees with cost_kind. currency is always required — a per-carat
-- rate still needs a currency (it is a price, just not a Money amount; see
-- schema.prisma's F-16 comment on "RATE COLUMNS").
ALTER TABLE "stone_cost" ADD CONSTRAINT "stone_cost_kind_matches_value" CHECK (
    ("cost_kind" = 'per_stone' AND "cost_minor_units" IS NOT NULL AND "cost_per_carat" IS NULL)
    OR
    ("cost_kind" = 'per_carat' AND "cost_per_carat" IS NOT NULL AND "cost_minor_units" IS NULL)
);

-- cost_component: the populated column matches value_kind. fixed/per_stone
-- are Money (amount + currency, per F-16); percentage is a dimensionless
-- rate with no currency at all (unlike stone_cost's per-carat rate, a
-- percentage is not itself a price).
ALTER TABLE "cost_component" ADD CONSTRAINT "cost_component_value_kind_matches_value" CHECK (
    ("value_kind" IN ('fixed', 'per_stone') AND "amount_minor_units" IS NOT NULL AND "currency" IS NOT NULL AND "rate" IS NULL)
    OR
    ("value_kind" = 'percentage' AND "rate" IS NOT NULL AND "amount_minor_units" IS NULL AND "currency" IS NULL)
);

-- pricing_profile: the hard floor can never be configured above the pricing
-- objective (§5.5's distinction between target_gross_margin_rate and
-- min_gross_margin_rate depends on this holding).
ALTER TABLE "pricing_profile" ADD CONSTRAINT "pricing_profile_min_margin_le_target" CHECK (
    "min_gross_margin_rate" <= "target_gross_margin_rate"
);

-- master_variant / price_sync_intent: the nullable Money columns (variant
-- floor; previous synced price) are paired with their currency column per
-- F-16 — never a bare amount without its currency, even when both are null.
-- Not explicitly requested by the task list; added as a direct extension of
-- the already-established F-16 convention, flagged here for visibility.
ALTER TABLE "master_variant" ADD CONSTRAINT "master_variant_min_price_currency_pairing" CHECK (
    ("min_price_minor_units" IS NULL) = ("min_price_currency" IS NULL)
);

ALTER TABLE "price_sync_intent" ADD CONSTRAINT "price_sync_intent_previous_price_currency_pairing" CHECK (
    ("previous_price_minor_units" IS NULL) = ("previous_price_currency" IS NULL)
);

-- ---------------------------------------------------------------------------
-- Partial unique index (docs/specs/SLICE-1-PRICING.md §7.2, §9.4, criterion
-- 24). Prisma cannot express a partial unique index, so this is raw SQL.
-- At most one NON-TERMINAL price_sync_intent may exist per master_variant
-- at a time; a newer run must mark the prior pending intent `superseded`
-- (with an audit event, per §9.4) rather than create a second one. Once an
-- intent reaches a terminal status (synced, rejected, failed, superseded)
-- it no longer counts against this index, so a new intent may be created.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "price_sync_intent_one_non_terminal_per_variant"
    ON "price_sync_intent" ("master_variant_id")
    WHERE "status" NOT IN ('synced', 'rejected', 'failed', 'superseded');

-- ---------------------------------------------------------------------------
-- Append-only enforcement, extended to price_calculation (docs/specs/
-- SLICE-1-PRICING.md §6, §7.2, criterion 22). Reuses the trigger functions
-- from migration 20260913000100_append_only_evidence_triggers and
-- 20260914000000_append_only_evidence_truncate_triggers rather than
-- redefining them — those functions are generic over TG_TABLE_NAME/TG_OP
-- and carry no table-specific logic. Slice 0 needed a follow-up migration
-- to add TRUNCATE coverage after the fact (see the truncate migration's own
-- header comment); this migration covers UPDATE, DELETE and TRUNCATE from
-- the start so that gap is not repeated here.
--
-- price_sync_intent is DELIBERATELY EXCLUDED: it is the mutable review/sync
-- state machine (§7.2, §9.3, §9.4), not an evidence table.
--
-- F-7 caveat (docs/specs/SLICE-0-FINDINGS.md; recorded again here per §6):
-- these triggers only bind so long as the runtime database role is not the
-- table owner. Until the slice-2 deploy task provisions a separate
-- migration role and restricts the runtime role to INSERT/SELECT, a runtime
-- role with sufficient privilege could DROP TRIGGER and then mutate this
-- table. This migration does not claim that gap is closed.
-- ---------------------------------------------------------------------------

-- price_calculation
CREATE TRIGGER price_calculation_no_update
    BEFORE UPDATE ON "price_calculation"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER price_calculation_no_delete
    BEFORE DELETE ON "price_calculation"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER price_calculation_no_truncate
    BEFORE TRUNCATE ON "price_calculation"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
