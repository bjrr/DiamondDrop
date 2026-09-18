import type { GroupBuyRefundStatus } from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  assertRefundTransition,
  computeTierRefund,
  type RefundStatus,
} from "~/domain/groupbuy/refunds";
import { selectTier, tierPriceExact, type TierDefinition } from "~/domain/groupbuy/tiers";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import { logger } from "~/lib/logger.server";

/**
 * The Group Buy tier-adjustment refund ledger (README §173).
 *
 * TIMING, owner-confirmed: the amount is settled at CLOSE, HELD through
 * production and QC, and processed at SHIPPING. Those are three distinct
 * moments and the ledger models them as three states rather than one
 * "unpaid" — because between close and shipping we owe a customer money and
 * that obligation has to be visible, not implied by the absence of a payment.
 *
 * WHAT MAKES DUPLICATE PAYMENT IMPOSSIBLE, since §371 requires it:
 *
 *   1. one row per line item, by unique key — a second computation cannot
 *      create a second payable row;
 *   2. `issued` is terminal in the domain's transition table;
 *   3. a database trigger refuses to move an issued refund anywhere else, so
 *      the guarantee survives a script that bypasses this module entirely.
 *
 * Three layers because this is the one place in the system where a mistake
 * sends real money out twice.
 */

export class RefundNotFoundError extends Error {
  constructor(id: string) {
    super(`Refund ${id} not found.`);
    this.name = "RefundNotFoundError";
  }
}

export class CampaignNotClosedError extends Error {
  constructor(id: string, status: string) {
    super(
      `Campaign ${id} is ${status}; refunds are computed at close, once the final tier is locked.`
    );
    this.name = "CampaignNotClosedError";
  }
}

/** What a customer paid for one line, supplied by the order system. */
export interface PaidLineInput {
  masterVariantId: string;
  orderRef: string;
  lineRef: string;
  customerRef?: string;
  /** Price actually charged per unit at checkout, whole minor units. */
  paidPerUnitMinorUnits: bigint;
  /** Units still qualifying on this line at close. */
  qualifyingUnits: number;
}

export interface ComputeRefundsResult {
  campaignId: string;
  created: number;
  /** Already present — a recomputation is a no-op, not a second payment. */
  skipped: number;
  owedCount: number;
  totalOwedMinorUnits: bigint;
}

/**
 * Computes the refund due on each line, once, at close.
 *
 * Idempotent: a line that already has a refund row is skipped rather than
 * recomputed. Re-running after a partial failure therefore finishes the job
 * instead of doubling it.
 */
export async function computeRefundsAtClose(options: {
  campaignId: string;
  paidLines: readonly PaidLineInput[];
  computedBy: string;
}): Promise<ComputeRefundsResult> {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: options.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  // Refunds depend on the FINAL tier, which only exists once the count is
  // locked. Computing earlier would settle against a tier that can still move.
  if (campaign.status !== "closed" || campaign.finalTierNumber === null) {
    throw new CampaignNotClosedError(campaign.id, campaign.status);
  }

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));
  const finalTier = selectTier(tiers, campaign.finalQualifyingUnits ?? 0);

  let created = 0;
  let skipped = 0;
  let owedCount = 0;
  let totalOwed = 0n;

  for (const line of options.paidLines) {
    const eligible = campaign.variants.find((v) => v.masterVariantId === line.masterVariantId);
    if (!eligible) {
      throw new Error(
        `Line ${line.lineRef} references variant ${line.masterVariantId}, which is not eligible for campaign ${campaign.id}.`
      );
    }

    // The final price is derived from the FROZEN base, through the same
    // rounding and price-ending path a customer would have been charged at.
    // Re-deriving it from today's costs would refund against a price that never
    // existed.
    const exact = tierPriceExact(
      new MoneyDecimal(eligible.frozenBasePriceMinorUnits.toString()),
      finalTier
    );
    const rounded = Money.fromDecimalMinorUnits(exact, campaign.currency, "HALF_UP_MINOR_UNIT_V1");
    const finalPerUnit = applyPriceEnding(rounded.amountMinorUnits, "WHOLE_DOLLAR_UP_V1");

    const computation = computeTierRefund({
      paidPerUnitMinorUnits: line.paidPerUnitMinorUnits,
      finalPerUnitMinorUnits: finalPerUnit,
      qualifyingUnits: line.qualifyingUnits,
    });

    const existing = await prisma.groupBuyRefund.findUnique({
      where: { campaignId_lineRef: { campaignId: campaign.id, lineRef: line.lineRef } },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const status: GroupBuyRefundStatus = computation.owed ? "pending" : "not_owed";

    await prisma.$transaction(async (tx) => {
      const refund = await tx.groupBuyRefund.create({
        data: {
          campaignId: campaign.id,
          masterVariantId: line.masterVariantId,
          orderRef: line.orderRef,
          lineRef: line.lineRef,
          customerRef: line.customerRef ?? null,
          paidPerUnitMinorUnits: line.paidPerUnitMinorUnits,
          finalPerUnitMinorUnits: finalPerUnit,
          qualifyingUnits: line.qualifyingUnits,
          refundAmountMinorUnits: computation.totalRefundMinorUnits,
          currency: campaign.currency,
          status,
        },
      });

      await tx.groupBuyRefundEvent.create({
        data: {
          refundId: refund.id,
          fromStatus: null,
          toStatus: status,
          actor: options.computedBy,
          reason: computation.owed
            ? "tier adjustment owed at campaign close"
            : computation.finalPriceExceededPaid
              ? "final tier price exceeded the price paid; nothing owed and nothing charged"
              : "final price equalled the price paid",
        },
      });
    });

    created += 1;
    if (computation.owed) {
      owedCount += 1;
      totalOwed += computation.totalRefundMinorUnits;
    }
  }

  logger.info("groupbuy.refunds_computed", {
    campaignId: campaign.id,
    finalTierNumber: finalTier.tierNumber,
    created,
    skipped,
    owedCount,
    // No amounts in logs (criterion 30).
  });

  return {
    campaignId: campaign.id,
    created,
    skipped,
    owedCount,
    totalOwedMinorUnits: totalOwed,
  };
}

/** Records a transition, enforcing the domain's state machine and the history. */
async function transition(options: {
  refundId: string;
  to: RefundStatus;
  actor: string;
  reason?: string;
  detail?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  const refund = await prisma.groupBuyRefund.findUnique({ where: { id: options.refundId } });
  if (!refund) throw new RefundNotFoundError(options.refundId);

  // Throws on an illegal move — including any attempt to leave `issued`.
  assertRefundTransition(refund.status as RefundStatus, options.to);

  await prisma.$transaction(async (tx) => {
    await tx.groupBuyRefund.update({
      where: { id: options.refundId },
      data: { status: options.to as GroupBuyRefundStatus, ...(options.data ?? {}) },
    });
    await tx.groupBuyRefundEvent.create({
      data: {
        refundId: options.refundId,
        fromStatus: refund.status,
        toStatus: options.to as GroupBuyRefundStatus,
        actor: options.actor,
        reason: options.reason ?? null,
        detail: options.detail ?? null,
      },
    });
  });
}

/**
 * Releases the hold when the item ships — the owner's "process at shipping".
 *
 * Deliberately separate from actually paying. Shipping makes a refund PAYABLE;
 * it does not pay it. Collapsing the two would mean a processor outage during a
 * shipment silently lost the obligation.
 */
export async function releaseRefundForShipping(options: {
  refundId: string;
  actor: string;
  shippedAt?: Date;
}): Promise<void> {
  await transition({
    refundId: options.refundId,
    to: "releasable",
    actor: options.actor,
    reason: "item shipped; hold through production/QC ended",
    data: { releasedAt: options.shippedAt ?? new Date() },
  });
}

/** Hands the refund to the processor. */
export async function beginRefundProcessing(options: {
  refundId: string;
  actor: string;
}): Promise<void> {
  await transition({ refundId: options.refundId, to: "processing", actor: options.actor });
}

/** The money went out. TERMINAL — the processor reference is required. */
export async function markRefundIssued(options: {
  refundId: string;
  actor: string;
  processorReference: string;
  issuedAt?: Date;
}): Promise<void> {
  if (!options.processorReference.trim()) {
    // An issued refund with no reference cannot be reconciled against the
    // processor, which makes "did we actually pay this?" unanswerable.
    throw new Error("A processor reference is required to mark a refund issued.");
  }

  await transition({
    refundId: options.refundId,
    to: "issued",
    actor: options.actor,
    detail: options.processorReference,
    data: { processorReference: options.processorReference, issuedAt: options.issuedAt ?? new Date() },
  });
}

/** The processor rejected it. Retryable — returns to `releasable`. */
export async function markRefundFailed(options: {
  refundId: string;
  actor: string;
  failureReason: string;
}): Promise<void> {
  await transition({
    refundId: options.refundId,
    to: "failed",
    actor: options.actor,
    reason: options.failureReason,
    data: { failureReason: options.failureReason },
  });
}

/** Full history for one refund, oldest first — the §173 audit trail. */
export async function getRefundHistory(refundId: string) {
  return prisma.groupBuyRefundEvent.findMany({
    where: { refundId },
    orderBy: { createdAt: "asc" },
  });
}
