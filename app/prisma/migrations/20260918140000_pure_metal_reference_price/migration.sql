-- Metal costing moves to a PURE reference price per metal, with the alloyed
-- price derived as pure x fineness x grams.
--
-- WHY THE OLD TABLE IS DROPPED RATHER THAN REINTERPRETED. Every row in
-- metal_price means "price per gram of this KARAT". Keeping the rows and
-- changing what the column means would silently restate history: 14k at
-- $48.25/g would start being read as pure gold at $48.25/g, pricing every 14k
-- piece at 58% of its real metal cost. Reinterpreting append-only data is
-- exactly the failure this codebase guards against everywhere else, so the old
-- table goes and the new one starts clean.
--
-- Safe to drop: nothing references metal_price by foreign key, and stored
-- price_calculation rows remain reproducible because each one carries its
-- resolved inputs in its snapshot rather than a pointer to this table.

DROP TABLE IF EXISTS "metal_price";

CREATE TABLE "metal_reference_price" (
    "id" UUID NOT NULL,
    "metal" "metal" NOT NULL,
    "price_per_gram" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "source" "price_sync_intent_status" NOT NULL,
    "entered_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metal_reference_price_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metal_reference_price_metal_effective_from_key"
  ON "metal_reference_price"("metal", "effective_from");
CREATE INDEX "metal_reference_price_metal_effective_from_idx"
  ON "metal_reference_price"("metal", "effective_from");

-- A metal cannot cost nothing, and a negative price is not a price. Strictly
-- positive, unlike the labour rate where zero is a legitimate choice.
ALTER TABLE "metal_reference_price"
  ADD CONSTRAINT "metal_reference_price_positive" CHECK (price_per_gram > 0);

-- Append-only, like every other L1 cost input: a price calculated last month
-- must stay reproducible from the reference that applied then.
CREATE TRIGGER metal_reference_price_no_update
    BEFORE UPDATE ON "metal_reference_price"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER metal_reference_price_no_delete
    BEFORE DELETE ON "metal_reference_price"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

COMMENT ON COLUMN "metal_reference_price"."price_per_gram" IS
  'PURE metal, major units per gram. The alloyed price is derived as pure x fineness (see app/domain/pricing/purity.ts); do not store per-karat prices here.';
