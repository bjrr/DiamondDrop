-- Slice 10 — the "Let Us Beat Your Quote!" acknowledgment POLICY VERSIONS.
--
-- WHY A MIGRATION AND NOT A SEED — mirroring
-- `20261008020000_custom_jewelry_deposit_policy_version` and its predecessors.
-- Reference data the application REQUIRES in order to function is schema, not
-- fixtures: `fly.toml`'s release_command runs `prisma migrate deploy` only, and
-- `prisma/seed.ts` runs on developer machines and in the disposable integration
-- database and nowhere else.
--
-- THIS EXACT GAP CAUSED A PRODUCTION OUTAGE ONCE. The Luxury Steals
-- acknowledgment endpoint returned HTTP 500 `policy_unavailable` on its first
-- real production request because its policy_version row existed only in the
-- seed script. Without the rows below, the Beat Your Quote intake cannot record
-- the required acknowledgments for ANY submission and must refuse — so they are
-- provisioned here, registered in `requiredPolicyVersions.ts`, and therefore
-- surfaced by `/health` the moment a deploy finishes rather than at the first
-- customer request.
--
-- SIX ROWS, NOT FIVE. The original specification defines acknowledgments 1, 2,
-- 3A, 3B and 3C — and NO acknowledgment for an active online listing, because
-- in that document a live listing was guarantee-eligible and therefore took 3A.
-- Amendment §1 moved online listings to review-only and supplied their own
-- wording and required action with it. Provisioning only the original five
-- would leave an online listing to take 3A, which promises exactly the
-- guarantee the amendment withdrew.
--
-- Idempotent by the (slug, version) unique constraint. `policy_version` is
-- append-only (BEFORE UPDATE/DELETE triggers from migration 20260913000100),
-- so this is INSERT-only by design: a future approved wording change creates
-- version 2 and never edits version 1. That is the whole point — an
-- acknowledgment row references the version it was shown under, so editing
-- version 1's text would retroactively change what existing evidence claims
-- the customer agreed to.
--
-- Every text and content_hash below is byte-identical to
-- `app/app/domain/beatyourquote/acknowledgmentText.ts`, itself pinned character
-- for character by `acknowledgmentText.test.ts` and asserted against this
-- migration by `requiredPolicyVersionsMigrationFence.test.ts`. The hashes are
-- plain sha256 of each exact string — NOT canonical-JSON hashed; see
-- `requiredPolicyVersions.ts`'s header for why that distinction matters and
-- what it cost to discover.

-- ONE INSERT PER ROW, NOT A SIX-ROW VALUES LIST. The drift fence
-- (requiredPolicyVersionsMigrationFence.test.ts) parses one
-- INSERT ... VALUES (...) per statement, which is how every existing policy
-- migration is written. A multi-row list parsed as a single row and made five
-- of these six look unprovisioned — the fence caught it, which is what it is
-- for. Split to match the convention rather than teaching the fence a new
-- shape for one file.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-what-we-match',
  1,
  '2026-01-01T00:00:00.000Z',
  'I understand CaratForUs is matching or beating the price of the jewelry itself based on materially comparable design and specifications. CaratForUs is not required to match the competing seller''s production timeline, return policy, warranty, shipping terms, payment terms, promotions, or other services.',
  '9b33fe99649c6e586a9b26dc58e566b5f2914d5d7ac30ec36202d4b19b64abfb',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-authenticity',
  1,
  '2026-01-01T00:00:00.000Z',
  'I confirm the quote, listing, CAD, specifications, images, and seller information I submitted are authentic and have not been altered, fabricated, or AI-generated. I understand CaratForUs may request additional documentation or independently verify the seller, offer, specifications, and price.',
  '6ab97b875ed813d33baf3cae69ab406057e814084dd67d7b8450e079773c2220',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-recent-quote-guarantee',
  1,
  '2026-01-01T00:00:00.000Z',
  'I understand that only verified custom quotes issued within the last 7 calendar days qualify for the guaranteed match-or-beat offer and the 10%-off fallback benefit.',
  '9d26c4e59cb67f91c934cf1306727d91c8c76c4ba533345946a83962ca8778ea',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-older-quote-review',
  1,
  '2026-01-01T00:00:00.000Z',
  'This quote is more than 7 days old. CaratForUs will still review it and may offer a competitive price, but there is no guarantee that CaratForUs will match or beat it and the 10%-off fallback does not apply.',
  '4e4fa429dabd6cc7b8399cace67f1693d98f56ad734ab2a558fb63502b7d017b',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-group-buy-review',
  1,
  '2026-01-01T00:00:00.000Z',
  'I understand CaratForUs may review this Group Buy and may choose to match or beat it, but there is no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot match or beat the price.',
  'c0da91408563d0a12d92d67e800cfc9ad096c6e589b487ae9eec524bb3b42c5b',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'beat-quote-online-listing-review',
  1,
  '2026-01-01T00:00:00.000Z',
  'I understand CaratForUs will review this online offer and may choose to match or beat it, but there is no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot or chooses not to match or beat the price.',
  'c4730ab42db00e435aca4f770499f2ca198a4dbab2ee839828dafbfd2fc89f59',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
