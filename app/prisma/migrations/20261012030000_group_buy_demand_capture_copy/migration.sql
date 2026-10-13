-- Group Buy demand capture disclosures (owner decision 2026-10-12).
--
-- Resolves STOREFRONT-COPY-PROPOSAL.md §1.7, which placed "Bring It Back" in
-- locked MVP1 scope but deferred the wording to Slice 13 and deliberately
-- drafted none. Drafts and reasoning:
-- docs/specs/SLICE-13-DEMAND-CAPTURE-COPY-PROPOSAL.md.
--
-- ============================================================================
-- THE SUBMIT BUTTON IS THE AFFIRMATIVE ACTION — THERE IS NO TICKBOX
-- ============================================================================
-- Owner decision, not a simplification. README requires low-friction interest
-- capture and a tickbox is a step. The evidence is unaffected: each
-- acknowledgment records the exact disclosure below AND the exact button
-- caption pressed (`BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL` /
-- `NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL`, which live in
-- app/domain/groupbuy/demandCaptureCopy.ts because `policy_version` has no
-- column for a button caption).
--
-- ============================================================================
-- WHAT THIS COPY REFUSES TO PROMISE
-- ============================================================================
-- That a campaign will return, when, or at what price.
--
-- That matters more now than it would have a week ago: the public Past Group
-- Buys archive shipped in this same slice and states each closed campaign's
-- final price plainly. "It'll come back at that price" is therefore the
-- misunderstanding most available to a reader, and the first disclosure is
-- written to head it off — a new campaign is priced from costs at the time it
-- opens, and a past campaign's price was frozen against costs that have since
-- moved.
--
-- "once" is a promise the system can keep: `markGroupBuyDemandSignalsNotified`
-- only ever sets the flag, so a notified signal is never re-selected.
--
-- ============================================================================
-- APPEND-ONLY, LIKE EVERY OTHER POLICY VERSION
-- ============================================================================
-- `policy_version` carries BEFORE UPDATE/DELETE triggers (migration
-- 20260913000100), so a later revision is a NEW version rather than an edit —
-- an acknowledgment points at the version it was shown under, and rewriting
-- that row would change what existing evidence claims a customer was told.
--
-- ON CONFLICT DO NOTHING so a re-run is a no-op rather than a failed deploy.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'group-buy-bring-it-back-notification',
  1,
  '2026-01-01T00:00:00.000Z',
  'We''ll email you once if this Group Buy runs again. We can''t promise it will, or what the price will be — a new campaign is priced from costs at the time it opens. We use your email for this notice only, and you can ask us to remove it at any time.',
  '7417b843055f803aaaf6194dd3b1cc08b20c23a67b629e625eced7a70a06b359',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'group-buy-new-campaign-request',
  1,
  '2026-01-01T00:00:00.000Z',
  'Tell us what you''d like to see run as a Group Buy. We read every request, but we can''t promise to run any particular one, and we''ll only email you about this request. If you want a one-off piece made for you, start a Custom Jewelry request instead — that''s a different process.',
  'f7d93b9a8efafd5be129a5ed4a3f5b370b4f93b7267d911fb898ea491335f84e',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
