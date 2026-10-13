import { Prisma } from "@prisma/client";

import {
  decideCancellationOrderCheckOutcome,
  type GroupBuyCancellationOrderCheckOutcome,
} from "~/domain/groupbuy/cancellationOrderCheck";

import { prisma } from "../client.server";

/**
 * Group Buy cancellation-acknowledgment order-boundary evidence — the
 * database-facing half. Mirrors `luxuryStealRepository.server.ts`'s
 * order-check section deliberately (same append-only shape, same
 * (orderRef, lineRef) idempotency idiom). Pure decision logic lives in
 * `~/domain/groupbuy/cancellationOrderCheck.ts` and is unit-tested there with
 * no database; this file is the thin, integration-tested layer that turns
 * that decision into a committed row.
 */

export interface RecordGroupBuyOrderCancellationCheckInput {
  readonly orderRef: string;
  readonly lineRef: string;
  readonly campaignRef: string;
  readonly masterVariantId: string;
  /** The acknowledgment id `verifyCancellationAcknowledgment` found to fully match, or `null` — see `~/domain/groupbuy/cancellationOrderCheck` for why the outcome is derived from this rather than supplied separately. */
  readonly matchedAcknowledgmentId: string | null;
  /** Present iff `matchedAcknowledgmentId` is null — see that module's `CancellationAcknowledgmentMismatchReason`. */
  readonly mismatchReason: string | null;
  readonly checkedAt?: Date;
}

export interface RecordGroupBuyOrderCancellationCheckResult {
  readonly id: string;
  readonly outcome: GroupBuyCancellationOrderCheckOutcome;
  /** False when a row for this `(orderRef, lineRef)` already existed — a redelivered `orders/create`, not a new check. */
  readonly created: boolean;
}

/**
 * Records one (line, campaign) pair's order-time cancellation-acknowledgment
 * check outcome — matched or unmatched, always. IDEMPOTENT under redelivery:
 * relies on the `@@unique([orderRef, lineRef, campaignRef])` constraint to
 * let exactly one INSERT win — a concurrent duplicate delivery is read back
 * and returned as `created: false` rather than surfaced as an error, and
 * never produces a second row (so a redelivery can never count a second unit
 * for the same line either, since `recordUnitEvent`'s own independent
 * `(campaignId, externalRef)` uniqueness gates that — see the webhook
 * handler's own doc comment).
 */
export async function recordGroupBuyOrderCancellationCheck(
  input: RecordGroupBuyOrderCancellationCheckInput
): Promise<RecordGroupBuyOrderCancellationCheckResult> {
  const outcome = decideCancellationOrderCheckOutcome({ matchedAcknowledgmentId: input.matchedAcknowledgmentId });

  try {
    const created = await prisma.groupBuyOrderCancellationCheck.create({
      data: {
        orderRef: input.orderRef,
        lineRef: input.lineRef,
        campaignRef: input.campaignRef,
        masterVariantId: input.masterVariantId,
        matchedAcknowledgmentId: input.matchedAcknowledgmentId,
        mismatchReason: input.mismatchReason,
        outcome,
        checkedAt: input.checkedAt ?? new Date(),
      },
    });
    return { id: created.id, outcome: created.outcome, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.groupBuyOrderCancellationCheck.findUniqueOrThrow({
        where: {
          orderRef_lineRef_campaignRef: {
            orderRef: input.orderRef,
            lineRef: input.lineRef,
            campaignRef: input.campaignRef,
          },
        },
      });
      return { id: existing.id, outcome: existing.outcome, created: false };
    }
    throw error;
  }
}

export interface GroupBuyOrderCancellationCheckRecord {
  readonly id: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly campaignRef: string;
  readonly masterVariantId: string;
  readonly matchedAcknowledgmentId: string | null;
  readonly mismatchReason: string | null;
  readonly outcome: GroupBuyCancellationOrderCheckOutcome;
  readonly checkedAt: Date;
}

function toRecord(row: {
  id: string;
  orderRef: string;
  lineRef: string;
  campaignRef: string;
  masterVariantId: string;
  matchedAcknowledgmentId: string | null;
  mismatchReason: string | null;
  outcome: GroupBuyCancellationOrderCheckOutcome;
  checkedAt: Date;
}): GroupBuyOrderCancellationCheckRecord {
  return {
    id: row.id,
    orderRef: row.orderRef,
    lineRef: row.lineRef,
    campaignRef: row.campaignRef,
    masterVariantId: row.masterVariantId,
    matchedAcknowledgmentId: row.matchedAcknowledgmentId,
    mismatchReason: row.mismatchReason,
    outcome: row.outcome,
    checkedAt: row.checkedAt,
  };
}

/** The recorded check for one specific (line, campaign) pair, or `null` if it has never been checked. */
export async function getGroupBuyOrderCancellationCheck(
  orderRef: string,
  lineRef: string,
  campaignRef: string
): Promise<GroupBuyOrderCancellationCheckRecord | null> {
  const row = await prisma.groupBuyOrderCancellationCheck.findUnique({
    where: { orderRef_lineRef_campaignRef: { orderRef, lineRef, campaignRef } },
  });
  return row ? toRecord(row) : null;
}

/** Every recorded check for an order, oldest first — the webhook handler's own "did every Group Buy line already get checked on a prior delivery" read, and the audit read for staff reviewing a held order. */
export async function listGroupBuyOrderCancellationChecksForOrder(
  orderRef: string
): Promise<GroupBuyOrderCancellationCheckRecord[]> {
  const rows = await prisma.groupBuyOrderCancellationCheck.findMany({
    where: { orderRef },
    orderBy: { checkedAt: "asc" },
  });
  return rows.map(toRecord);
}

/** Every `unmatched` check, most recently checked first — the held-orders admin surface's read, mirroring `listUnmatchedLuxuryStealOrderChecks`. */
export async function listUnmatchedGroupBuyOrderCancellationChecks(): Promise<GroupBuyOrderCancellationCheckRecord[]> {
  const rows = await prisma.groupBuyOrderCancellationCheck.findMany({
    where: { outcome: "unmatched" },
    orderBy: { checkedAt: "desc" },
  });
  return rows.map(toRecord);
}
