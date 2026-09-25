import { Prisma } from "@prisma/client";
import type {
  GroupBuyCampaign,
  GroupBuyCampaignTier,
  GroupBuyCampaignVariant,
  GroupBuyRefund,
  GroupBuyRefundEvent,
  PaymentBasis,
} from "@prisma/client";

import { validateTierSet, tierBankPaymentPriceExact, type TierDefinition } from "~/domain/groupbuy/tiers";
import { computeTierRefund, assertRefundTransition, type RefundStatus } from "~/domain/groupbuy/refunds";
import { getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import type { RoundingRuleId } from "~/domain/money/rounding";

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
 * adds is the two things neither owns: DRAFT-ONLY campaign/tier/variant
 * configuration (today only exercised ad hoc by `scripts/dev-group-buy-
 * campaign.ts`), and the settlement-time REFUND LEDGER (README "Group Buy
 * Final Price / Refunds"), which nothing in this codebase persists yet.
 *
 * NO SCHEMA CHANGES. `GroupBuyCampaign`/`GroupBuyCampaignTier`/
 * `GroupBuyCampaignVariant`/`GroupBuyRefund`/`GroupBuyRefundEvent` already
 * carry every column this file needs — checked before writing a single line
 * here, per the assigning instruction not to assume a gap that isn't one.
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

export class GroupBuyCampaignNotClosedError extends Error {
  constructor(campaignId: string, status: string) {
    super(`Campaign ${campaignId} is ${status}; tier-adjustment refunds can only be computed after close.`);
    this.name = "GroupBuyCampaignNotClosedError";
  }
}

export class GroupBuyRefundNotFoundError extends Error {
  constructor(readonly refundId: string) {
    super(`No Group Buy refund with id ${refundId}.`);
    this.name = "GroupBuyRefundNotFoundError";
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
// Refund ledger (README "Group Buy Final Price / Refunds", §25) — computed
// only after close, against the LOCKED final tier `closeGroupBuyCampaign`
// already wrote. Nothing here recomputes a live tier or reopens the
// qualifying-unit question; `getQualifyingUnits` (imported, not re-derived)
// supplies the per-line net figure, and `computeTierRefund` (imported, not
// re-derived) does the arithmetic.
// ---------------------------------------------------------------------------

export interface RecordGroupBuyTierRefundInput {
  readonly campaignId: string;
  readonly masterVariantId: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef?: string | null;
  /** WHICH price the customer actually paid — Bank Payment or Card. The refund basis must match, or the customer is handed back a currency they never paid in. */
  readonly paymentBasis: PaymentBasis;
  readonly paidPerUnitMinorUnits: bigint;
  readonly currency: string;
  /** Who is recording this (an admin running the close/settlement step, or the job that drives it). */
  readonly actor: string;
}

export interface RecordGroupBuyTierRefundResult {
  readonly refund: GroupBuyRefund;
  /** False when this line's refund was already computed — a replay/retry, not an error. */
  readonly created: boolean;
}

/**
 * Derives this line's FINAL per-unit price at the campaign's LOCKED final
 * tier, in the SAME payment basis the customer paid in, then computes and
 * records the refund — idempotently: `@@unique([campaignId, lineRef])` is
 * the guard (README §371 / §173: "duplicate/retried refund ... must not
 * create duplicate customer value"), not a read-then-write check. A second
 * call for the same line hits that constraint and reads the existing row
 * back rather than computing a second, possibly-different figure.
 *
 * THE BANK PRICE IS DERIVED FIRST, ALWAYS, THEN THE CARD PRICE FROM IT — the
 * same order and the same frozen rule the storefront's live progress read
 * already uses (`apps.carat.group-buy.$code.tsx`), applied here to the one
 * tier that is now locked rather than to whichever is currently active.
 */
export async function recordGroupBuyTierRefund(
  input: RecordGroupBuyTierRefundInput
): Promise<RecordGroupBuyTierRefundResult> {
  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { id: input.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });
  if (!campaign) throw new GroupBuyCampaignNotFoundError(input.campaignId);
  if (campaign.status !== "closed" || campaign.finalTierNumber === null) {
    throw new GroupBuyCampaignNotClosedError(input.campaignId, campaign.status);
  }
  if (!campaign.pricingProfileId) {
    throw new Error(`Campaign ${input.campaignId} has no frozen pricing profile; it cannot have opened validly.`);
  }

  const finalTier = campaign.tiers.find((t) => t.tierNumber === campaign.finalTierNumber);
  if (!finalTier) {
    throw new Error(`Campaign ${input.campaignId}: final tier ${campaign.finalTierNumber} is not among its own tiers.`);
  }
  const variant = campaign.variants.find((v) => v.masterVariantId === input.masterVariantId);
  if (!variant) {
    throw new Error(`Campaign ${input.campaignId}: variant ${input.masterVariantId} is not an eligible variant.`);
  }

  const frozenProfile = await prisma.pricingProfile.findUniqueOrThrow({ where: { id: campaign.pricingProfileId } });

  const tierDefinition: TierDefinition = {
    tierNumber: finalTier.tierNumber,
    minQualifyingUnits: finalTier.minQualifyingUnits,
    priceMultiplier: finalTier.priceMultiplier.toString(),
  };
  const exactBankPayment = tierBankPaymentPriceExact(
    new MoneyDecimal(variant.frozenBaseBankPaymentPriceMinorUnits.toString()),
    tierDefinition
  );
  const roundedBank = Money.fromDecimalMinorUnits(
    exactBankPayment,
    campaign.currency,
    frozenProfile.roundingRuleId as RoundingRuleId
  );
  const finalBankPerUnitMinorUnits = applyPriceEnding(
    roundedBank.amountMinorUnits,
    frozenProfile.priceEndingRuleId as PriceEndingRuleId
  );

  const finalPerUnitMinorUnits: bigint =
    input.paymentBasis === "bank_payment"
      ? finalBankPerUnitMinorUnits
      : deriveRegularCardPrice(
          finalBankPerUnitMinorUnits,
          new MoneyDecimal(frozenProfile.fixedCardUpliftRate.toString()),
          frozenProfile.regularCardPriceRuleId as RegularCardPriceRuleId
        ).regularCardPriceMinorUnits;

  // The per-line NET count — `qualifyingUnits.ts`'s `byLine`, imported via
  // the job that already owns the ledger fold. Never a caller-supplied
  // number: settlement reads what actually happened, it does not trust what
  // it is told happened.
  const ledger = await getQualifyingUnits(input.campaignId);
  const qualifyingUnits = ledger.byLine[input.lineRef] ?? 0;

  const computation = computeTierRefund({
    paidPerUnitMinorUnits: input.paidPerUnitMinorUnits,
    finalPerUnitMinorUnits,
    qualifyingUnits,
  });

  const initialStatus: RefundStatus = computation.owed ? "pending" : "not_owed";

  try {
    const refund = await prisma.$transaction(async (tx) => {
      const created = await tx.groupBuyRefund.create({
        data: {
          campaignId: input.campaignId,
          masterVariantId: input.masterVariantId,
          orderRef: input.orderRef,
          lineRef: input.lineRef,
          customerRef: input.customerRef ?? null,
          paymentBasis: input.paymentBasis,
          paidPerUnitMinorUnits: input.paidPerUnitMinorUnits,
          finalPerUnitMinorUnits,
          qualifyingUnits,
          refundAmountMinorUnits: computation.totalRefundMinorUnits,
          currency: input.currency,
          status: initialStatus,
        },
      });
      await tx.groupBuyRefundEvent.create({
        data: {
          refundId: created.id,
          fromStatus: null,
          toStatus: initialStatus,
          actor: input.actor,
          reason: "tier-adjustment refund computed at campaign close",
          detail: `paid=${input.paidPerUnitMinorUnits} final=${finalPerUnitMinorUnits} units=${qualifyingUnits}`,
        },
      });
      return created;
    });
    return { refund, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Already computed for this line — read it back rather than recompute
      // and risk returning a different figure than the row that actually
      // exists. Same idiom as `recordLuxuryStealOrderCheck`.
      const existing = await prisma.groupBuyRefund.findUniqueOrThrow({
        where: { campaignId_lineRef: { campaignId: input.campaignId, lineRef: input.lineRef } },
      });
      return { refund: existing, created: false };
    }
    throw error;
  }
}

export type GroupBuyRefundTransitionInput =
  | { readonly to: "releasable"; readonly actor: string; readonly reason?: string; readonly releasedAt?: Date }
  | { readonly to: "processing"; readonly actor: string; readonly reason?: string }
  | {
      readonly to: "issued";
      readonly actor: string;
      readonly reason?: string;
      readonly processorReference: string;
      readonly issuedAt?: Date;
    }
  | { readonly to: "failed"; readonly actor: string; readonly reason?: string; readonly failureReason: string }
  | { readonly to: "not_owed"; readonly actor: string; readonly reason?: string };

/**
 * The only place a refund's status may change. `assertRefundTransition`
 * (imported, not re-derived) is checked BEFORE anything is written — an
 * illegal transition (most importantly, anything out of `issued`) is
 * refused as a typed error, never attempted against the database. The
 * database's own `group_buy_refund_issued_terminal` trigger and the CHECK
 * constraints requiring a reason/reference/timestamp for the relevant
 * statuses are the backstop against a caller that bypasses this function
 * entirely — not this function's normal path.
 */
export async function transitionGroupBuyRefundStatus(
  refundId: string,
  input: GroupBuyRefundTransitionInput
): Promise<GroupBuyRefund> {
  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: refundId } });
  if (!existing) throw new GroupBuyRefundNotFoundError(refundId);

  assertRefundTransition(existing.status, input.to);

  const data: Prisma.GroupBuyRefundUpdateInput = { status: input.to };
  if (input.to === "releasable") {
    data.releasedAt = input.releasedAt ?? new Date();
  } else if (input.to === "issued") {
    data.processorReference = input.processorReference;
    data.issuedAt = input.issuedAt ?? new Date();
  } else if (input.to === "failed") {
    data.failureReason = input.failureReason;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.groupBuyRefund.update({ where: { id: refundId }, data });
    await tx.groupBuyRefundEvent.create({
      data: {
        refundId,
        fromStatus: existing.status,
        toStatus: input.to,
        actor: input.actor,
        reason: input.reason ?? null,
        detail:
          input.to === "issued"
            ? input.processorReference
            : input.to === "failed"
              ? input.failureReason
              : null,
      },
    });
    return updated;
  });
}

export class GroupBuyRefundAlreadyIssuedError extends Error {
  constructor(readonly refundId: string) {
    super(`Refund ${refundId} is already issued; its amount and inputs are settled and cannot be overridden.`);
    this.name = "GroupBuyRefundAlreadyIssuedError";
  }
}

/**
 * Manual intervention on a refund — README §173 "overrides" / §189 "retain
 * manual override with audit history".
 *
 * OVERRIDES AN INPUT, NEVER THE AMOUNT DIRECTLY. The database's
 * `group_buy_refund_amount_matches_inputs` CHECK constraint holds
 * `refund_amount_minor_units = GREATEST(paid - final, 0) x qualifying_units`
 * at ALL times, with no exception for a manual correction — that
 * constraint's own comment says why: "a bug that computed it correctly and
 * then wrote the wrong value would be invisible in every unit test of the
 * calculation, because the calculation would be right." An override
 * therefore corrects `paidPerUnitMinorUnits` and/or `finalPerUnitMinorUnits`
 * — the FACTS the payout is computed from — and the amount is always
 * RECOMPUTED from them via `computeTierRefund` (imported, not re-derived),
 * so it can never disagree with the formula, overridden or not.
 *
 * Refused outright once the refund is `issued` — the database's own
 * `group_buy_refund_issued_terminal` trigger would refuse the write too
 * (money already moved; the settled figures do not change after the fact),
 * but this is the earlier, named refusal.
 */
export async function recordGroupBuyRefundOverride(
  refundId: string,
  override: {
    readonly overrideBy: string;
    readonly overrideReason: string;
    /** Corrected figure, if the paid amount was wrong. Omit to leave it as recorded. */
    readonly paidPerUnitMinorUnits?: bigint;
    /** Corrected figure, if the settled final price was wrong. Omit to leave it as recorded. */
    readonly finalPerUnitMinorUnits?: bigint;
    readonly overrideAt?: Date;
  }
): Promise<GroupBuyRefund> {
  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: refundId } });
  if (!existing) throw new GroupBuyRefundNotFoundError(refundId);
  if (existing.status === "issued") throw new GroupBuyRefundAlreadyIssuedError(refundId);

  const paidPerUnitMinorUnits = override.paidPerUnitMinorUnits ?? existing.paidPerUnitMinorUnits;
  const finalPerUnitMinorUnits = override.finalPerUnitMinorUnits ?? existing.finalPerUnitMinorUnits;
  const computation = computeTierRefund({
    paidPerUnitMinorUnits,
    finalPerUnitMinorUnits,
    qualifyingUnits: existing.qualifyingUnits,
  });

  return prisma.groupBuyRefund.update({
    where: { id: refundId },
    data: {
      paidPerUnitMinorUnits,
      finalPerUnitMinorUnits,
      refundAmountMinorUnits: computation.totalRefundMinorUnits,
      overrideBy: override.overrideBy,
      overrideReason: override.overrideReason,
      overrideAt: override.overrideAt ?? new Date(),
    },
  });
}

export interface GroupBuyRefundWithEvents extends GroupBuyRefund {
  readonly events: readonly GroupBuyRefundEvent[];
}

export async function getGroupBuyRefundForLine(
  campaignId: string,
  lineRef: string
): Promise<GroupBuyRefundWithEvents | null> {
  return prisma.groupBuyRefund.findUnique({
    where: { campaignId_lineRef: { campaignId, lineRef } },
    include: { events: { orderBy: { createdAt: "asc" } } },
  }) as Promise<GroupBuyRefundWithEvents | null>;
}

export async function listGroupBuyRefundsForCampaign(campaignId: string): Promise<readonly GroupBuyRefund[]> {
  return prisma.groupBuyRefund.findMany({ where: { campaignId }, orderBy: { computedAt: "asc" } });
}
