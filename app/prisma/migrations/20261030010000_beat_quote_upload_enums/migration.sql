-- Enum values ONLY, deliberately alone in their own migration.
--
-- Prisma wraps each migration file in a transaction, and Postgres will not
-- let a newly added enum value be USED in the same transaction that adds it.
-- Splitting guarantees these are committed before the table that references
-- the type is created, rather than relying on a version-dependent nuance.

-- A document kind, for a quote PDF. The enum keeps its warranty name because
-- it backs the SHARED upload_destination table; renaming it would mean
-- migrating warranty and custom jewelry too, for no behavioural gain.
--
-- This does NOT widen what warranty accepts: each route enumerates the kinds
-- it will take in its own request schema, and the warranty routes still list
-- photo and video only.
ALTER TYPE "warranty_claim_upload_kind" ADD VALUE IF NOT EXISTS 'document';

-- A purpose, so a destination issued for a quote can never be consumed by a
-- warranty claim. `purpose` is already part of the consumption WHERE clause,
-- so cross-purpose reuse simply finds no row.
ALTER TYPE "upload_destination_purpose" ADD VALUE IF NOT EXISTS 'beat_quote_submission';
