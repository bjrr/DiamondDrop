import { Prisma } from "@prisma/client";

import type { DemandSignalKind, DemandSignalSubmission } from "~/domain/groupbuy/demandSignal";

import { prisma } from "../client.server";
import { createAcknowledgment } from "./acknowledgmentRepository.server";

/**
 * Demand capture persistence — "Bring It Back" and "Request a New Group Buy".
 *
 * ============================================================================
 * A REPEATED SUBMISSION IS A SUCCESS, NOT AN ERROR
 * ============================================================================
 * Someone who clicks "notify me" twice, or refreshes the confirmation, has
 * asked the same question twice and should be told the same thing. So the
 * insert leans on the partial UNIQUE index
 * (`group_buy_demand_signal_one_per_campaign`) and treats a collision as
 * `already_registered` rather than propagating it.
 *
 * THE CONSTRAINT, NOT A PRE-CHECK. A read-then-write would let two concurrent
 * submissions of the same address both pass — and this is an unauthenticated
 * public endpoint, so concurrent duplicates are the normal case rather than a
 * rare race.
 *
 * ============================================================================
 * THE CALLER MUST NOT TELL THEM APART
 * ============================================================================
 * This function reports which happened because the caller needs it for
 * logging and for deciding whether to write an acknowledgment. The RESPONSE to
 * the customer must be identical either way: a public endpoint that answers
 * "already registered" differently is an oracle for whether a given address
 * is on file, and anyone can ask it about anyone.
 */

export type RecordDemandSignalOutcome = "recorded" | "already_registered";

export interface RecordDemandSignalInput {
  readonly submission: DemandSignalSubmission;
  /**
   * The acknowledgment to record for THIS submission, as INPUT rather than an
   * id — see below. Validated by `buildAcknowledgmentRecord`.
   */
  readonly acknowledgment: unknown;
}

/**
 * ============================================================================
 * ONE TRANSACTION, AND THE DUPLICATE ROLLS BACK BOTH WRITES
 * ============================================================================
 * This takes acknowledgment INPUT instead of an acknowledgment id, and that is
 * the whole point. `acknowledgment` is APPEND-ONLY at the database level, so a
 * row written for a submission that then collides on the dedup index could
 * never be removed — and this is an unauthenticated public endpoint, so
 * someone resubmitting (or a bot) would accumulate orphaned evidence rows
 * without limit, each one describing a submission that was never stored.
 *
 * Writing both inside one interactive transaction and letting the unique
 * violation escape it means the duplicate leaves nothing behind at all. The
 * collision is then caught OUTSIDE, after the rollback.
 */
export async function recordGroupBuyDemandSignal(
  input: RecordDemandSignalInput
): Promise<{ outcome: RecordDemandSignalOutcome; id: string | null }> {
  try {
    const id = await prisma.$transaction(async (tx) => {
      const acknowledgment = await createAcknowledgment(input.acknowledgment, tx);
      const created = await tx.groupBuyDemandSignal.create({
        data: {
          kind: input.submission.kind,
          email: input.submission.email,
          campaignRef: input.submission.campaignRef,
          note: input.submission.note,
          acknowledgmentId: acknowledgment.id,
        },
        select: { id: true },
      });
      return created.id;
    });
    return { outcome: "recorded", id };
  } catch (error) {
    // P2002 IS THE ONLY SWALLOWED ERROR, and only for the dedup index. A CHECK
    // violation (a malformed shape, an unnormalised email) is a real defect
    // and must surface — collapsing every database error into "already
    // registered" would hide exactly the bugs these constraints exist to
    // catch, and would report a lost submission as a success.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { outcome: "already_registered", id: null };
    }
    throw error;
  }
}

export interface DemandSignalRow {
  readonly id: string;
  readonly kind: DemandSignalKind;
  readonly email: string;
  readonly campaignRef: string | null;
  readonly note: string | null;
  readonly notifiedAt: Date | null;
  readonly notifiedBy: string | null;
  readonly createdAt: Date;
}

/**
 * Staff view, newest first. Optionally one kind, optionally one campaign, and
 * optionally only the outstanding ones — which is the operational question:
 * who still needs telling.
 */
export async function listGroupBuyDemandSignals(options?: {
  readonly kind?: DemandSignalKind;
  readonly campaignRef?: string;
  readonly outstandingOnly?: boolean;
  readonly limit?: number;
}): Promise<DemandSignalRow[]> {
  const rows = await prisma.groupBuyDemandSignal.findMany({
    where: {
      ...(options?.kind ? { kind: options.kind } : {}),
      ...(options?.campaignRef ? { campaignRef: options.campaignRef } : {}),
      ...(options?.outstandingOnly ? { notifiedAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 200,
    select: {
      id: true,
      kind: true,
      email: true,
      campaignRef: true,
      note: true,
      notifiedAt: true,
      notifiedBy: true,
      createdAt: true,
    },
  });
  return rows as DemandSignalRow[];
}

/** How many people are waiting to hear about a given past campaign. */
export async function countOutstandingBringItBack(campaignRef: string): Promise<number> {
  return prisma.groupBuyDemandSignal.count({
    where: { kind: "bring_it_back", campaignRef, notifiedAt: null },
  });
}

/**
 * Marks signals as notified, after staff actually sent something.
 *
 * ONLY EVER SETS THE FLAG, never clears it and never rewrites the captured
 * content. `notifiedAt` is the single reason this table is not append-only,
 * and keeping that the only mutation is what makes the rest of the row
 * trustworthy as evidence of what someone asked for.
 *
 * Returns the number actually transitioned — `updateMany` with
 * `notifiedAt: null` in the filter, so re-running after a partial failure
 * notifies nobody twice.
 */
export async function markGroupBuyDemandSignalsNotified(input: {
  readonly ids: readonly string[];
  readonly notifiedBy: string;
  readonly notifiedAt?: Date;
}): Promise<number> {
  const by = input.notifiedBy?.trim() ?? "";
  if (by.length === 0) {
    throw new Error("markGroupBuyDemandSignalsNotified requires an acting staff identity");
  }
  if (input.ids.length === 0) return 0;

  const result = await prisma.groupBuyDemandSignal.updateMany({
    where: { id: { in: [...input.ids] }, notifiedAt: null },
    data: { notifiedAt: input.notifiedAt ?? new Date(), notifiedBy: by },
  });
  return result.count;
}
