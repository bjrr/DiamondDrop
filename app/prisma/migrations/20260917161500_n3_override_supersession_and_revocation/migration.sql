-- D14 / architect follow-up N3: override supersession and revocation.
--
-- price_override is append-only, so neither "this replaces the previous
-- override" nor "go back to the calculated price" can be expressed by editing
-- or deleting a row. Both become appended rows: a `set` that names its
-- predecessor, or a `revoke` that carries no price.
--
-- Done now, before Slice 2 consumes the table and before it holds real
-- decisions, because changing the shape of append-only history later means
-- migrating rows that are supposed to be immutable evidence.

CREATE TYPE "price_override_kind" AS ENUM ('set', 'revoke');

-- DEFAULT 'set' populates the existing rows, all of which are manual prices.
-- The default is KEPT (unlike the D9 columns): `set` is the overwhelmingly
-- common case and an override created without naming its kind is a set.
ALTER TABLE "price_override"
  ADD COLUMN "kind" "price_override_kind" NOT NULL DEFAULT 'set',
  ADD COLUMN "supersedes_id" UUID;

-- A revocation has no price of its own.
ALTER TABLE "price_override"
  ALTER COLUMN "override_price_minor_units" DROP NOT NULL;

ALTER TABLE "price_override"
  ADD CONSTRAINT "price_override_supersedes_id_fkey"
  FOREIGN KEY ("supersedes_id") REFERENCES "price_override"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Stops two rows superseding the same predecessor. Without this the history
-- forks and "which override is in effect?" has two answers — the sort of
-- ambiguity that only shows up when someone is disputing a price.
CREATE UNIQUE INDEX "price_override_supersedes_id_key"
  ON "price_override"("supersedes_id");

-- Replaces the plain positive-price check. A CHECK returning UNKNOWN on NULL
-- would have let a `set` row exist with no price at all, which is the one
-- combination that would silently mean "no override" while looking like one.
ALTER TABLE "price_override"
  DROP CONSTRAINT "price_override_price_positive";

ALTER TABLE "price_override"
  ADD CONSTRAINT "price_override_kind_price_coherent" CHECK (
    (kind = 'set'    AND override_price_minor_units IS NOT NULL
                     AND override_price_minor_units > 0)
    OR
    (kind = 'revoke' AND override_price_minor_units IS NULL)
  );

COMMENT ON COLUMN "price_override"."supersedes_id" IS
  'The override this row replaces. NULL on the first override for a variant. The override in effect for a variant is the row that nothing supersedes; if that row is a revoke, the calculated price applies.';
