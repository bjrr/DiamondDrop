-- Manufacturing labour: grams x a staff-entered rate per gram, with the
-- manufacturing source recorded per variant.
--
-- Separate from stone setting on purpose. Setting charges are per-stone or
-- fixed and live in cost_component; this is the grams-based fabrication rate.
-- Folded together, a heavy plain band and a light multi-stone piece would be
-- indistinguishable in the cost breakdown.

CREATE TYPE "labor_source" AS ENUM ('india', 'china', 'usa');

CREATE TABLE "labor_rate" (
    "id" UUID NOT NULL,
    "source" "labor_source" NOT NULL,
    "rate_per_gram" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "entered_by" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labor_rate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "labor_rate_source_effective_from_key"
  ON "labor_rate"("source", "effective_from");
CREATE INDEX "labor_rate_source_effective_from_idx"
  ON "labor_rate"("source", "effective_from");

-- A negative rate is not a labour cost, and a zero rate is a real choice
-- (in-house work absorbed elsewhere) so it stays permitted.
ALTER TABLE "labor_rate"
  ADD CONSTRAINT "labor_rate_non_negative" CHECK (rate_per_gram >= 0);

-- Append-only, like every other L1 cost input: a price calculated last month
-- must stay reproducible from the rate that applied then.
CREATE TRIGGER labor_rate_no_update
    BEFORE UPDATE ON "labor_rate"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER labor_rate_no_delete
    BEFORE DELETE ON "labor_rate"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- Exactly one source per variant. Added with a DEFAULT so the existing seeded
-- variants get a value, then the default is DROPPED: a new variant must state
-- where it is manufactured rather than silently inheriting India.
ALTER TABLE "master_variant"
  ADD COLUMN "labor_source" "labor_source" NOT NULL DEFAULT 'india';

ALTER TABLE "master_variant"
  ALTER COLUMN "labor_source" DROP DEFAULT;

COMMENT ON COLUMN "master_variant"."labor_source" IS
  'Where this item is manufactured. The RATE is resolved effective-dated at calculation time and snapshotted with the calculation; only the choice of source lives here.';
