-- Set Your Own Stone — tables, foreign key and indexes.
--
-- Separate from the enum migration so the types above are committed before
-- anything references them.

-- ---------------------------------------------------------------------------
-- ready_setting_compatibility
--
-- The SYSTEM OF RECORD for ready-mount fit metadata (§5). Deliberately in the
-- application database rather than in Shopify metafields: §11 requires
-- matching to be deterministic server-side logic with "no client-only trust
-- boundary", and a metafield is cheap to read exactly where the customer can
-- edit it. A carat.sys_eligible variant metafield mirrors eligibility for PDP
-- badges and decides nothing — the same split CLAUDE.md already mandates for
-- Bank Payment Discount Eligible and for Luxury Steals.
--
-- MUTABLE CONFIGURATION, NOT EVIDENCE. Staff correct a mistyped nominal size
-- and should be able to. What must never be quietly adjusted is the verdict a
-- customer was actually shown, which is why stone_session snapshots its own
-- result instead of recomputing from this table.
--
-- Dimensions are INTEGER MICROMETRES. 10.12mm is 10120. §11 asks for no
-- floating-point surprises in dimension comparisons, and CLAUDE.md rule 6
-- already forbids float money for the same reason; a 0.01mm comparison earns
-- the same discipline. Nothing here is ever parsed from a product title (§5).
-- ---------------------------------------------------------------------------
CREATE TABLE "ready_setting_compatibility" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),

  -- One row per purchasable configuration. A design offered in several centre
  -- sizes is several variants and several rows, which is how §7 routes a
  -- customer to the right one without making them choose "10 x 7 mm".
  "shopify_variant_gid" TEXT NOT NULL,
  "shopify_product_gid" TEXT NOT NULL,

  "shape" "stone_shape" NOT NULL,

  "nominal_length_um" INTEGER NOT NULL,
  "nominal_width_um"  INTEGER NOT NULL,
  "nominal_depth_um"  INTEGER,

  -- An explicit manufacturer-accepted range (§6.2). ALL FOUR OR NONE — a
  -- half-specified range is not a range, and completing it by guesswork would
  -- be inventing the tolerance §6.2 forbids. The CHECK below makes that a
  -- database fact rather than an application convention, and the matching
  -- service ignores a partial range regardless.
  "min_length_um" INTEGER,
  "max_length_um" INTEGER,
  "min_width_um"  INTEGER,
  "max_width_um"  INTEGER,

  -- Where the range came from. Recorded because "the manufacturer said so" is
  -- the entire reason a vendor range outranks our own nominal bookkeeping.
  "vendor_range_source" TEXT,

  "eligible_for_set_your_own_stone" BOOLEAN NOT NULL DEFAULT false,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "ready_setting_compatibility_pkey" PRIMARY KEY ("id"),

  -- Positive, and bounded well above any real centre stone, so a unit mix-up
  -- (millimetres entered where micrometres belong) fails loudly at write time
  -- instead of silently matching nothing forever.
  CONSTRAINT "ready_setting_nominal_positive" CHECK (
    "nominal_length_um" > 0 AND "nominal_length_um" < 100000 AND
    "nominal_width_um"  > 0 AND "nominal_width_um"  < 100000 AND
    ("nominal_depth_um" IS NULL OR ("nominal_depth_um" > 0 AND "nominal_depth_um" < 100000))
  ),

  -- All four range bounds, or none at all.
  CONSTRAINT "ready_setting_range_all_or_none" CHECK (
    ("min_length_um" IS NULL AND "max_length_um" IS NULL AND
     "min_width_um"  IS NULL AND "max_width_um"  IS NULL)
    OR
    ("min_length_um" IS NOT NULL AND "max_length_um" IS NOT NULL AND
     "min_width_um"  IS NOT NULL AND "max_width_um"  IS NOT NULL)
  ),

  -- A range whose minimum exceeds its maximum matches nothing and is a typo.
  CONSTRAINT "ready_setting_range_ordered" CHECK (
    "min_length_um" IS NULL OR
    ("min_length_um" <= "max_length_um" AND "min_width_um" <= "max_width_um")
  )
);

CREATE UNIQUE INDEX "ready_setting_compatibility_shopify_variant_gid_key"
  ON "ready_setting_compatibility" ("shopify_variant_gid");

-- The matching query's shape: eligible rows of one shape.
CREATE INDEX "ready_setting_compatibility_shape_eligible_idx"
  ON "ready_setting_compatibility" ("shape", "eligible_for_set_your_own_stone");

-- ---------------------------------------------------------------------------
-- stone_session
--
-- The server-authoritative record of a customer's stone (§10). It exists
-- BEFORE any custom jewelry project, because the customer describes the stone
-- before choosing between a ready setting and custom, and may never reach
-- Custom Jewelry at all. §10 forbids relying on query parameters or
-- localStorage for authoritative data.
--
-- Mutable by design: the customer corrects a measurement or changes setting.
-- ---------------------------------------------------------------------------
CREATE TABLE "stone_session" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),

  -- Customer-facing, e.g. "SYS-7Q2MPX4N". Generated with a collision retry in
  -- the repository, exactly like custom_jewelry_project.project_reference, and
  -- unambiguous enough to read aloud to support.
  "session_reference" TEXT NOT NULL,

  -- The authenticated Shopify customer when there is one. Written from the App
  -- Proxy's SIGNED logged_in_customer_id only, never from the request body —
  -- the same rule custom jewelry intake follows.
  "customer_ref" TEXT,

  "stone_type" "stone_type" NOT NULL,
  "shape"      "stone_shape" NOT NULL,

  -- DISPLAY AND STAFF REVIEW ONLY. Never an input to compatibility (§4,
  -- §15.5). Numeric rather than float because it is a figure the customer
  -- reads off a certificate and we echo back verbatim.
  "carat_weight" DECIMAL(8,3) NOT NULL,

  "length_um" INTEGER NOT NULL,
  "width_um"  INTEGER NOT NULL,
  "depth_um"  INTEGER,

  "cert_lab"    TEXT,
  "cert_number" TEXT,

  -- Loose, or still set in something. Captured because it changes what staff
  -- ask next, not because it affects matching.
  "is_currently_mounted" BOOLEAN NOT NULL DEFAULT false,

  "notes" TEXT,

  -- The ready setting chosen, or last viewed. Kept after a handoff into Custom
  -- Jewelry, where §9.3 wants it preserved as design inspiration.
  "selected_variant_gid" TEXT,
  "selected_product_gid" TEXT,
  "selected_options"     JSONB,

  -- A SNAPSHOT of the verdict the customer was shown, with the rule that
  -- produced it. Not recomputed on read: the compatibility config above is
  -- mutable, and what matters in a later conversation is what the customer
  -- actually saw at the time.
  "compatibility_status" "stone_compatibility_status",
  "compatibility_rule"   "stone_compatibility_rule",

  "status" "stone_session_status" NOT NULL DEFAULT 'open',

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "stone_session_pkey" PRIMARY KEY ("id"),

  -- Same unit sanity check as the settings table.
  CONSTRAINT "stone_session_dimensions_positive" CHECK (
    "length_um" > 0 AND "length_um" < 100000 AND
    "width_um"  > 0 AND "width_um"  < 100000 AND
    ("depth_um" IS NULL OR ("depth_um" > 0 AND "depth_um" < 100000))
  ),

  CONSTRAINT "stone_session_carat_positive" CHECK ("carat_weight" > 0)
);

CREATE UNIQUE INDEX "stone_session_session_reference_key"
  ON "stone_session" ("session_reference");

CREATE INDEX "stone_session_customer_ref_idx" ON "stone_session" ("customer_ref");
CREATE INDEX "stone_session_status_idx" ON "stone_session" ("status");

-- ---------------------------------------------------------------------------
-- stone_session_upload
--
-- A grading report or certificate (§4). Its own table rather than a new kind
-- on custom_jewelry_project_upload, because an upload must be able to belong
-- to a session that may never become a project.
--
-- This duplicates NO upload infrastructure: the presigned destination flow and
-- upload_destination table are the shared ones, consumed through the same
-- repository. §9.4 forbids a parallel upload system and this is not one — only
-- the ownership row differs.
-- ---------------------------------------------------------------------------
CREATE TABLE "stone_session_upload" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" UUID NOT NULL,

  "kind"         "warranty_claim_upload_kind" NOT NULL,
  "storage_key"  TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size_bytes"   BIGINT NOT NULL,
  "checksum"     TEXT NOT NULL,

  "uploaded_by_actor_type" "actor_type" NOT NULL,
  "uploaded_by_actor_ref"  TEXT,
  "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stone_session_upload_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stone_session_upload_session_id_idx" ON "stone_session_upload" ("session_id");

ALTER TABLE "stone_session_upload"
  ADD CONSTRAINT "stone_session_upload_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "stone_session"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- custom_jewelry_project.stone_session_id
--
-- The handoff (§9.2). A LINK, NOT A COPY: the stone's attributes stay on
-- stone_session, which is their single source of truth, because §10 asks not
-- to duplicate the same stone fields across tables.
--
-- NULLABLE, and almost always null — the overwhelming majority of projects
-- involve no customer-supplied stone. Existing rows are unaffected, which is
-- what makes this additive rather than breaking.
-- ---------------------------------------------------------------------------
ALTER TABLE "custom_jewelry_project" ADD COLUMN "stone_session_id" UUID;

CREATE INDEX "custom_jewelry_project_stone_session_id_idx"
  ON "custom_jewelry_project" ("stone_session_id");

ALTER TABLE "custom_jewelry_project"
  ADD CONSTRAINT "custom_jewelry_project_stone_session_id_fkey"
  FOREIGN KEY ("stone_session_id") REFERENCES "stone_session"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
