-- Follow-up to 20260925010000_slice5_warranty_claims_schema. The prior
-- migration's hand-authored foreign key name was shortened unnecessarily
-- (the full Prisma-generated name fits Postgres's 63-byte identifier limit
-- at 62 bytes) -- `prisma migrate diff` caught the mismatch. Never edit an
-- applied migration; this renames the constraint in a new one instead, so
-- `schema.prisma` and the database agree exactly.

ALTER TABLE "warranty_claim"
    RENAME CONSTRAINT "warranty_claim_coverage_not_established_acknowledgment_i_fkey"
    TO "warranty_claim_coverage_not_established_acknowledgment_id_fkey";
