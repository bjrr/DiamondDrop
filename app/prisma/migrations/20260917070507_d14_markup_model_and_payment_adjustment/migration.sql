-- AlterEnum
ALTER TYPE "cost_component_type" ADD VALUE 'payment_adjustment';

-- AlterTable
ALTER TABLE "pricing_profile" ADD COLUMN     "target_markup_rate" DECIMAL(9,6),
ALTER COLUMN "target_gross_margin_rate" DROP NOT NULL,
ALTER COLUMN "auto_apply_tolerance_bps" DROP NOT NULL;

-- D14 (owner-resolved 2026-09-17). A profile declares ONE margin model and
-- must carry exactly the rate that model reads. Without this, a profile could
-- say MARKUP_ON_COST_V1 while only target_gross_margin_rate was populated;
-- the solve would throw at calculation time instead of at configuration time,
-- and a profile carrying BOTH rates would leave it ambiguous which number the
-- owner actually intended as the target.
ALTER TABLE "pricing_profile"
  ADD CONSTRAINT "pricing_profile_margin_model_rate_check" CHECK (
    (margin_model = 'TARGET_GROSS_MARGIN_V1'
       AND target_gross_margin_rate IS NOT NULL AND target_markup_rate IS NULL)
    OR
    (margin_model = 'MARKUP_ON_COST_V1'
       AND target_markup_rate IS NOT NULL AND target_gross_margin_rate IS NULL)
  );

-- The auto-apply tolerance is now nullable, and NULL is load-bearing rather
-- than "not filled in yet": it DISABLES automatic price publication, so every
-- change routes to manual approval. Documented on the column so a later
-- migration does not "helpfully" backfill a default and silently re-enable
-- automatic publication.
COMMENT ON COLUMN "pricing_profile"."auto_apply_tolerance_bps" IS
  'Basis points. NULL disables automatic Shopify publication entirely (every change needs manual approval); 0 means any non-zero change needs approval. Do not backfill a default.';
