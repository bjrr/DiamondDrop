import type { GroupBuyRefund, GroupBuyRefundStatus, PaymentBasis } from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  assertRefundTransition,
  computeTierRefund,
  type RefundStatus,
} from "~/domain/groupbuy/refunds";
import { selectTier, tierBankPaymentPriceExact, type TierDefinition } from "~/domain/groupbuy/tiers";
import { getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import { applyPriceEnding } from "~/domain/pricing/priceEnding";
import type {
  PriceEndingRuleId,
  RegularCardPriceRuleId,
} from "~/domain/pricing/types";
import type { RoundingRuleId } from "~/domain/money/rounding";
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

/**
 * OWNER DECISION (Group Buy settlement approval gating, 2026-09-28): "the
 * system calculates refunds, admin explicitly approves/processes them." A
 * refund that has not been through `approveGroupBuyRefund` must never reach
 * `processing` — thrown here as a fast, typed failure BEFORE any write is
 * attempted, mirroring `RmaRemedyIllegalStateError`'s "refused, not
 * recorded" discipline. This is defense in depth, not the primary guarantee:
 * even a caller that skips this check is refused at the database by
 * `group_buy_refund_requires_approval_before_processing`
 * (migration `20260928020000_group_buy_refund_approval_gate`).
 */
export class RefundNotApprovedError extends Error {
  constructor(readonly refundId: string) {
    super(
      `Refund ${refundId}: cannot begin processing — a staff reviewer must approve this refund first (see approveGroupBuyRefund).`
    );
    this.name = "RefundNotApprovedError";
  }
}

export class RefundActorRequiredError extends Error {
  constructor() {
    super("A staff actor reference is required to approve a Group Buy refund.");
    this.name = "RefundActorRequiredError";
  }
}

/** What a customer paid for one line, supplied by the order system. */
export interface PaidLineInput {
  masterVariantId: string;
  orderRef: string;
  lineRef: string;
  customerRef?: string;
  /**
   * WHICH PRICE THE CUSTOMER PAID. Required, with no default, because there is
   * no safe guess: a card line and a bank line at the same tier were charged
   * amounts 5% apart, and the refund is computed against whichever it was.
   */
  paymentBasis: PaymentBasis;
  /** Price actually charged per unit at checkout, whole minor units, in `paymentBasis`. */
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
/**
 * Derives ONE variant's final per-unit price at the campaign's LOCKED final
 * tier, in the requested payment basis, through the FROZEN bank-in/round/
 * end/card-derive pipeline — the exact rule and order
 * `app/domain/bankpayment/groupBuyTierPrice.ts`'s own header names as the
 * one this codebase must never fork a fourth copy of. Extracted from
 * `computeRefundsAtClose`'s own per-line loop (architect decision, Group Buy
 * settlement override follow-up, 2026-09-28) so
 * `recordGroupBuyRefundForUnresolvedLine` below can reuse the identical
 * derivation rather than becoming a third divergent copy of its own.
 */
function deriveFrozenFinalPerUnitMinorUnits(options: {
  currency: string;
  finalTier: TierDefinition;
  frozenProfile: {
    roundingRuleId: string;
    priceEndingRuleId: string;
    fixedCardUpliftRate: { toString(): string };
    regularCardPriceRuleId: string;
  };
  frozenBaseBankPaymentPriceMinorUnits: bigint;
  paymentBasis: PaymentBasis;
}): bigint {
  const exactBankPayment = tierBankPaymentPriceExact(
    new MoneyDecimal(options.frozenBaseBankPaymentPriceMinorUnits.toString()),
    options.finalTier
  );
  const rounded = Money.fromDecimalMinorUnits(
    exactBankPayment,
    options.currency,
    options.frozenProfile.roundingRuleId as RoundingRuleId
  );
  const finalBankPaymentPerUnit = applyPriceEnding(
    rounded.amountMinorUnits,
    options.frozenProfile.priceEndingRuleId as PriceEndingRuleId
  );

  return options.paymentBasis === "card"
    ? deriveRegularCardPrice(
        finalBankPaymentPerUnit,
        new MoneyDecimal(options.frozenProfile.fixedCardUpliftRate.toString()),
        options.frozenProfile.regularCardPriceRuleId as RegularCardPriceRuleId
      ).regularCardPriceMinorUnits
    : finalBankPaymentPerUnit;
}

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

  // The uplift rate the campaign FROZE, not today's. A card customer is refunded
  // against the card price they were actually quoted, and that price was fixed
  // when the campaign opened. Reading the current profile would silently
  // re-price a settled obligation if the rate had since changed.
  const frozenProfile = campaign.pricingProfileId
    ? await prisma.pricingProfile.findUniqueOrThrow({ where: { id: campaign.pricingProfileId } })
    : null;
  if (!frozenProfile) {
    throw new CampaignNotClosedError(campaign.id, `${campaign.status} without a frozen profile`);
  }

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
    // rounding/price-ending/card-derive pipeline a customer would have been
    // charged at (`deriveFrozenFinalPerUnitMinorUnits`, above) — matched to
    // the BASIS THE CUSTOMER PAID IN, because the tier price is a Bank
    // Payment Price and subtracting it from what a CARD customer paid would
    // treat the whole uplift as an overcharge and hand it back — 3-5% of the
    // order, on every card line, at every tier drop.
    const finalPerUnit = deriveFrozenFinalPerUnitMinorUnits({
      currency: campaign.currency,
      finalTier,
      frozenProfile,
      frozenBaseBankPaymentPriceMinorUnits: eligible.frozenBaseBankPaymentPriceMinorUnits,
      paymentBasis: line.paymentBasis,
    });

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
          paymentBasis: line.paymentBasis,
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

export class GroupBuyRefundLineAlreadyResolvedError extends Error {
  constructor(
    readonly campaignId: string,
    readonly lineRef: string
  ) {
    super(
      `Campaign ${campaignId} line ${lineRef} already has a computed refund. ` +
        `This function exists only for a line computeRefundsAtClose could not resolve; ` +
        `use recordGroupBuyRefundOverride to correct an existing one instead.`
    );
    this.name = "GroupBuyRefundLineAlreadyResolvedError";
  }
}

export interface RecordUnresolvedGroupBuyRefundLineInput {
  readonly campaignId: string;
  readonly masterVariantId: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef?: string | null;
  /** Established by staff from Shopify Admin directly — this function never derives or guesses it. */
  readonly paymentBasis: PaymentBasis;
  readonly paidPerUnitMinorUnits: bigint;
  readonly recordedBy: string;
  readonly reason: string;
}

/**
 * Creates the `GroupBuyRefund` row for a line `computeRefundsAtClose` could
 * not resolve automatically — the gap the architect identified from
 * `campaignSettlement.server.ts`'s own `gatherGroupBuyPaidLinesForClose`
 * honestly reporting such a line as `unresolved` rather than guessing: an
 * `unresolved` line never gets a row at all, so
 * `recordGroupBuyRefundOverride` (which requires an existing `refundId`)
 * cannot help it. This function is the missing first step — creating the
 * row `recordGroupBuyRefundOverride` can later correct, if it is ever wrong.
 *
 * STAFF SUPPLY ONE FACT — `paidPerUnitMinorUnits`, established from Shopify
 * Admin directly — EVERYTHING ELSE IS DERIVED, exactly as the normal
 * close-time path derives it:
 *   - the final per-unit price, through `deriveFrozenFinalPerUnitMinorUnits`
 *     (the SAME frozen bank-in/round/end/card-derive pipeline
 *     `computeRefundsAtClose` uses — imported, not re-derived, so this can
 *     never become a third divergent formula);
 *   - the qualifying-unit count, read from the unit ledger itself
 *     (`getQualifyingUnits`), never trusted from a caller — the same
 *     "settlement reads what actually happened" discipline
 *     `recordGroupBuyTierRefund` used before the consolidation;
 *   - the refund amount, through `computeTierRefund` — there is no
 *     parameter anywhere in this function's signature for the refund amount
 *     itself, and the zero-floor applies exactly as it does everywhere else.
 *
 * LANDS IN `pending` (owed) OR `not_owed` (nothing owed) — THE SAME RULE
 * `computeRefundsAtClose` uses, never unconditionally `pending`: forcing
 * `pending` regardless of the computed amount would put a $0 row in a
 * payable status and would violate the database's own
 * `group_buy_refund_not_owed_has_zero_amount` CHECK the moment the amount is
 * genuinely zero. Either way, the row starts UNAPPROVED — `approvedAt`/
 * `approvedByActorRef` are not set anywhere in this function, so
 * `beginRefundProcessing` refuses it exactly as it would any other freshly
 * computed refund, and a staff reviewer must call `approveGroupBuyRefund`
 * before any money can move.
 *
 * IMPOSSIBLE TO USE ON A LINE THAT DID RESOLVE, structurally, not just by
 * convention: checked explicitly here (refuses with
 * `GroupBuyRefundLineAlreadyResolvedError` before any write, the same
 * "refused, not recorded" discipline as every other precondition in this
 * file) AND backstopped by `GroupBuyRefund`'s own
 * `@@unique([campaignId, lineRef])` — a race that slipped past the earlier
 * check hits that constraint on `create` and throws rather than silently
 * creating a second, conflicting figure for a line that already had one.
 * Deliberately NOT idempotent-skip like `computeRefundsAtClose`'s own
 * duplicate handling: a second call here for an already-resolved line is a
 * caller error (this function is for a line the automated path never
 * touched), not a legitimate retry.
 *
 * EVIDENCE. Recorded via the SAME `overrideBy`/`overrideReason`/`overrideAt`
 * columns `recordGroupBuyRefundOverride` uses — this row's very existence is
 * a manual intervention (its figure never came from `computeRefundsAtClose`
 * at all), so recording it as one from the moment of creation, rather than
 * inventing a parallel set of "manually created" columns, keeps a single
 * place staff and any later audit look for "was this figure computed
 * automatically or established by a person, and why".
 */
export async function recordGroupBuyRefundForUnresolvedLine(
  input: RecordUnresolvedGroupBuyRefundLineInput
): Promise<GroupBuyRefund> {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });
  if (campaign.status !== "closed" || campaign.finalTierNumber === null) {
    throw new CampaignNotClosedError(input.campaignId, campaign.status);
  }

  const alreadyResolved = await prisma.groupBuyRefund.findUnique({
    where: { campaignId_lineRef: { campaignId: input.campaignId, lineRef: input.lineRef } },
  });
  if (alreadyResolved) {
    throw new GroupBuyRefundLineAlreadyResolvedError(input.campaignId, input.lineRef);
  }

  const variant = campaign.variants.find((v) => v.masterVariantId === input.masterVariantId);
  if (!variant) {
    throw new Error(
      `Line ${input.lineRef} references variant ${input.masterVariantId}, which is not eligible for campaign ${campaign.id}.`
    );
  }
  if (!campaign.pricingProfileId) {
    throw new Error(`Campaign ${input.campaignId} has no frozen pricing profile; it cannot have opened validly.`);
  }
  const frozenProfile = await prisma.pricingProfile.findUniqueOrThrow({ where: { id: campaign.pricingProfileId } });

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));
  const finalTier = selectTier(tiers, campaign.finalQualifyingUnits ?? 0);

  const finalPerUnitMinorUnits = deriveFrozenFinalPerUnitMinorUnits({
    currency: campaign.currency,
    finalTier,
    frozenProfile,
    frozenBaseBankPaymentPriceMinorUnits: variant.frozenBaseBankPaymentPriceMinorUnits,
    paymentBasis: input.paymentBasis,
  });

  const ledger = await getQualifyingUnits(input.campaignId);
  const qualifyingUnits = ledger.byLine[input.lineRef] ?? 0;

  const computation = computeTierRefund({
    paidPerUnitMinorUnits: input.paidPerUnitMinorUnits,
    finalPerUnitMinorUnits,
    qualifyingUnits,
  });

  const status: RefundStatus = computation.owed ? "pending" : "not_owed";
  const recordedAt = new Date();

  return prisma.$transaction(async (tx) => {
    const refund = await tx.groupBuyRefund.create({
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
        currency: campaign.currency,
        status,
        overrideBy: input.recordedBy,
        overrideReason: input.reason,
        overrideAt: recordedAt,
      },
    });
    await tx.groupBuyRefundEvent.create({
      data: {
        refundId: refund.id,
        fromStatus: null,
        toStatus: status,
        actor: input.recordedBy,
        reason: input.reason,
        detail: "manually recorded for a line computeRefundsAtClose could not resolve automatically",
      },
    });
    return refund;
  });
}

/**
 * Records a transition, enforcing the domain's state machine and the
 * history. Returns the updated row — every internal caller in this file
 * that only cares about the status change ignores it; `recordGroupBuyRefundOverride`
 * needs it to hand back the corrected-and-possibly-reopened row.
 */
async function transition(options: {
  refundId: string;
  to: RefundStatus;
  actor: string;
  reason?: string;
  detail?: string;
  data?: Record<string, unknown>;
}): Promise<GroupBuyRefund> {
  const refund = await prisma.groupBuyRefund.findUnique({ where: { id: options.refundId } });
  if (!refund) throw new RefundNotFoundError(options.refundId);

  // Throws on an illegal move — including any attempt to leave `issued`.
  assertRefundTransition(refund.status as RefundStatus, options.to);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.groupBuyRefund.update({
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
    return updated;
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

/**
 * Grants the explicit staff approval that `beginRefundProcessing` now
 * requires before any money can move (owner decision, see
 * `RefundNotApprovedError`'s own comment). Records a reviewer identity and
 * timestamp as the refund's OWN fact (`approvedAt`/`approvedByActorRef`),
 * never inferred from `computeRefundsAtClose` or `releaseRefundForShipping`.
 *
 * IDEMPOTENT, DELIBERATELY, ON REPEAT APPROVAL: a refund already approved (or
 * further along — `processing`/`issued`/`failed`) is returned UNCHANGED
 * rather than re-validated, so a double-submitted "Approve" click issues
 * money at most once — the second call is a read-only no-op that neither
 * re-writes the approval columns nor appends a second approval event. Mirrors
 * `approveRmaRemedy`'s identical reasoning
 * (`app/db/repositories/rmaRepository.server.ts`).
 *
 * Legal from `pending`, `releasable`, or `not_owed` — approval is granted
 * whenever staff choose to grant it (e.g. ahead of shipping, so processing
 * can begin the instant the hold releases), never gated on the refund's own
 * status. It grants AUTHORIZATION to move money later; it does not move any
 * money itself, and does not change `status`.
 */
export async function approveGroupBuyRefund(options: {
  refundId: string;
  actor: string;
  reason?: string;
  at?: Date;
}): Promise<GroupBuyRefund> {
  if (!options.actor.trim()) throw new RefundActorRequiredError();

  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: options.refundId } });
  if (!existing) throw new RefundNotFoundError(options.refundId);

  if (existing.approvedAt) {
    // Already approved — nothing to do, nothing to record a second time.
    return existing;
  }

  const approvedAt = options.at ?? new Date();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.groupBuyRefund.update({
      where: { id: options.refundId },
      data: { approvedAt, approvedByActorRef: options.actor },
    });
    await tx.groupBuyRefundEvent.create({
      data: {
        refundId: options.refundId,
        // Not a status transition — approval authorizes a LATER transition,
        // it is not one itself. Same "fromStatus === toStatus, the
        // substantive fact lives in reason/detail" convention `approveRmaRemedy`
        // uses for its own non-status-transition approval event.
        fromStatus: existing.status,
        toStatus: existing.status,
        actor: options.actor,
        reason: options.reason ?? "refund approved for processing",
      },
    });
    return updated;
  });
}

/**
 * Hands the refund to the processor. REFUSES if the refund has not been
 * explicitly approved by a staff reviewer (owner decision — see
 * `RefundNotApprovedError`).
 */
export async function beginRefundProcessing(options: {
  refundId: string;
  actor: string;
}): Promise<void> {
  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: options.refundId } });
  if (!existing) throw new RefundNotFoundError(options.refundId);
  if (!existing.approvedAt) {
    throw new RefundNotApprovedError(options.refundId);
  }

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

/**
 * Every refund row for a campaign, oldest first — the settlement view's data
 * source. A pure read, no business logic; moved here (rather than depended on
 * from `groupBuyRepository.server.ts`'s duplicate implementation, which the
 * architect has since ruled is being retired) so this module stays the single
 * home for Group Buy refund reads and writes alike.
 */
export async function listGroupBuyRefundsForCampaign(campaignId: string): Promise<readonly GroupBuyRefund[]> {
  return prisma.groupBuyRefund.findMany({ where: { campaignId }, orderBy: { computedAt: "asc" } });
}

export class GroupBuyRefundAlreadyIssuedError extends Error {
  constructor(readonly refundId: string) {
    super(`Refund ${refundId} is already issued; its amount and inputs are settled and cannot be overridden.`);
    this.name = "GroupBuyRefundAlreadyIssuedError";
  }
}

/**
 * Distinct from `GroupBuyRefundAlreadyIssuedError` on purpose — money has
 * not necessarily moved yet, but a Shopify call may be in flight or its
 * outcome not yet reconciled (see `executeGroupBuyRefund.server.ts`'s own
 * in-doubt handling). Correcting the facts underneath a row while that is
 * happening could leave the eventual `markRefundIssued`/`markRefundFailed`
 * write recording an amount that was never what was actually sent to
 * Shopify. Refused outright, same "refused, not recorded" discipline as
 * every other precondition in this file — staff can correct the facts once
 * the attempt resolves to `releasable` (failed) or `issued` (refused
 * separately, permanently).
 */
export class GroupBuyRefundProcessingError extends Error {
  constructor(readonly refundId: string) {
    super(`Refund ${refundId} is currently processing; its facts cannot be corrected until that attempt resolves.`);
    this.name = "GroupBuyRefundProcessingError";
  }
}

export interface GroupBuyRefundOverrideInput {
  readonly overrideBy: string;
  readonly overrideReason: string;
  /** Corrected figure, if the paid amount was wrong. Omit to leave it as recorded. */
  readonly paidPerUnitMinorUnits?: bigint;
  /** Corrected figure, if the settled final price was wrong. Omit to leave it as recorded. */
  readonly finalPerUnitMinorUnits?: bigint;
  readonly overrideAt?: Date;
}

/**
 * Manual intervention on a refund (README §173 "overrides" / §189 "retain
 * manual override with audit history"). Moved here from
 * `groupBuyRepository.server.ts` during the Group Buy refund-ledger
 * consolidation (architect decision, 2026-09-28): refund computation and
 * lifecycle are business logic and belong in the dedicated settlement
 * module, not a data-access repository — this file is now the single home
 * for both. Behaviour preserved exactly from the original.
 *
 * WHY THIS SURVIVED THE CONSOLIDATION rather than being deleted with the
 * rest, restated because it is the whole reason it is worth keeping: a
 * Card-basis line's paid price is not always resolvable automatically
 * (`campaignSettlement.server.ts`'s `gatherGroupBuyPaidLinesForClose`
 * honestly surfaces such a line as `unresolved` rather than guessing a
 * price). Staff establish the true paid figure from Shopify Admin directly,
 * and this function — and the settlement route's "Correct facts" action
 * built on it — is how they record it.
 *
 * OVERRIDES AN INPUT, NEVER THE AMOUNT DIRECTLY — the property the architect
 * approved this capability for on review. The database's
 * `group_buy_refund_amount_matches_inputs` CHECK constraint holds
 * `refund_amount_minor_units = GREATEST(paid - final, 0) x qualifying_units`
 * at ALL times, with no exception for a manual correction — that
 * constraint's own comment says why: "a bug that computed it correctly and
 * then wrote the wrong value would be invisible in every unit test of the
 * calculation, because the calculation would be right." So this function
 * corrects `paidPerUnitMinorUnits` and/or `finalPerUnitMinorUnits` — the
 * FACTS the payout is computed from — and the amount is always RECOMPUTED
 * from them via `computeTierRefund` (imported, not re-derived), so it can
 * never disagree with the formula, overridden or not. There is no parameter
 * anywhere in this function's signature for the refund amount itself, and
 * `computeTierRefund`'s own zero-floor applies exactly as it does at initial
 * computation — an override can no more turn a refund into a charge than
 * `computeRefundsAtClose` can.
 *
 * NEVER BYPASSES THE APPROVAL GATE. This function does not read, write, or
 * even reference `approvedAt`/`approvedByActorRef` anywhere in its body — an
 * override corrects what a refund IS OWED, not whether staff have authorized
 * paying it. A refund overridden before approval still requires
 * `approveGroupBuyRefund` before `beginRefundProcessing` will accept it
 * (unchanged, and structurally unchangeable, by this function); a refund
 * already approved keeps that approval untouched (and the write-once
 * `group_buy_refund_approval_guard` database trigger would refuse a write
 * that tried to clear it even if this function attempted to, which it does
 * not) — true even when the correction reopens a `not_owed` row (below):
 * `not_owed -> pending` is a status change, never an approval grant.
 *
 * Refused outright once the refund is `issued` (`GroupBuyRefundAlreadyIssuedError`
 * — the database's own `group_buy_refund_issued_terminal` trigger would
 * refuse the write too, money already moved) or while it is `processing`
 * (`GroupBuyRefundProcessingError` — see that error's own comment).
 *
 * CROSSES THE OWED/NOT-OWED BOUNDARY WHEN THE CORRECTED FACTS CROSS IT
 * (architect decision, Group Buy settlement override follow-up, 2026-09-28),
 * in BOTH directions, using the exact same `transition()` helper (and
 * therefore the exact same `assertRefundTransition` check) every other
 * status change in this module goes through — this function gains no
 * shortcut a future caller could exploit:
 *
 *   - `not_owed -> pending`: the corrected facts reveal money IS owed after
 *     all. Without this, a wrongly-`not_owed` refund is a customer who is
 *     owed money and structurally cannot be paid — see
 *     `app/domain/groupbuy/refunds.ts`'s `ALLOWED["not_owed"]` for the full
 *     reasoning and the database CHECK constraint that backstops it.
 *   - `pending`/`releasable`/`failed` -> `not_owed`: the mirror image — the
 *     corrected facts reveal NOTHING is owed after all. This uses edges the
 *     domain table already allowed (a refund could already reach `not_owed`
 *     from any of these three); what was missing before this follow-up was
 *     this function ever actually taking them; a refund's status simply sat
 *     unchanged while its amount silently became zero. Fixed for symmetry
 *     with the forward case, and because a "payable" refund of $0 sitting in
 *     `pending`/`releasable` is exactly the shape a later processing attempt
 *     would waste a real Shopify call on for no reason.
 *
 * When neither boundary is crossed (the correction changes the figures but
 * not whether anything is owed), this function updates the row directly —
 * `pending`/`releasable`/`failed` and (already refused above) `issued`/
 * `processing` never need their status touched by a correction that keeps
 * them on the same side of that line.
 */
export async function recordGroupBuyRefundOverride(
  refundId: string,
  override: GroupBuyRefundOverrideInput
): Promise<GroupBuyRefund> {
  const existing = await prisma.groupBuyRefund.findUnique({ where: { id: refundId } });
  if (!existing) throw new RefundNotFoundError(refundId);
  if (existing.status === "issued") throw new GroupBuyRefundAlreadyIssuedError(refundId);
  if (existing.status === "processing") throw new GroupBuyRefundProcessingError(refundId);

  const paidPerUnitMinorUnits = override.paidPerUnitMinorUnits ?? existing.paidPerUnitMinorUnits;
  const finalPerUnitMinorUnits = override.finalPerUnitMinorUnits ?? existing.finalPerUnitMinorUnits;
  const computation = computeTierRefund({
    paidPerUnitMinorUnits,
    finalPerUnitMinorUnits,
    qualifyingUnits: existing.qualifyingUnits,
  });

  const data = {
    paidPerUnitMinorUnits,
    finalPerUnitMinorUnits,
    refundAmountMinorUnits: computation.totalRefundMinorUnits,
    overrideBy: override.overrideBy,
    overrideReason: override.overrideReason,
    overrideAt: override.overrideAt ?? new Date(),
  };

  const wasOwed = existing.status !== "not_owed";
  if (computation.owed && !wasOwed) {
    // not_owed -> pending: corrected facts reveal money IS owed after all.
    return transition({
      refundId,
      to: "pending",
      actor: override.overrideBy,
      reason: override.overrideReason,
      data,
    });
  }
  if (!computation.owed && wasOwed) {
    // pending/releasable/failed -> not_owed: corrected facts reveal NOTHING
    // is owed after all — the mirror of the case above, over edges the
    // domain table already allowed (see this function's own header).
    return transition({
      refundId,
      to: "not_owed",
      actor: override.overrideBy,
      reason: override.overrideReason,
      data,
    });
  }

  // No owed/not-owed boundary crossed — same status, corrected figures.
  return prisma.groupBuyRefund.update({ where: { id: refundId }, data });
}
