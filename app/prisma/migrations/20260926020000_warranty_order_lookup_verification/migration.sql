-- D33 (docs/ARCHITECTURE-MVP1.md) — the guest warranty-order-lookup
-- verification flow. See warranty_order_lookup_verification's doc comment in
-- schema.prisma for the full reasoning (token-as-credential hashing,
-- single-use-under-concurrency via the application's conditional UPDATE
-- against this table's unique token_hash, why this is not a column on
-- warranty_claim).
--
-- HAND-AUTHORED, same reasoning as 20260925010000_slice5_warranty_claims_schema's
-- header: this repo's migration queue had a concurrent, not-yet-authored
-- migration ahead of this one (20260926010000_slice4_buy_now_rma_schema) at
-- the time this was written, so `prisma migrate dev` could not be run
-- without first resolving that unrelated migration — out of this task's
-- scope, and `migrate reset`/a shadow-database `migrate diff` fallback are
-- both forbidden in this repo. Apply with `migrate deploy` only, once that
-- migration exists ahead of this one. Verify afterwards with
-- `prisma migrate diff --from-schema-datasource prisma/schema.prisma
-- --to-schema-datamodel prisma/schema.prisma` reporting no difference.

-- CreateTable
CREATE TABLE "warranty_order_lookup_verification" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,

    "order_ref" TEXT NOT NULL,
    "order_name" TEXT NOT NULL,
    "purchaser_email" TEXT NOT NULL,

    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranty_order_lookup_verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warranty_order_lookup_verification_token_hash_key" ON "warranty_order_lookup_verification"("token_hash");

-- CreateIndex
CREATE INDEX "warranty_order_lookup_verification_expires_at_idx" ON "warranty_order_lookup_verification"("expires_at");
