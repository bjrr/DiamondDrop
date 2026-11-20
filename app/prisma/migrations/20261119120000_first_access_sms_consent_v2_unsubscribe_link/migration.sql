-- First Access SMS marketing consent, VERSION 2 (owner decision 2026-11-19).
--
-- ============================================================================
-- WHY A NEW VERSION, AND WHY ONLY THE SMS SLUG
-- ============================================================================
-- Version 1 told the customer "Reply STOP to unsubscribe". CaratForUs sends
-- through Shopify Messaging on Shopify's US/Canada toll-free sender, which is
-- DELIVERY-ONLY and cannot receive inbound messages. A customer replying STOP
-- to it would have been following our own written instruction into a dead end:
-- they would believe they had opted out while Shopify still had them
-- SUBSCRIBED. An unsubscribe instruction that silently fails is worse than no
-- instruction, because the customer stops looking for the real one.
--
-- Shopify Messaging appends its own unsubscribe URL to marketing messages, so
-- version 2 names the opt-out that actually exists. CaratForUs deliberately
-- does NOT build its own unsubscribe link — Shopify's is what mutates
-- `smsMarketingConsent`, and a parallel mechanism would reproduce the same
-- defect in a different place.
--
-- The EMAIL slug is untouched and stays at version 1. Its wording did not
-- change, and inserting an identical version 2 would leave an auditor with two
-- versions carrying the same words and no way to tell which a customer saw.
-- This is the case the two-slug design in migration 20261118160000 was for.
--
-- ============================================================================
-- VERSION 1 IS LEFT EXACTLY AS IT WAS
-- ============================================================================
-- `policy_version` is append-only by trigger (migration 20260913000100), and
-- that is the point rather than an obstacle: an `acknowledgment` row points at
-- the version it was shown under, so version 1 must keep saying "Reply STOP"
-- for as long as any record points at it. Rewriting it would retroactively
-- change what a subscriber is recorded as having agreed to.
--
-- As of this migration the production store holds ONE First Access customer,
-- and they have no SMS consent at all (verified against the live shop, not
-- assumed). So no live SMS consent rests on the withdrawn wording, and no
-- re-consent of existing subscribers is required.
--
-- ============================================================================
-- text and content_hash are byte-identical to
-- `app/app/domain/firstaccess/marketingConsentCopy.ts`'s
-- FIRST_ACCESS_SMS_CONSENT_TEXT, which is itself pinned against the THEME
-- LOCALE FILE by `marketingConsentCopy.test.ts` — so the string stored as
-- evidence is the string the customer actually read. Plain sha256 of that exact
-- string (NOT canonical-JSON hashed; see `requiredPolicyVersions.ts`),
-- computed from the module's own declaration rather than a retyped copy.

INSERT INTO "policy_version" ("id", "slug", "version", "effective_from", "text", "content_hash", "created_at")
VALUES (
  gen_random_uuid(),
  'first-access-sms-marketing-consent',
  2,
  '2026-11-19T00:00:00.000Z',
  'Text me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions. Message frequency varies. Msg & data rates may apply. You can unsubscribe at any time using the unsubscribe link included in our texts.',
  'ad7b16d59e7107adff2953b0bc0c96e2c3c5d8222a9c766efda66de45955645e',
  now()
)
ON CONFLICT ("slug", "version") DO NOTHING;
