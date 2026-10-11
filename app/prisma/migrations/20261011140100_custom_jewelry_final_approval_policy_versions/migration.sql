-- Custom Jewelry FINAL APPROVAL policy versions (owner workstream 2026-10-11).
--
-- WHY THIS IS A MIGRATION AND NOT A SEED — mirroring
-- `20261008020000_custom_jewelry_deposit_policy_version` exactly, and for the
-- same reason it states: reference data the application REQUIRES in order to
-- function is schema, not fixtures. `fly.toml`'s release command runs
-- `prisma migrate deploy` and nothing else, so a row that lives only in
-- `prisma/seed.ts` does not exist in production.
--
-- THAT EXACT GAP CAUSED A PRODUCTION OUTAGE ONCE. The Luxury Steals
-- acknowledgment endpoint returned HTTP 500 on its first real production
-- request because its policy_version row was seed-only. Without the rows
-- below, a Custom Jewelry final approval cannot be recorded for ANY customer
-- and the route must refuse — so they are provisioned here and surfaced by
-- `/health`'s readiness check the moment a deploy finishes, rather than at the
-- first customer click.
--
-- Idempotent by the (slug, version) unique constraint. `policy_version` is
-- append-only, so this is INSERT-only by design: an approved wording change
-- creates version 2 and never edits version 1. That is the point — an
-- acknowledgment row references the version it was shown under, so editing
-- version 1 would retroactively change what existing evidence claims the
-- customer agreed to.
--
-- ============================================================================
-- TWO ROWS, BECAUSE THEY ARE TWO DECISIONS
-- ============================================================================
-- The owner requires the approval package to preserve a "warranty/final-sale
-- copy version" AND an "approval acknowledgment text/version" as separate
-- items. They genuinely move independently: the final-sale term could be
-- revised without changing what the customer certifies, and vice versa. One
-- row covering both would make either change look like the other.
--
-- ============================================================================
-- PROVENANCE — AND WHAT IS STILL THE OWNER'S TO CONFIRM
-- ============================================================================
-- The final-sale text is `README.md`'s own sentence, recast only from "the
-- Custom Jewelry order" to "your order".
--
-- The acknowledgment's SUBSTANCE is the owner's enumeration of what it must
-- establish — design, specifications, materials, dimensions/size, engraving,
-- final price, deposit credit, final-sale treatment — plus the README's
-- final-sale sentence. The FIRST-PERSON RENDERING is mine, exactly as it was
-- for the Design Deposit, whose own migration and copy module carry the same
-- flag. FLAGGED FOR AN OWNER CONFIRMATION PASS: if different words are wanted,
-- that is a version 2 row here plus a constant bump in the copy module, and a
-- visible diff either way.
--
-- text and content_hash below are byte-identical to
-- `app/app/domain/customjewelry/finalApprovalCopy.ts`, itself pinned
-- character-for-character by `finalApprovalCopy.test.ts`. The hash is plain
-- sha256 of that exact string — NOT canonical-JSON hashed; see
-- `requiredPolicyVersions.ts`'s header for why that distinction matters and
-- what it cost to discover.

-- One INSERT per statement: the drift fence parses a single INSERT per
-- statement, and a multi-row VALUES list reads to it as unprovisioned.
INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'custom-jewelry-final-approval',
  1,
  '2026-01-01T00:00:00.000Z',
  'I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and engraving where applicable, exactly as displayed on this page. I approve the final price shown and the credit of my $49 Design Deposit against it, and I understand I am paying the remaining balance. I understand that once my final design and specifications are approved and the jewelry is purchased, my order is final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the approved design and specifications.',
  'b0a8b1a797edcbf2c37dff0f76330903c6e6f68c1a2bf5276b717dd5044593f4',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'custom-jewelry-final-sale',
  1,
  '2026-01-01T00:00:00.000Z',
  'Once your final design and specifications are approved and the jewelry is purchased, your Custom Jewelry order is final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the approved design and specifications.',
  '5c63aed1f2a1abbe06e9f30581b27d1d60750d8450a4c12a2ea8f01e9f729a15',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
