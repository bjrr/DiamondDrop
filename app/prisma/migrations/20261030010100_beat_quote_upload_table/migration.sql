-- Let Us Beat Your Quote: the customer-supplied quote document.
--
-- The page's whole purpose is the customer handing us the thing they want
-- reviewed. Columns mirror custom_jewelry_project_upload exactly, so there is
-- one upload shape in this codebase rather than three.

CREATE TABLE "beat_quote_upload" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "kind" "warranty_claim_upload_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "uploaded_by_actor_type" "actor_type" NOT NULL,
    "uploaded_by_actor_ref" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beat_quote_upload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "beat_quote_upload_submission_id_idx" ON "beat_quote_upload"("submission_id");

ALTER TABLE "beat_quote_upload"
    ADD CONSTRAINT "beat_quote_upload_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "beat_quote_submission"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- APPEND-ONLY, matching warranty_claim_upload.
--
-- This is evidence. The authenticity acknowledgment a customer signs refers
-- to exactly these files, so a row that could be edited or quietly removed
-- after a decision would undermine the record it exists to support.
--
-- For the privacy inventory: this table holds METADATA and a storage key, not
-- the file. The object lives in R2 and stays deletable, so a valid erasure
-- request can be honoured without fighting these triggers — the same position
-- already recorded for warranty_claim_upload.
CREATE TRIGGER beat_quote_upload_no_update
    BEFORE UPDATE ON "beat_quote_upload"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER beat_quote_upload_no_delete
    BEFORE DELETE ON "beat_quote_upload"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER beat_quote_upload_no_truncate
    BEFORE TRUNCATE ON "beat_quote_upload"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();
