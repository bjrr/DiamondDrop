-- "Let Us Beat Your Quote!" AUTHENTICITY acknowledgment, VERSION 2
-- (owner decision 2026-11-25).
--
-- ============================================================================
-- WHY A NEW VERSION, AND WHY ONLY THIS SLUG
-- ============================================================================
-- Version 1 read:
--
--   "I confirm the quote, listing, CAD, specifications, images, and seller
--   information I submitted are authentic and have not been altered,
--   fabricated, or AI-generated. I understand CaratForUs may request
--   additional documentation or independently verify the seller, offer,
--   specifications, and price."
--
-- The approved replacement makes the certification an explicit representation
-- CaratForUs is being asked to rely on, covers AI EDITING as well as AI
-- generation, and states what follows from submitting false or altered
-- information. On a program whose whole purpose is to price against a
-- competitor's paperwork, that is the term the evidence rests on.
--
-- The storefront checkbox was changed first, directly in Shopify, on both
-- themes. On LAUNCH 188329197786 the change is in the theme's current files,
-- verified by pulling `locales/en.default.json` back out of it: it matches the
-- string below byte for byte. On the live COMING SOON theme 188329230554 it is
-- a committed theme version waiting to be published, so Shopify keeps serving
-- the published version and both the storefront and `theme pull` still show
-- version 1's sentence. That is a publish, not a missing edit, and it happens
-- separately from this migration.
--
-- Until this row exists the app and the themes disagree: the customer ticks one
-- sentence while `apps.carat.beat-quote-submission` records acceptance of the
-- app's wording, and the policy-terms section on the page (served from
-- /apps/carat/policies?group=quote-match) quotes the old sentence under
-- "Proving a competitor quote is genuine". This migration is what closes that
-- gap on the app's side.
--
-- THE THREE SIDES SWITCH TOGETHER AT LAUNCH, by owner decision: merge, then
-- publish the live theme and `fly deploy` back to back, so the checkbox, the
-- quoted term and the recorded evidence all move to version 2 at once. Shipping
-- this migration alone would invert the mismatch rather than fix it, with the
-- customer still ticking version 1 while evidence recorded version 2.
--
-- THE OTHER FIVE SLUGS ARE UNTOUCHED and stay at version 1. Their wording did
-- not change, and inserting an identical version 2 of each would leave an
-- auditor with two rows carrying the same words and no way to tell which one a
-- customer saw. Same reasoning migration 20261119120000 applied when it bumped
-- the SMS consent slug and left the email slug alone.
--
-- ============================================================================
-- VERSION 1 IS LEFT EXACTLY AS IT WAS
-- ============================================================================
-- `policy_version` is append-only by trigger (migration 20260913000100), and
-- that is the point rather than an obstacle: an `acknowledgment` row points at
-- the version it was shown under, so version 1 must keep its original words for
-- as long as any record points at it. Editing it in place would retroactively
-- change what an earlier submitter is recorded as having certified, which is
-- precisely the claim this acknowledgment exists to be able to prove.
--
-- `apps.carat.beat-quote-submission` and `apps.carat.policies` both resolve this
-- slug through `getLatestPolicyVersion`, so version 2 becomes the served and
-- recorded wording the moment this migration applies. No code chooses a version
-- by number.
--
-- ============================================================================
-- text and content_hash are byte-identical to
-- `app/app/domain/beatyourquote/acknowledgmentText.ts`'s
-- BEAT_QUOTE_AUTHENTICITY_TEXT, pinned character for character by
-- `acknowledgmentText.test.ts`, pinned against the theme locale file by
-- `beatQuoteAcknowledgmentParity.test.ts`, and asserted against this file by
-- `requiredPolicyVersionsMigrationFence.test.ts`. The hash is plain sha256 of
-- that exact 583-character string (NOT canonical-JSON hashed; see
-- `requiredPolicyVersions.ts`'s header for why that distinction matters),
-- computed from the module's own declaration and from the string pulled back
-- out of the LAUNCH theme, which agree byte for byte.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-authenticity',
  2,
  '2026-11-25T00:00:00.000Z',
  'I certify, as a formal representation made to induce CaratForUs to rely on it, that the quote, listing, CAD, specifications, images, and seller information I have submitted are true, complete, and authentic, and have not been altered, fabricated, or generated or edited by AI. I understand that knowingly submitting false or altered information may result in cancellation of any resulting price, order, or benefit, and may expose me to legal liability. I understand CaratForUs may request additional documentation or independently verify the seller, offer, specifications, and price.',
  'c29e6d7794300833c63d9fbfe1c770094715732f42c84fb5ceafe887d167849a',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
