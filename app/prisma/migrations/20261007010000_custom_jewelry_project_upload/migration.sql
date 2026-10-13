-- Inspiration upload records for Custom Jewelry enquiries (Slice 9).
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- METADATA ONLY. The bytes live in private R2; this table records what was
-- uploaded and where, exactly as `warranty_claim_upload` does. Nothing here
-- stores or proxies file content.
--
-- A SEPARATE TABLE FROM warranty_claim_upload, DELIBERATELY. The owner's
-- one-implementation mandate concerned the DESTINATION service — the security
-- properties, which now have exactly one implementation. These record tables
-- are plain per-entity data with different foreign keys and different
-- readers; merging them would mean a nullable FK per flow plus a
-- discriminator deciding which is valid, which is more fragile than two
-- honest tables rather than less.
--
-- APPEND-ONLY IS NOT APPLIED HERE, and that is a considered difference from
-- warranty evidence. A warranty upload is dispute evidence about a claim. An
-- inspiration image is a customer's reference material for a conversation
-- that has not happened yet — a customer who attaches the wrong photo should
-- be able to have it removed, and MVP1 consultation is email-driven, so that
-- request will arrive by email. If Custom Jewelry evidence later becomes
-- dispute-relevant (the APPROVED design images at purchase certainly will),
-- that surface gets its own append-only table rather than this one being
-- retrofitted.

CREATE TABLE "custom_jewelry_project_upload" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,

    "kind" "warranty_claim_upload_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,

    "uploaded_by_actor_type" "actor_type" NOT NULL,
    "uploaded_by_actor_ref" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_jewelry_project_upload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "custom_jewelry_project_upload_project_id_idx"
    ON "custom_jewelry_project_upload"("project_id");

ALTER TABLE "custom_jewelry_project_upload"
  ADD CONSTRAINT "custom_jewelry_project_upload_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "custom_jewelry_project"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A declared size must be a real size. Zero bytes is not a photograph, and a
-- negative one is not anything — both are signals that the metadata was
-- assembled rather than observed.
ALTER TABLE "custom_jewelry_project_upload"
  ADD CONSTRAINT "custom_jewelry_project_upload_size_positive" CHECK ("size_bytes" > 0);
