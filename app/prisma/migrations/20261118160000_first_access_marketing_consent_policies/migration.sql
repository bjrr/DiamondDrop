-- First Access marketing consent, VERSION 1 for each channel
-- (owner decision 2026-11-18).
--
-- ============================================================================
-- WHAT THESE REPLACE
-- ============================================================================
-- Until this change the Launching Soon form carried a HIDDEN field,
-- `contact[accepts_marketing]` fixed at "true", so every signup was recorded
-- in Shopify as email-marketing SUBSCRIBED without the customer agreeing to
-- anything and with no record of any wording, because none was shown. SMS
-- consent did not exist at all: the mobile number went to a metafield and the
-- form's own comment correctly insisted a phone number is not permission to
-- text.
--
-- Both are now real, separate, unchecked opt-ins, and the sentence each one
-- carries is evidence. These rows are what an acknowledgment points at.
--
-- ============================================================================
-- TWO SLUGS, NOT ONE ROW WITH A CHANNEL COLUMN
-- ============================================================================
-- Email and SMS are independent permissions with independent lifecycles. A
-- customer may hold one and not the other, may withdraw one and keep the
-- other, and in the SMS case may withdraw it by replying STOP to a text that
-- never reaches CaratForUs code at all. Separate slugs let the two be
-- versioned, queried and audited apart.
--
-- The slug also records the SURFACE: "first-access-" names the Launching Soon
-- signup, so a consent collected here stays distinguishable from one collected
-- at checkout or in a customer account later, without a free-text source
-- column that nothing would validate.
--
-- ============================================================================
-- text and content_hash are byte-identical to
-- `app/app/domain/firstaccess/marketingConsentCopy.ts`'s
-- FIRST_ACCESS_EMAIL_CONSENT_TEXT and FIRST_ACCESS_SMS_CONSENT_TEXT, which are
-- themselves pinned against the THEME LOCALE FILE by
-- `marketingConsentCopy.test.ts` — so the string stored as evidence is the
-- string the customer actually read, not a near-copy of it.
--
-- The hashes are plain sha256 of those exact strings (NOT canonical-JSON
-- hashed; see `requiredPolicyVersions.ts` for why that distinction matters),
-- computed FROM the module's own declarations rather than from a retyped copy,
-- because a retyped copy is exactly how the two drift.
--
-- `policy_version` is append-only by trigger (migration 20260913000100), so a
-- later wording change must add version 2 and leave these untouched.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'first-access-email-marketing-consent',
  1,
  '2026-11-18T00:00:00.000Z',
  'Email me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions.',
  '20ad192a9fa0ba82942c8139589a34b5666365cf411b65a1273ded0807f9611d',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'first-access-sms-marketing-consent',
  1,
  '2026-11-18T00:00:00.000Z',
  'Text me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions. Message frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe.',
  '05998b6b166d6b2e68cc1b7a3e967516ad813921429ff6e6e8798e3e55e3490e',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
