import type {
  GroupBuyCampaign,
  GroupBuyCampaignStatus,
  GroupBuyCampaignTier,
  GroupBuyCampaignVariant,
} from "@prisma/client";

import { EXCLUDE_TEST_FIXTURE_CAMPAIGNS } from "~/domain/groupbuy/testFixtureCampaign";
import { validateTierSet, type TierDefinition } from "~/domain/groupbuy/tiers";
import type { GroupBuyCampaignOptions } from "~/domain/groupbuy/campaignOptions";
import { getCurrentTier } from "~/jobs/groupbuy/unitLedger.server";
import { TIER_SYNCED_ACTION, TIER_SYNC_ENTITY_TYPE } from "~/jobs/groupbuy/tierPriceSync.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import { hashCanonicalJson } from "~/domain/evidence/hash";
import type { JsonValue } from "~/domain/evidence";

import { prisma } from "../client.server";

/**
 * Group Buy repository (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §24-25,
 * README "Group Buy — Locked MVP1 Direction").
 *
 * TWO THINGS THIS FILE DELIBERATELY DOES NOT REBUILD. The freeze
 * (`openGroupBuyCampaign`, `app/jobs/groupbuy/openCampaign.server.ts`) and
 * qualifying-unit recording/close-lock (`app/jobs/groupbuy/unitLedger.server.ts`)
 * already exist, are already idempotent by constraint, already validate tier
 * safety via `evaluateTierSafety` before publication, and already make an
 * open campaign's frozen fields unwritable at the database level (the
 * `group_buy_campaign_guard` trigger). This file CALLS both where it needs
 * their state — never re-derives a rule either one already encodes. What it
 * adds is DRAFT-ONLY campaign/tier/variant configuration (today only
 * exercised ad hoc by `scripts/dev-group-buy-campaign.ts`) and read-only
 * admin-surface support (campaign listing, tier-publish status, candidate
 * variants, the campaign-options upload store).
 *
 * REFUND COMPUTATION AND LIFECYCLE DO NOT LIVE HERE (architect decision,
 * Group Buy refund-ledger consolidation, 2026-09-28). This file used to carry
 * a second, independent implementation of settlement (`recordGroupBuyTierRefund`,
 * `transitionGroupBuyRefundStatus`, `recordGroupBuyRefundOverride`,
 * `getGroupBuyRefundForLine`, `listGroupBuyRefundsForCampaign`) alongside
 * `app/jobs/groupbuy/refundLedger.server.ts`'s own — both built independently,
 * both correct in isolation, and both with ZERO callers, which is exactly why
 * the duplication went unnoticed until this task wired the first live caller
 * and found the second implementation sitting right next to it. Refund
 * computation and lifecycle are business logic, not data access, and
 * `refundLedger.server.ts` is now the single home for both — including the
 * override capability, moved there rather than deleted. Grepped for callers
 * before deletion; none existed outside this file's own tests, which were
 * deleted alongside the functions.
 *
 * NO SCHEMA CHANGES. `GroupBuyCampaign`/`GroupBuyCampaignTier`/
 * `GroupBuyCampaignVariant` already carry every column this file needs —
 * checked before writing a single line here, per the assigning instruction
 * not to assume a gap that isn't one.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GroupBuyCampaignNotFoundError extends Error {
  constructor(readonly campaignId: string) {
    super(`No Group Buy campaign with id ${campaignId}.`);
    this.name = "GroupBuyCampaignNotFoundError";
  }
}

/** Draft-only configuration attempted against a non-draft campaign. The database's own trigger would refuse the write too; this is the friendlier error before that point. */
export class GroupBuyCampaignNotDraftForConfigurationError extends Error {
  constructor(campaignId: string, status: string) {
    super(`Campaign ${campaignId} is ${status}; tiers and eligible variants can only be configured while draft.`);
    this.name = "GroupBuyCampaignNotDraftForConfigurationError";
  }
}

// ---------------------------------------------------------------------------
// Campaign configuration — DRAFT ONLY. `openGroupBuyCampaign` (already built)
// is the only path from draft to open; nothing here touches status.
// ---------------------------------------------------------------------------

export interface CreateGroupBuyCampaignInput {
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly createdBy: string;
  readonly scheduledCloseAt?: Date | null;
  readonly tiers: readonly TierDefinition[];
}

/**
 * Creates a draft campaign with its initial tier set. Tiers are validated
 * (`validateTierSet` — count, contiguity, strictly-falling multipliers, the
 * README's "tier 1 starts at 1 unit" rule) BEFORE anything is written; an
 * invalid tier set never reaches the database.
 */
export async function createGroupBuyCampaign(input: CreateGroupBuyCampaignInput): Promise<GroupBuyCampaign> {
  validateTierSet(input.tiers);

  return prisma.groupBuyCampaign.create({
    data: {
      code: input.code,
      name: input.name,
      currency: input.currency,
      createdBy: input.createdBy,
      scheduledCloseAt: input.scheduledCloseAt ?? null,
      tiers: {
        create: input.tiers.map((t) => ({
          tierNumber: t.tierNumber,
          minQualifyingUnits: t.minQualifyingUnits,
          priceMultiplier: t.priceMultiplier,
        })),
      },
    },
  });
}

async function requireDraftCampaign(campaignId: string): Promise<GroupBuyCampaign> {
  const campaign = await prisma.groupBuyCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new GroupBuyCampaignNotFoundError(campaignId);
  if (campaign.status !== "draft") {
    throw new GroupBuyCampaignNotDraftForConfigurationError(campaignId, campaign.status);
  }
  return campaign;
}

/**
 * Replaces a draft campaign's entire tier set (delete-then-recreate, the
 * same pattern `scripts/dev-group-buy-campaign.ts` already uses ad hoc —
 * formalised here). Validated before any write. Refused outright once the
 * campaign is not draft — tiers freeze at open, and the database's own
 * trigger would refuse the writes below anyway; this is the earlier, named
 * refusal.
 */
export async function replaceGroupBuyCampaignTiers(
  campaignId: string,
  tiers: readonly TierDefinition[]
): Promise<readonly GroupBuyCampaignTier[]> {
  validateTierSet(tiers);
  await requireDraftCampaign(campaignId);

  return prisma.$transaction(async (tx) => {
    await tx.groupBuyCampaignTier.deleteMany({ where: { campaignId } });
    await tx.groupBuyCampaignTier.createMany({
      data: tiers.map((t) => ({
        campaignId,
        tierNumber: t.tierNumber,
        minQualifyingUnits: t.minQualifyingUnits,
        priceMultiplier: t.priceMultiplier,
      })),
    });
    return tx.groupBuyCampaignTier.findMany({ where: { campaignId }, orderBy: { tierNumber: "asc" } });
  });
}

/**
 * Adds one eligible variant to a draft campaign, with PLACEHOLDER frozen
 * prices — `openGroupBuyCampaign` overwrites them with real, resolved
 * prices at freeze time; they exist only to satisfy the NOT NULL columns
 * while the campaign is still being configured. Never read as real prices
 * before a campaign opens.
 */
export async function addGroupBuyCampaignEligibleVariant(
  campaignId: string,
  masterVariantId: string
): Promise<GroupBuyCampaignVariant> {
  await requireDraftCampaign(campaignId);

  return prisma.groupBuyCampaignVariant.create({
    data: {
      campaignId,
      masterVariantId,
      frozenBaseBankPaymentPriceMinorUnits: 1n,
      frozenLandedCostMinorUnits: 0n,
    },
  });
}

export async function removeGroupBuyCampaignEligibleVariant(
  campaignId: string,
  masterVariantId: string
): Promise<void> {
  await requireDraftCampaign(campaignId);
  await prisma.groupBuyCampaignVariant.delete({
    where: { campaignId_masterVariantId: { campaignId, masterVariantId } },
  });
}

export interface GroupBuyCampaignForStaff extends GroupBuyCampaign {
  readonly tiers: readonly GroupBuyCampaignTier[];
  readonly variants: readonly GroupBuyCampaignVariant[];
}

/** The complete campaign configuration — tiers and eligible variants — for the admin surface. */
export async function getGroupBuyCampaignForStaff(campaignId: string): Promise<GroupBuyCampaignForStaff | null> {
  return prisma.groupBuyCampaign.findUnique({
    where: { id: campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  }) as Promise<GroupBuyCampaignForStaff | null>;
}

// ---------------------------------------------------------------------------
// Staff admin surface support (Slice 6, `app.group-buy-campaigns*`) — list
// and candidate-variant lookups for the campaign list/create/detail screens,
// plus the campaign-options (§12) upload store. ADDITIVE ONLY: nothing above
// this line is changed, and every function below either calls an existing
// guard (`requireDraftCampaign`) or reads data that already exists.
//
// EXPLICIT SELECTS THROUGHOUT, never a raw spread of a Prisma row — a
// campaign admin surface is exactly the place a convenient `include` would
// quietly pull `frozenLandedCostMinorUnits`, `unsafeOverrideReason`, or a
// pricing-profile relation into a rendered page (CLAUDE.md rule 10). Every
// row type here is named and enumerated by hand.
// ---------------------------------------------------------------------------

export interface GroupBuyCampaignListRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: GroupBuyCampaignStatus;
  readonly currency: string;
  readonly scheduledCloseAt: Date | null;
  readonly openedAt: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
  readonly tierCount: number;
  readonly variantCount: number;
}

/** Every campaign, newest first — the admin landing list. No price, cost, profile, or override field is selected. */
/**
 * LIVE-GATE FIXTURE CAMPAIGNS ARE EXCLUDED BY DEFAULT.
 *
 * They are real rows with real orders and real qualifying units, created so
 * the gates could prove enforcement against production, and they can never be
 * deleted — `group_buy_campaign` rows are refused by the frozen-child guard,
 * and their units and acknowledgments are append-only evidence besides. Left
 * in this list they would inflate every number a human reads as business
 * activity.
 *
 * `includeTestFixtures` keeps them FINDABLE rather than hidden. Nothing here
 * suppresses evidence; a staff member who needs to see what a gate left
 * behind asks for it explicitly, and gets it.
 */
export async function listGroupBuyCampaignsForStaff(
  options: { includeTestFixtures?: boolean } = {}
): Promise<readonly GroupBuyCampaignListRow[]> {
  const rows = await prisma.groupBuyCampaign.findMany({
    where: options.includeTestFixtures ? undefined : EXCLUDE_TEST_FIXTURE_CAMPAIGNS,
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      currency: true,
      scheduledCloseAt: true,
      openedAt: true,
      closedAt: true,
      createdAt: true,
      _count: { select: { tiers: true, variants: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    currency: row.currency,
    scheduledCloseAt: row.scheduledCloseAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    tierCount: row._count.tiers,
    variantCount: row._count.variants,
  }));
}

export interface GroupBuyCampaignTierPublishStatus {
  readonly tierNumber: number;
  readonly qualifyingUnits: number;
  /** True once the campaign's CURRENT tier price has fully reached Shopify. */
  readonly published: boolean;
}

/**
 * MIRRORS the private completion-marker check
 * `ensureGroupBuyCampaignSyncedToCurrentTier` (`~/jobs/groupbuy/
 * tierPriceSync.server.ts`) makes before publishing — same action/entity-type
 * strings, same "highest tierNumber recorded >= the live tier" test. Not
 * imported from that file because these two constants are not exported there,
 * and this task is explicitly scoped to `app/db/repositories` and
 * `app/routes` only (another agent owns `app/jobs/groupbuy/**`). If those
 * strings ever change, this drifts silently — `tests/integration/groupbuy/
 * openCampaignTierPublish.test.ts` already asserts the same literals, so a
 * rename there is likely to be caught by that file failing too.
 */
// Imported, NOT re-declared — see TIER_SYNCED_ACTION's own comment. A
// mirrored literal here would drift silently and report an unpublished tier
// as published.
const TIER_PRICE_SYNCED_ACTION = TIER_SYNCED_ACTION;
const TIER_PRICE_SYNCED_ENTITY_TYPE = TIER_SYNC_ENTITY_TYPE;

/**
 * Whether an OPEN campaign's current tier price has ever been fully
 * published to Shopify — the gap `openGroupBuyCampaign`'s
 * `CampaignOpenTierPublishError` warns about when campaign-open's own publish
 * attempt fails. Read-only: makes no Shopify call and writes nothing.
 *
 * `null` for a draft (nothing frozen yet to publish) or a closed campaign
 * (frozen pricing "stays exactly as it was" regardless of Shopify's
 * last-known price — see `ensureGroupBuyCampaignSyncedToCurrentTier`'s own
 * early return for the same rule) — there is no admin action for either
 * status, so this deliberately reports "not applicable" rather than a status
 * this route cannot do anything about.
 */
export async function getGroupBuyCampaignTierPublishStatus(
  campaignId: string
): Promise<GroupBuyCampaignTierPublishStatus | null> {
  const campaign = await prisma.groupBuyCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  if (!campaign || campaign.status !== "open") return null;

  const { tier, qualifyingUnits } = await getCurrentTier(campaignId);
  const events = await listAuditEventsForEntity(TIER_PRICE_SYNCED_ENTITY_TYPE, campaignId);
  const published = events.some((event) => {
    if (event.action !== TIER_PRICE_SYNCED_ACTION) return false;
    const after = event.after as { tierNumber?: unknown } | null;
    return typeof after?.tierNumber === "number" && after.tierNumber >= tier.tierNumber;
  });

  return { tierNumber: tier.tierNumber, qualifyingUnits, published };
}

export interface GroupBuyCandidateVariantRow {
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  readonly metal: string;
  readonly purity: string;
  readonly bandLabel: string | null;
}

export interface GroupBuyCandidateProductRow {
  readonly masterProductId: string;
  readonly name: string;
  readonly variants: readonly GroupBuyCandidateVariantRow[];
}

/**
 * Active variants grouped by product, for the "add eligible variant" picker.
 * Same explicit-select discipline as `luxuryStealRepository.server.ts`'s
 * `listLuxuryStealProductAssignments` (identification only — metal/purity/
 * band — never cost, floor, or margin fields).
 */
export async function listMasterVariantsForGroupBuySelection(
  query?: string
): Promise<readonly GroupBuyCandidateProductRow[]> {
  const products = await prisma.masterProduct.findMany({
    where: query ? { name: { contains: query, mode: "insensitive" } } : undefined,
    select: {
      id: true,
      name: true,
      variants: {
        where: { status: "active" },
        select: {
          id: true,
          shopifyVariantGid: true,
          metal: true,
          purity: true,
          band: { select: { label: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  return products.map((product) => ({
    masterProductId: product.id,
    name: product.name,
    variants: product.variants.map((variant) => ({
      masterVariantId: variant.id,
      shopifyVariantGid: variant.shopifyVariantGid,
      metal: variant.metal,
      purity: variant.purity,
      bandLabel: variant.band?.label ?? null,
    })),
  }));
}

export interface GroupBuyVariantIdentity {
  readonly masterVariantId: string;
  readonly productName: string;
  readonly metal: string;
  readonly purity: string;
  readonly bandLabel: string | null;
}

/**
 * Identity (never price/cost) for a known set of variant ids — used to label
 * a campaign's already-configured eligible variants and to name variants in
 * a tier-safety report, without re-deriving the whole candidate list.
 */
export async function getGroupBuyVariantIdentities(
  masterVariantIds: readonly string[]
): Promise<readonly GroupBuyVariantIdentity[]> {
  if (masterVariantIds.length === 0) return [];
  const variants = await prisma.masterVariant.findMany({
    where: { id: { in: [...masterVariantIds] } },
    select: {
      id: true,
      metal: true,
      purity: true,
      band: { select: { label: true } },
      masterProduct: { select: { name: true } },
    },
  });
  return variants.map((variant) => ({
    masterVariantId: variant.id,
    productName: variant.masterProduct.name,
    metal: variant.metal,
    purity: variant.purity,
    bandLabel: variant.band?.label ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Campaign-options (§12) upload store.
//
// NO SCHEMA CHANGE. `GroupBuyCampaign` has no options column, and its one
// `snapshotId` foreign key is already reserved for the pricing-FREEZE
// snapshot `openCampaign.server.ts` writes at open — reusing it here would
// make the freeze and the options upload fight over a single column. Stored
// instead as its own row in the existing generic, append-only, content-hashed
// `Snapshot` table (the same store the freeze itself uses), distinguished by
// `kind` and carrying `campaignId` inside its own JSONB payload rather than a
// relational column. `getLatestGroupBuyCampaignOptionsUpload` reads it back
// by filtering that payload field — the `snapshot` table's payload column is
// `jsonb` (see migration `20260913000000_init`), so a `path` filter on it is
// a real, indexed-by-`kind` query, not a full-table scan of everything ever
// snapshotted.
//
// TRUSTS ITS INPUT IS ALREADY VALIDATED. `saveGroupBuyCampaignOptionsUpload`
// does not call `validateGroupBuyCampaignOptions` itself — the caller (the
// upload action) must have already gotten an `{ ok: true }` result and is
// passing that result's `value` through. This mirrors `openGroupBuyCampaign`,
// which likewise never re-validates `validateTierSet`'s own output.
//
// DRAFT ONLY, same guard as every other pre-open configuration write in this
// file: a campaign's saleable-configuration contract does not change once
// live, for the same reason its tiers and eligible variants do not.
//
// RE-UPLOADING SIMPLY ADDS ANOTHER ROW; the getter picks the CURRENT one by
// an explicit `sequence` integer (below), never by wall-clock `createdAt`.
//
// WHY NOT `createdAt`. The architect's review of this design (2026-09-26)
// called out that "take the latest by timestamp" is implicit, not
// deterministic: the `snapshot` table's `created_at` column is
// `TIMESTAMP(3)` (millisecond precision — see migration
// `20260913000000_init`), so two uploads for the same campaign close
// together — a double-submit, or two fast sequential calls in a test — can
// tie, and a tie makes "the most recent one" ambiguous. `sequence` instead is
// an integer assigned INSIDE a transaction that first takes a row lock on the
// campaign (`SELECT ... FOR UPDATE`), so a concurrent second upload for the
// SAME campaign blocks until the first commits and then counts it — two
// uploads for one campaign can never be assigned the same sequence, by
// construction, not by convention. See `saveGroupBuyCampaignOptionsUpload`.
// ---------------------------------------------------------------------------

export const GROUP_BUY_CAMPAIGN_OPTIONS_SNAPSHOT_KIND = "groupbuy.campaign_options.v1";

export interface GroupBuyCampaignOptionsUpload {
  readonly snapshotId: string;
  readonly campaignId: string;
  /** 1-based, assigned transactionally at upload time. The sole "which one is current" ordering key — see the section header above. */
  readonly sequence: number;
  readonly options: GroupBuyCampaignOptions;
  readonly uploadedBy: string;
  readonly uploadedAt: Date;
  readonly contentHash: string;
}

interface StoredGroupBuyCampaignOptionsPayload {
  readonly campaignId: string;
  readonly sequence: number;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly options: GroupBuyCampaignOptions;
}

/**
 * Records a validated campaign-options upload with a transactionally
 * assigned, campaign-scoped `sequence`.
 *
 * THE ROW LOCK IS THE WHOLE POINT. `SELECT ... FOR UPDATE` on the campaign's
 * own row (no schema change needed — this is a lock, not a column) makes a
 * concurrent second call for the SAME campaign wait for the first to commit,
 * so "count existing uploads, then insert the next number" can never race:
 * the second transaction only starts counting after the first transaction's
 * insert is already visible to it. Two different campaigns never block each
 * other, because each locks only its own row.
 *
 * DRAFT-ONLY, checked AFTER acquiring the lock and by re-reading status from
 * inside the SAME transaction — not via the earlier `requireDraftCampaign`
 * read-then-write helper, which would leave a window between checking draft
 * status and taking the lock for a concurrent `openGroupBuyCampaign` to open
 * the campaign in between.
 */
export async function saveGroupBuyCampaignOptionsUpload(
  campaignId: string,
  options: GroupBuyCampaignOptions,
  uploadedBy: string
): Promise<GroupBuyCampaignOptionsUpload> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM group_buy_campaign WHERE id = ${campaignId}::uuid FOR UPDATE
    `;
    const campaign = locked[0];
    if (!campaign) throw new GroupBuyCampaignNotFoundError(campaignId);
    if (campaign.status !== "draft") {
      throw new GroupBuyCampaignNotDraftForConfigurationError(campaignId, campaign.status);
    }

    const priorUploads = await tx.snapshot.count({
      where: { kind: GROUP_BUY_CAMPAIGN_OPTIONS_SNAPSHOT_KIND, payload: { path: ["campaignId"], equals: campaignId } },
    });
    const sequence = priorUploads + 1;

    const uploadedAt = new Date();
    const payload = JSON.parse(
      JSON.stringify({
        kind: GROUP_BUY_CAMPAIGN_OPTIONS_SNAPSHOT_KIND,
        campaignId,
        sequence,
        uploadedBy,
        uploadedAt: uploadedAt.toISOString(),
        options,
      })
    ) as JsonValue;
    const contentHash = hashCanonicalJson(payload);

    const snapshot = await tx.snapshot.create({
      data: { kind: GROUP_BUY_CAMPAIGN_OPTIONS_SNAPSHOT_KIND, payload: payload as never, contentHash },
    });

    return { snapshotId: snapshot.id, campaignId, sequence, options, uploadedBy, uploadedAt, contentHash };
  });
}

/**
 * The CURRENT validated campaign-options upload for a campaign — the one
 * with the highest `sequence`, never the one with the latest `createdAt`
 * (see the section header above for why that distinction matters). Returns
 * null if the campaign has never had an upload.
 */
export async function getLatestGroupBuyCampaignOptionsUpload(
  campaignId: string
): Promise<GroupBuyCampaignOptionsUpload | null> {
  const snapshots = await prisma.snapshot.findMany({
    where: { kind: GROUP_BUY_CAMPAIGN_OPTIONS_SNAPSHOT_KIND, payload: { path: ["campaignId"], equals: campaignId } },
  });
  if (snapshots.length === 0) return null;

  let latest: (typeof snapshots)[number] | null = null;
  let latestSequence = -1;
  for (const snapshot of snapshots) {
    const payload = snapshot.payload as unknown as StoredGroupBuyCampaignOptionsPayload;
    if (payload.sequence > latestSequence) {
      latestSequence = payload.sequence;
      latest = snapshot;
    }
  }
  if (!latest) return null;

  const payload = latest.payload as unknown as StoredGroupBuyCampaignOptionsPayload;
  return {
    snapshotId: latest.id,
    campaignId: payload.campaignId,
    sequence: payload.sequence,
    options: payload.options,
    uploadedBy: payload.uploadedBy,
    uploadedAt: new Date(payload.uploadedAt),
    contentHash: latest.contentHash,
  };
}

/**
 * The campaign-options configuration PINNED into the pricing freeze at open
 * (`openGroupBuyCampaign`, `app/jobs/groupbuy/openCampaign.server.ts`) —
 * read from the freeze snapshot's OWN payload (`optionsAtFreeze`), never by
 * re-running `getLatestGroupBuyCampaignOptionsUpload` against the mutable
 * upload store.
 *
 * WHY THIS MUST BE SEPARATE FROM "LATEST", per the architect's review: once a
 * campaign opens, no further upload can ever be recorded for it (the
 * draft-only guard above is permanent, not merely current behaviour) — so
 * today "latest" and "pinned at freeze" happen to agree for any already-open
 * campaign. But an open/closed campaign's records should say what was true
 * AT OPEN, by id, not by re-deriving an answer from a table that continues
 * to exist and could in principle be queried differently later (a different
 * selection rule, a future multi-kind snapshot cleanup, etc.). The freeze
 * payload is the same kind of self-contained, recomputable record the
 * pricing freeze itself already is — see this file's own header on why the
 * freeze stores resolved INPUTS rather than only prices.
 *
 * Returns null when the campaign never had an options upload at the moment
 * it opened (campaign-options upload is optional; see
 * `app.group-buy-campaigns.$id.tsx`'s header comment on that point) or when
 * `freezeSnapshotId` itself is null (an unopened campaign).
 */
/**
 * The exact shape `openGroupBuyCampaign` embeds as the freeze payload's
 * `optionsAtFreeze` field — `StoredGroupBuyCampaignOptionsPayload` plus the
 * two columns that live outside an upload's own JSON blob (the upload's
 * Snapshot row id and content hash). Exported so `openCampaign.server.ts`
 * builds exactly this shape rather than an ad hoc lookalike.
 */
export interface FrozenGroupBuyCampaignOptionsPayload extends StoredGroupBuyCampaignOptionsPayload {
  readonly snapshotId: string;
  readonly contentHash: string;
}

export async function getFrozenGroupBuyCampaignOptions(
  freezeSnapshotId: string | null
): Promise<GroupBuyCampaignOptionsUpload | null> {
  if (!freezeSnapshotId) return null;
  const snapshot = await prisma.snapshot.findUnique({ where: { id: freezeSnapshotId } });
  if (!snapshot) return null;

  const payload = snapshot.payload as unknown as { optionsAtFreeze?: FrozenGroupBuyCampaignOptionsPayload | null };
  const pinned = payload.optionsAtFreeze;
  if (!pinned) return null;

  return {
    // The upload's OWN snapshot id (recorded at upload time) — a different
    // Snapshot row than the freeze snapshot itself. Callers that display
    // "uploaded as revision #N" need this one, not `freezeSnapshotId`.
    snapshotId: pinned.snapshotId,
    campaignId: pinned.campaignId,
    sequence: pinned.sequence,
    options: pinned.options,
    uploadedBy: pinned.uploadedBy,
    uploadedAt: new Date(pinned.uploadedAt),
    contentHash: pinned.contentHash,
  };
}
