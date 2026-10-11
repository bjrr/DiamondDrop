-- Slice 10 — persist the submission INSTANT and the timezone its calendar date
-- was derived in.
--
-- HAND-AUTHORED, same escalation path as its siblings.
--
-- ============================================================================
-- WHY THE ZONE IS STORED AND NOT ASSUMED
-- ============================================================================
-- `submitted_on` is a business-calendar DATE, and which calendar it belongs to
-- is a business fact: it decides whether a quote submitted late in the evening
-- counts as today or tomorrow, and therefore whether a customer receives a
-- guaranteed match-or-beat plus a $100 benefit or a discretionary review.
--
-- Storing only the date leaves a later reader to assume TODAY'S store timezone
-- applied. If the store's configured timezone ever changes, every historical
-- submission would be silently reinterpreted under the new one, and a boundary
-- case decided correctly in 2026 could read as decided wrongly in 2027.
--
-- So three facts are kept, and each answers a different question:
--   submitted_at    the instant, in UTC — ordering, audit, and the one value
--                   that is true regardless of anybody's calendar
--   submitted_on    the business-calendar date the 7-day rule was applied to
--   calendar_zone   WHICH calendar that was, so the derivation is reproducible
--
-- ============================================================================
-- ADDITIVE, BACKFILLED, THEN CONSTRAINED — and the backfill is self-verifying
-- ============================================================================
-- `beat_quote_submission` is introduced by migration 20261010010000, which has
-- not reached production, so production has no rows to backfill. The local and
-- disposable integration databases DO have rows from test runs. Rather than
-- rely on knowing which is which, the columns are added nullable, backfilled,
-- checked, and only then made NOT NULL — the same discipline the upload
-- destination expand/contract used, for the same reason: a migration that
-- assumes an empty table is a migration that fails the first time it is wrong.
--
-- `created_at` is the honest source for `submitted_at` on an existing row: it
-- IS the instant the submission was recorded. The zone backfill uses the
-- store's configured timezone at the time of writing, recorded explicitly below
-- rather than left implicit, because an existing row genuinely was judged under
-- it.

ALTER TABLE "beat_quote_submission" ADD COLUMN "submitted_at" TIMESTAMPTZ(6);
ALTER TABLE "beat_quote_submission" ADD COLUMN "calendar_zone" TEXT;

UPDATE "beat_quote_submission"
   SET "submitted_at" = COALESCE("submitted_at", "created_at"),
       -- The store's configured ianaTimezone, verified against Shopify on
       -- 2026-10-10 (shop.ianaTimezone = 'America/New_York'). Written as a
       -- literal because that is what these rows were actually judged under;
       -- new rows carry whatever the store is configured with at the time.
       "calendar_zone" = COALESCE("calendar_zone", 'America/New_York')
 WHERE "submitted_at" IS NULL OR "calendar_zone" IS NULL;

DO $$
DECLARE unbackfilled bigint;
BEGIN
    SELECT count(*) INTO unbackfilled
      FROM "beat_quote_submission"
     WHERE "submitted_at" IS NULL OR "calendar_zone" IS NULL;

    IF unbackfilled > 0 THEN
        RAISE EXCEPTION
          'backfill incomplete: % beat_quote_submission row(s) still have a NULL submitted_at or '
          'calendar_zone. Investigate before constraining — a submission whose calendar is unknown '
          'cannot have its eligibility reproduced.',
          unbackfilled;
    END IF;
END $$;

ALTER TABLE "beat_quote_submission" ALTER COLUMN "submitted_at" SET NOT NULL;
ALTER TABLE "beat_quote_submission" ALTER COLUMN "calendar_zone" SET NOT NULL;

-- An IANA identifier, not an abbreviation and not an offset. 'EDT' and '-04:00'
-- are both ambiguous across the year; 'America/New_York' is not, which is the
-- whole reason the derivation is reproducible.
ALTER TABLE "beat_quote_submission"
  ADD CONSTRAINT "beat_quote_submission_calendar_zone_is_iana" CHECK (
    "calendar_zone" ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$'
  );

COMMENT ON COLUMN "beat_quote_submission"."submitted_at" IS
  'The submission instant in UTC. True regardless of anybody''s calendar; use for ordering and audit.';
COMMENT ON COLUMN "beat_quote_submission"."submitted_on" IS
  'The BUSINESS-CALENDAR date the 7-day rule was applied to, derived in calendar_zone. Frozen.';
COMMENT ON COLUMN "beat_quote_submission"."calendar_zone" IS
  'The IANA zone submitted_on was derived in, stored so a future store-timezone change cannot '
  'reinterpret historical eligibility. Resolved from Shopify shop.ianaTimezone, never hard-coded.';
