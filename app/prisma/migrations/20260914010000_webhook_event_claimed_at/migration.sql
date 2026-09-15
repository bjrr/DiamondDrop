-- Stale-claim detection for webhook_event (architect review 2026-09-14).
--
-- Without this, a handler that crashes before it can record a failure leaves
-- its row unprocessed with no error set. That state is indistinguishable from
-- "another delivery is legitimately processing this right now", so the
-- receiver refuses to reprocess it — and the event is stuck forever.
--
-- claimed_at is stamped every time a caller successfully claims a delivery.
-- A row that is still unprocessed, has no recorded error, and whose claimed_at
-- is older than the staleness threshold is treated as a crashed attempt and
-- may be reclaimed. Reclaim uses the same atomic conditional-UPDATE pattern as
-- the retry-after-failure claim, so concurrent reclaims cannot both win.

ALTER TABLE "webhook_event" ADD COLUMN "claimed_at" TIMESTAMP(3);

-- Backfill existing rows so stale detection can see them. A NULL claimed_at
-- would never match the `claimed_at < cutoff` predicate, which would silently
-- exempt every pre-migration row from reclaim.
UPDATE "webhook_event" SET "claimed_at" = "received_at" WHERE "claimed_at" IS NULL;

CREATE INDEX "webhook_event_processed_at_claimed_at_idx"
    ON "webhook_event" ("processed_at", "claimed_at");
