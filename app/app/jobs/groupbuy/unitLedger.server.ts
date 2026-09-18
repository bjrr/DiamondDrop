import type { GroupBuyUnitEventKind } from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  canRemoveUnits,
  foldQualifyingUnits,
  type QualifyingUnitCount,
  type UnitEvent,
} from "~/domain/groupbuy/qualifyingUnits";
import { selectTier, type TierDefinition } from "~/domain/groupbuy/tiers";
import { logger } from "~/lib/logger.server";

/**
 * Recording qualifying units, and locking the count at close.
 *
 * IDEMPOTENT BY CONSTRUCTION. Units arrive from Shopify webhooks, and Shopify
 * retries. Our webhook boundary already deduplicates deliveries, but this adds
 * a second, independent guarantee at the place where double-counting would
 * actually cost money: a unique (campaignId, externalRef) means a replayed
 * event is a no-op rather than an extra unit, even if something other than the
 * webhook path writes it.
 *
 * THE TIER CAN GO DOWN. README: "Cancellation removes qualifying units and can
 * move the live campaign back to a prior tier before close." So the live tier
 * is always recomputed from the current fold — never cached, never treated as a
 * high-water mark.
 */

export class CampaignNotOpenError extends Error {
  constructor(id: string, status: string) {
    super(`Campaign ${id} is ${status}; qualifying units can only change while it is open.`);
    this.name = "CampaignNotOpenError";
  }
}

export class UnitRemovalRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`Cannot remove qualifying units: ${reason}`);
    this.name = "UnitRemovalRefusedError";
  }
}

export class VariantNotEligibleError extends Error {
  constructor(campaignId: string, masterVariantId: string) {
    super(`Variant ${masterVariantId} is not eligible for campaign ${campaignId}.`);
    this.name = "VariantNotEligibleError";
  }
}

async function loadEvents(campaignId: string): Promise<UnitEvent[]> {
  const rows = await prisma.groupBuyUnitEvent.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => ({
    externalRef: r.externalRef,
    kind: r.kind,
    quantity: r.quantity,
    masterVariantId: r.masterVariantId,
    lineRef: r.lineRef,
  }));
}

/** The live count, folded from the ledger. Never a cached column. */
export async function getQualifyingUnits(campaignId: string): Promise<QualifyingUnitCount> {
  return foldQualifyingUnits(await loadEvents(campaignId));
}

/** The tier a campaign is currently on, recomputed from the live count. */
export async function getCurrentTier(campaignId: string): Promise<{
  tier: TierDefinition;
  qualifyingUnits: number;
}> {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } } },
  });

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));

  // A closed campaign reports its LOCKED count, not a fresh fold. After close
  // the ledger should not move, but reading it anyway would make the reported
  // tier depend on data that is supposed to be settled.
  const qualifyingUnits =
    campaign.finalQualifyingUnits ?? (await getQualifyingUnits(campaignId)).total;

  return { tier: selectTier(tiers, qualifyingUnits), qualifyingUnits };
}

export interface RecordUnitEventInput {
  campaignId: string;
  masterVariantId: string;
  kind: GroupBuyUnitEventKind;
  quantity: number;
  orderRef: string;
  lineRef: string;
  /** Stable id from the source system. Replays with the same value are no-ops. */
  externalRef: string;
  occurredAt: Date;
  recordedBy: string;
}

export interface RecordUnitEventResult {
  recorded: boolean;
  /** False when the event had already been recorded — a replay, not an error. */
  duplicate: boolean;
  qualifyingUnits: number;
  tierNumber: number;
}

export async function recordUnitEvent(
  input: RecordUnitEventInput
): Promise<RecordUnitEventResult> {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  // README: at close the order is committed with no discretionary
  // cancellation, and units cannot be added to a campaign that is not running.
  if (campaign.status !== "open") {
    throw new CampaignNotOpenError(campaign.id, campaign.status);
  }

  if (!campaign.variants.some((v) => v.masterVariantId === input.masterVariantId)) {
    // An ineligible variant would inflate the count towards a tier it was never
    // meant to qualify for.
    throw new VariantNotEligibleError(campaign.id, input.masterVariantId);
  }

  const existing = await prisma.groupBuyUnitEvent.findUnique({
    where: { campaignId_externalRef: { campaignId: input.campaignId, externalRef: input.externalRef } },
  });

  if (existing) {
    // A replay. Report the current state rather than throwing: the caller —
    // usually a retrying webhook — did nothing wrong and needs an answer, not
    // an error.
    const { tier, qualifyingUnits } = await getCurrentTier(input.campaignId);
    return { recorded: false, duplicate: true, qualifyingUnits, tierNumber: tier.tierNumber };
  }

  if (input.kind !== "purchased") {
    // Checked BEFORE writing. The ledger is append-only, so an over-removal
    // recorded once would make every later fold throw — the campaign would
    // become permanently unreadable rather than merely wrong.
    const check = canRemoveUnits(await loadEvents(input.campaignId), input.lineRef, input.quantity);
    if (!check.allowed) throw new UnitRemovalRefusedError(check.reason ?? "not allowed");
  }

  await prisma.groupBuyUnitEvent.create({
    data: {
      campaignId: input.campaignId,
      masterVariantId: input.masterVariantId,
      kind: input.kind,
      quantity: input.quantity,
      orderRef: input.orderRef,
      lineRef: input.lineRef,
      externalRef: input.externalRef,
      occurredAt: input.occurredAt,
      recordedBy: input.recordedBy,
    },
  });

  const { tier, qualifyingUnits } = await getCurrentTier(input.campaignId);

  logger.info("groupbuy.unit_event_recorded", {
    campaignId: input.campaignId,
    kind: input.kind,
    quantity: input.quantity,
    qualifyingUnits,
    tierNumber: tier.tierNumber,
    // No prices or customer identifiers (criterion 30).
  });

  return { recorded: true, duplicate: false, qualifyingUnits, tierNumber: tier.tierNumber };
}

export interface CloseCampaignResult {
  campaignId: string;
  finalQualifyingUnits: number;
  finalTierNumber: number;
  closedAt: Date;
}

/**
 * Closes a campaign and LOCKS the final count and tier.
 *
 * README: "At close, final unit count/tier lock and the order becomes committed
 * with no discretionary cancellation/return."
 *
 * The lock is written here and enforced by the database — once set, the values
 * cannot be changed. That matters because the final tier determines what every
 * earlier participant is refunded down to, so a count that could still drift
 * after close would make the refund ledger unsettleable.
 */
export async function closeGroupBuyCampaign(options: {
  campaignId: string;
  closedBy: string;
  closedAt?: Date;
}): Promise<CloseCampaignResult> {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: options.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } } },
  });

  if (campaign.status !== "open") {
    throw new CampaignNotOpenError(campaign.id, campaign.status);
  }

  const count = await getQualifyingUnits(campaign.id);
  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));
  const tier = selectTier(tiers, count.total);
  const closedAt = options.closedAt ?? new Date();

  await prisma.groupBuyCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "closed",
      closedAt,
      finalQualifyingUnits: count.total,
      finalTierNumber: tier.tierNumber,
    },
  });

  logger.info("groupbuy.campaign_closed", {
    campaignId: campaign.id,
    closedBy: options.closedBy,
    finalQualifyingUnits: count.total,
    finalTierNumber: tier.tierNumber,
  });

  return {
    campaignId: campaign.id,
    finalQualifyingUnits: count.total,
    finalTierNumber: tier.tierNumber,
    closedAt,
  };
}
