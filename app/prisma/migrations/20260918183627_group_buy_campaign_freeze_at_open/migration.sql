-- CreateEnum
CREATE TYPE "group_buy_campaign_status" AS ENUM ('draft', 'open', 'closed', 'cancelled');

-- CreateTable
CREATE TABLE "group_buy_campaign" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "group_buy_campaign_status" NOT NULL DEFAULT 'draft',
    "pricing_profile_id" UUID,
    "profile_version" INTEGER,
    "snapshot_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "frozen_as_of" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "unsafe_override_by" TEXT,
    "unsafe_override_reason" TEXT,
    "unsafe_override_at" TIMESTAMPTZ(6),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_buy_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_buy_campaign_tier" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "tier_number" INTEGER NOT NULL,
    "min_qualifying_units" INTEGER NOT NULL,
    "price_multiplier" DECIMAL(9,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_campaign_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_buy_campaign_variant" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "frozen_base_price_minor_units" BIGINT NOT NULL,
    "frozen_landed_cost_minor_units" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_campaign_variant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_campaign_code_key" ON "group_buy_campaign"("code");

-- CreateIndex
CREATE INDEX "group_buy_campaign_status_idx" ON "group_buy_campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_campaign_tier_campaign_id_tier_number_key" ON "group_buy_campaign_tier"("campaign_id", "tier_number");

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_campaign_tier_campaign_id_min_qualifying_units_key" ON "group_buy_campaign_tier"("campaign_id", "min_qualifying_units");

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_campaign_variant_campaign_id_master_variant_id_key" ON "group_buy_campaign_variant"("campaign_id", "master_variant_id");

-- AddForeignKey
ALTER TABLE "group_buy_campaign" ADD CONSTRAINT "group_buy_campaign_pricing_profile_id_fkey" FOREIGN KEY ("pricing_profile_id") REFERENCES "pricing_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_campaign" ADD CONSTRAINT "group_buy_campaign_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_campaign_tier" ADD CONSTRAINT "group_buy_campaign_tier_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "group_buy_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_campaign_variant" ADD CONSTRAINT "group_buy_campaign_variant_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "group_buy_campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_campaign_variant" ADD CONSTRAINT "group_buy_campaign_variant_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- FREEZE AT OPEN, enforced by the database.
--
-- README: "When a campaign opens, freeze/version its applicable cost inputs,
-- pricing assumptions, tier thresholds/percentages, and eligible-variant
-- prices. Market changes after opening must not retroactively alter campaign
-- tier prices."
--
-- Application code could enforce this, and does. These triggers exist because
-- the guarantee has to survive a careless script, a future ORM change, or a
-- manual UPDATE run at 2am to "just fix one price" — the same reasoning as the
-- append-only evidence tables. A frozen price that can be edited is not frozen.
-- =====================================================================

-- Tiers and eligible-variant prices are immutable once the campaign leaves
-- draft. Editable while drafting, untouchable afterwards.
CREATE OR REPLACE FUNCTION group_buy_frozen_child_guard()
RETURNS TRIGGER AS $$
DECLARE
    campaign_status text;
    target_campaign uuid;
BEGIN
    target_campaign := COALESCE(NEW.campaign_id, OLD.campaign_id);
    SELECT status::text INTO campaign_status
      FROM group_buy_campaign WHERE id = target_campaign;

    IF campaign_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION
            'campaign % is %, so its tiers and eligible-variant prices are frozen (% rejected)',
            target_campaign, campaign_status, TG_OP
            USING ERRCODE = '23001'; -- restrict_violation
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER group_buy_campaign_tier_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON "group_buy_campaign_tier"
    FOR EACH ROW EXECUTE FUNCTION group_buy_frozen_child_guard();

CREATE TRIGGER group_buy_campaign_variant_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON "group_buy_campaign_variant"
    FOR EACH ROW EXECUTE FUNCTION group_buy_frozen_child_guard();

-- The campaign row itself stays partly mutable — status has to advance, and a
-- close has to be recordable. What may NEVER change is the frozen pricing
-- basis, because that is the thing the whole feature promises not to move.
CREATE OR REPLACE FUNCTION group_buy_campaign_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'draft' THEN
        IF NEW.pricing_profile_id IS DISTINCT FROM OLD.pricing_profile_id
        OR NEW.profile_version    IS DISTINCT FROM OLD.profile_version
        OR NEW.snapshot_id        IS DISTINCT FROM OLD.snapshot_id
        OR NEW.frozen_as_of       IS DISTINCT FROM OLD.frozen_as_of
        OR NEW.currency           IS DISTINCT FROM OLD.currency
        OR NEW.opened_at          IS DISTINCT FROM OLD.opened_at THEN
            RAISE EXCEPTION
                'campaign % is %: its frozen pricing basis cannot be changed',
                OLD.id, OLD.status
                USING ERRCODE = '23001';
        END IF;
    END IF;

    -- Reopening would silently re-expose frozen prices to editing, since the
    -- child guard keys off draft.
    IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
        RAISE EXCEPTION 'campaign % cannot return to draft once opened', OLD.id
            USING ERRCODE = '23001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER group_buy_campaign_frozen_basis
    BEFORE UPDATE ON "group_buy_campaign"
    FOR EACH ROW EXECUTE FUNCTION group_buy_campaign_guard();

-- An open campaign must actually carry the things it froze. Enforced as a
-- constraint rather than left to the service, so a half-frozen campaign cannot
-- exist even transiently.
ALTER TABLE "group_buy_campaign"
  ADD CONSTRAINT "group_buy_campaign_open_is_frozen" CHECK (
    status = 'draft'
    OR (pricing_profile_id IS NOT NULL
        AND profile_version IS NOT NULL
        AND snapshot_id IS NOT NULL
        AND frozen_as_of IS NOT NULL
        AND opened_at IS NOT NULL)
  );

-- Mirrors the domain validation in app/domain/groupbuy/tiers.ts. Deliberately
-- NOT a boundary: no threshold or multiplier value is fixed here, only the
-- shape the README constrains.
ALTER TABLE "group_buy_campaign_tier"
  ADD CONSTRAINT "group_buy_tier_units_positive" CHECK (min_qualifying_units >= 1);

ALTER TABLE "group_buy_campaign_tier"
  ADD CONSTRAINT "group_buy_tier_multiplier_range"
  CHECK (price_multiplier > 0 AND price_multiplier <= 1);

ALTER TABLE "group_buy_campaign_variant"
  ADD CONSTRAINT "group_buy_variant_price_positive"
  CHECK (frozen_base_price_minor_units > 0 AND frozen_landed_cost_minor_units >= 0);

-- An override is an attributed exception; it cannot be half-recorded.
ALTER TABLE "group_buy_campaign"
  ADD CONSTRAINT "group_buy_override_complete" CHECK (
    (unsafe_override_by IS NULL AND unsafe_override_reason IS NULL AND unsafe_override_at IS NULL)
    OR (unsafe_override_by IS NOT NULL AND btrim(unsafe_override_by) <> ''
        AND unsafe_override_reason IS NOT NULL AND btrim(unsafe_override_reason) <> ''
        AND unsafe_override_at IS NOT NULL)
  );
