-- Slice 2 stage 2A follow-on
-- (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §7; sibling to M5's
-- price_sync_failure, migration 20260919085156).
--
-- One row per FAILURE EPISODE for a variant's price RECALCULATION -- never
-- per attempt. Deliberately a SEPARATE table from price_sync_failure: a sync
-- failure means a price WAS computed and Shopify refused it; this means no
-- price could be computed AT ALL. See the model doc comment in
-- schema.prisma for the full reasoning, including why this table carries no
-- alert_state or dismissed_* columns (owner §7 describes only an immediate
-- notification, never a persistent alert a human silences).

-- CreateEnum
CREATE TYPE "price_calculation_failure_type" AS ENUM (
    'unresolved_band',
    'invalid_size',
    'invalid_weight',
    'missing_cost_input',
    'ambiguous_cost_input',
    'currency_mismatch',
    'margin_unreachable',
    'unknown'
);

-- CreateTable
CREATE TABLE "price_calculation_failure" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "first_failed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "failure_type" "price_calculation_failure_type" NOT NULL,
    "last_error" TEXT NOT NULL,
    "suspended_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_trigger" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_calculation_failure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_calculation_failure_master_variant_id_idx" ON "price_calculation_failure"("master_variant_id");

-- CreateIndex
CREATE INDEX "price_calculation_failure_failure_type_idx" ON "price_calculation_failure"("failure_type");

-- AddForeignKey
ALTER TABLE "price_calculation_failure" ADD CONSTRAINT "price_calculation_failure_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- price_calculation_failure: at most one OPEN episode per variant, mirroring
-- price_sync_failure_one_open_per_variant (migration 20260919085156). Prisma
-- cannot express a partial unique index, so this is raw SQL.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "price_calculation_failure_one_open_per_variant"
    ON "price_calculation_failure" ("master_variant_id")
    WHERE "resolved_at" IS NULL;

ALTER TABLE "price_calculation_failure"
  ADD CONSTRAINT "price_calculation_failure_attempt_count_positive" CHECK (attempt_count >= 1);

-- A resolution names its trigger/actor together with its timestamp, never
-- one without the other (owner §7 recovery step 5). Mirrors
-- price_sync_failure_dismiss_complete's attributed-exception shape.
ALTER TABLE "price_calculation_failure"
  ADD CONSTRAINT "price_calculation_failure_resolution_pairing" CHECK (
    (resolved_at IS NULL AND resolved_trigger IS NULL)
    OR (resolved_at IS NOT NULL AND btrim(resolved_trigger) <> '')
  );
