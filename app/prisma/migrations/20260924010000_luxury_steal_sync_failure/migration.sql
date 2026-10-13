-- Slice 3 task 3-2b (docs/specs/SLICE-3-LUXURY-STEALS.md criterion 152).
--
-- Failure-episode tracking for the `carat.luxury_steal` metafield sync.
-- Deliberately NOT price_sync_failure and NOT a copy of its full column set:
-- see the model doc comment in schema.prisma for why this table carries no
-- suspended_at / alert_state / dismissed_* columns at all. A failed sync
-- here must never make a variant unavailable, so there is nothing in this
-- table's shape that could be mistaken for a purchasability signal.
--
-- HAND-AUTHORED rather than `prisma migrate dev`, per this task's migration
-- -safety constraint: `migrate dev` reported the prior migration
-- (20260922060000) as "modified after applied" against this shared dev
-- database, and reset is forbidden. Verified with
-- `prisma migrate diff --from-schema-datasource prisma/schema.prisma
-- --to-schema-datamodel prisma/schema.prisma --script` immediately before
-- writing this file: the live database already matches every OTHER model in
-- schema.prisma exactly, and the diff's only output is the CreateTable /
-- CreateIndex / AddForeignKey statements below (the earlier refusal was a
-- one-off race against a concurrent migration, not real drift). The
-- CREATE UNIQUE INDEX / CHECK constraints below are additive, in the same
-- style `migrate dev` would have generated, mirroring
-- price_calculation_failure_one_open_per_variant (migration
-- 20260919090500) and price_calculation_failure_attempt_count_positive.

-- CreateTable
CREATE TABLE "luxury_steal_sync_failure" (
    "id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "first_failed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_attempt_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "last_error" TEXT NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_trigger" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "luxury_steal_sync_failure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "luxury_steal_sync_failure_master_variant_id_idx" ON "luxury_steal_sync_failure"("master_variant_id");

-- AddForeignKey
ALTER TABLE "luxury_steal_sync_failure" ADD CONSTRAINT "luxury_steal_sync_failure_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- luxury_steal_sync_failure: at most one OPEN episode per variant. Prisma
-- cannot express a partial unique index, so this is raw SQL, mirroring
-- price_sync_failure_one_open_per_variant / price_calculation_failure_one_open_per_variant.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "luxury_steal_sync_failure_one_open_per_variant"
    ON "luxury_steal_sync_failure" ("master_variant_id")
    WHERE "resolved_at" IS NULL;

ALTER TABLE "luxury_steal_sync_failure"
  ADD CONSTRAINT "luxury_steal_sync_failure_attempt_count_positive" CHECK (attempt_count >= 1);

-- A resolution names its trigger together with its timestamp, never one
-- without the other -- mirrors price_calculation_failure_resolution_pairing.
ALTER TABLE "luxury_steal_sync_failure"
  ADD CONSTRAINT "luxury_steal_sync_failure_resolution_pairing" CHECK (
    (resolved_at IS NULL AND resolved_trigger IS NULL)
    OR (resolved_at IS NOT NULL AND btrim(resolved_trigger) <> '')
  );
