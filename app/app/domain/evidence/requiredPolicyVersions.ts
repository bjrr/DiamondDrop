import { sha256Hex } from "./hash";
import { buildPolicyVersionRecord } from "./policyVersion";
import {
  BEAT_QUOTE_AUTHENTICITY_TEXT,
  BEAT_QUOTE_GROUP_BUY_TEXT,
  BEAT_QUOTE_OLDER_QUOTE_TEXT,
  BEAT_QUOTE_ONLINE_LISTING_TEXT,
  BEAT_QUOTE_POLICY_SLUGS,
  BEAT_QUOTE_POLICY_VERSION,
  BEAT_QUOTE_RECENT_QUOTE_TEXT,
  BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
} from "~/domain/beatyourquote/acknowledgmentText";
import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
  CUSTOM_JEWELRY_DEPOSIT_POLICY_VERSION,
} from "~/domain/customjewelry/designDepositAcknowledgmentText";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
import {
  LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
  LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION,
  LUXURY_STEALS_ACKNOWLEDGMENT_TEXT,
} from "~/domain/luxurysteals/acknowledgmentText";
import {
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG,
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION,
  RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT,
} from "~/domain/rma/acknowledgmentText";
import {
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
} from "~/domain/warranty/acknowledgmentText";

/**
 * The registry of `policy_version` rows the application REQUIRES in order to
 * function — as opposed to `prisma/seed.ts`'s fixtures (`sample-policy`,
 * demo products, sample costs), which are convenience data for developer
 * machines and the disposable integration database and are allowed to be
 * absent from production.
 *
 * WHY THIS EXISTS. The deployed Luxury Steals acknowledgment endpoint
 * returned HTTP 500 `policy_unavailable` on its first real production
 * request: the `luxury-steals-final-sale-acknowledgment` policy_version row
 * was created only by `seedLuxuryStealsAcknowledgmentPolicy()` in
 * `prisma/seed.ts`, which runs on developer machines and in the disposable
 * integration database — `fly.toml`'s `release_command` runs
 * `prisma migrate deploy` only, never the seed script. Migration
 * `20260924020000_luxury_steals_policy_version` repaired the immediate
 * outage. This module and its tests close the gap that let it happen
 * silently: every test suite ran against a seeded database, so nothing
 * caught a required row that only migrations — not tests — would provision
 * in production.
 *
 * WHAT THIS MODULE PROVES, AND WHAT IT DOES NOT. Adding an entry here does
 * not, by itself, provision anything — a migration still has to INSERT the
 * row (`policy_version` is append-only; there is no other way to create one).
 * This module is the SOURCE the migration's hardcoded SQL literal is
 * checked against
 * (`requiredPolicyVersionsMigrationFence.test.ts` reads every
 * `prisma/migrations/**\/migration.sql` from disk and asserts byte-identity
 * with the text and hash below — same discipline
 * `notCommittedDisclosure.test.ts` uses for the theme locale file), and the
 * source `/health`'s readiness check queries the database against (see
 * `checkRequiredPolicyVersionsProvisioned` in
 * `~/db/repositories/policyVersionRepository.server`), so a missing row is
 * visible the moment a deploy finishes rather than at the first customer
 * request.
 *
 * WHY THE CONTENT HASH IS `sha256Hex(text)`, NOT `buildPolicyVersionRecord`'s
 * OWN `.contentHash`. This module still calls `buildPolicyVersionRecord` for
 * every entry (per architect instruction — shape validation reuses the one
 * existing validator rather than a parallel schema), but DISCARDS its
 * `.contentHash` and recomputes independently via the same plain
 * `sha256Hex(text)` that `prisma/seed.ts` and migration
 * `20260924020000` both actually use to persist `content_hash`.
 *
 * THE REASON THIS MATTERS, A DISCOVERED INCONSISTENCY: `buildPolicyVersionRecord`
 * computes its `.contentHash` via `hashCanonicalJson(text)`
 * (`policyVersion.ts`), which — for a bare string input — is
 * `sha256(JSON.stringify(text))`, i.e. the text wrapped in a JSON string
 * envelope (quoted and escaped) before hashing. That differs from the plain
 * `sha256(text)` every actual provisioning path uses. Verified directly:
 * for `LUXURY_STEALS_ACKNOWLEDGMENT_TEXT`, plain `sha256Hex` produces
 * `5c313b74...` (matches the migration's hardcoded `content_hash` exactly),
 * while `hashCanonicalJson` produces `9a685a9c...` (does not match anything
 * ever persisted). Using `buildPolicyVersionRecord`'s own hash here would
 * make the drift fence fail against a CORRECTLY provisioned database, which
 * is worse than not having the fence — flagged for architect review; see the
 * task handoff. `createPolicyVersion`'s runtime path (no current caller in
 * this codebase) is the one place that would still produce the
 * canonical-JSON hash if ever used to create a new policy version by hand,
 * which is itself part of the finding, not something this module works
 * around silently.
 */

export interface RequiredPolicyVersion {
  readonly slug: string;
  readonly version: number;
  readonly text: string;
  /** Plain SHA-256 hex digest of `text` — see this module's header comment for why NOT `buildPolicyVersionRecord`'s own `.contentHash`. */
  readonly contentHash: string;
}

/**
 * Shared synthetic effective date, matching `prisma/seed.ts`'s
 * `SEED_EFFECTIVE_FROM` and migration `20260924020000`'s hardcoded
 * `'2026-01-01T00:00:00.000Z'` literal — every required policy version
 * provisioned so far shares it, so re-provisioning always resolves to the
 * same natural key.
 */
const REQUIRED_POLICY_EFFECTIVE_FROM = new Date("2026-01-01T00:00:00.000Z");

function toRequiredPolicyVersion(input: { slug: string; version: number; text: string }): RequiredPolicyVersion {
  // Shape validation only (non-empty slug/text, positive integer version) —
  // its `.contentHash` output is deliberately not used, see header comment.
  const validated = buildPolicyVersionRecord({
    slug: input.slug,
    version: input.version,
    effectiveFrom: REQUIRED_POLICY_EFFECTIVE_FROM,
    text: input.text,
  });
  return {
    slug: validated.slug,
    version: validated.version,
    text: validated.text,
    contentHash: sha256Hex(validated.text),
  };
}

/**
 * Every policy_version row the application requires to exist in ANY
 * environment before it can serve its core flows. `sample-policy` is
 * deliberately absent — it is a Slice 0 fixture, not a requirement.
 */
export const REQUIRED_POLICY_VERSIONS: readonly RequiredPolicyVersion[] = [
  toRequiredPolicyVersion({
    slug: LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
    version: LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_VERSION,
    text: LUXURY_STEALS_ACKNOWLEDGMENT_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
    version: WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_VERSION,
    text: WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG,
    version: RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_VERSION,
    text: RMA_RETURN_POLICY_ACKNOWLEDGMENT_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
    version: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION,
    text: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
  }),
  // Slice 9. REQUIRED rather than optional: without this row the deposit
  // acknowledgment cannot be recorded, so the route must refuse to charge —
  // which is correct behaviour and a total outage of the deposit step. Being
  // in this list is what makes a missing row visible at deploy time via
  // /health instead of at the first customer's attempt to pay.
  toRequiredPolicyVersion({
    slug: CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
    version: CUSTOM_JEWELRY_DEPOSIT_POLICY_VERSION,
    text: CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  }),
  // Slice 10. SIX, not five: the original specification defines no
  // acknowledgment for an active online listing, because there a live listing
  // was guarantee-eligible and took 3A. Amendment §1 moved it to review-only
  // and supplied its own wording — so provisioning only the original five
  // would leave an online listing showing the 3A guarantee text.
  toRequiredPolicyVersion({
    slug: BEAT_QUOTE_POLICY_SLUGS.whatWeMatch,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: BEAT_QUOTE_POLICY_SLUGS.authenticity,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_AUTHENTICITY_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: BEAT_QUOTE_POLICY_SLUGS.recentQuote,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_RECENT_QUOTE_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: BEAT_QUOTE_POLICY_SLUGS.olderQuote,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_OLDER_QUOTE_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: BEAT_QUOTE_POLICY_SLUGS.groupBuy,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_GROUP_BUY_TEXT,
  }),
  toRequiredPolicyVersion({
    slug: BEAT_QUOTE_POLICY_SLUGS.onlineListing,
    version: BEAT_QUOTE_POLICY_VERSION,
    text: BEAT_QUOTE_ONLINE_LISTING_TEXT,
  }),
];

export interface PresentPolicyVersionKey {
  readonly slug: string;
  readonly version: number;
}

export interface MissingRequiredPolicyVersion {
  readonly slug: string;
  readonly version: number;
}

/**
 * PURE — no database access. Given what the registry requires and what
 * (slug, version) pairs a caller found present in the database, returns
 * exactly the required entries that are absent. The database-touching half
 * lives in `checkRequiredPolicyVersionsProvisioned`
 * (`~/db/repositories/policyVersionRepository.server`), which calls this
 * with its query result — same layering as every other domain/repository
 * split in this codebase (e.g. `luxurysteals/assignment.ts` vs
 * `luxuryStealRepository.server.ts`).
 */
export function computeMissingRequiredPolicyVersions(
  required: readonly RequiredPolicyVersion[],
  present: readonly PresentPolicyVersionKey[]
): MissingRequiredPolicyVersion[] {
  const presentKeys = new Set(present.map((p) => `${p.slug}@${p.version}`));
  return required
    .filter((r) => !presentKeys.has(`${r.slug}@${r.version}`))
    .map((r) => ({ slug: r.slug, version: r.version }));
}
