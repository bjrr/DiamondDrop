import { Prisma } from "@prisma/client";
import type { BeatQuoteRedemptionIntent } from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  evaluateFallbackRedeemability,
  type BeatQuoteRedemptionSurface,
  type FallbackRefusal,
} from "~/domain/beatyourquote/fallbackBenefit";
import {
  quoteRedemption,
  RedemptionCalculationError,
  type RedemptionLineInput,
} from "~/domain/beatyourquote/redemptionCalculation";
import { Money } from "~/domain/money/money";
import { logger } from "~/lib/logger.server";

/**
 * Reserving, completing and releasing a fallback-benefit redemption.
 *
 * ============================================================================
 * WHY A RESERVATION EXISTS AT ALL
 * ============================================================================
 * Owner decision: redemption goes through a CaratForUs-controlled Draft Order
 * rather than a generic Shopify discount code, so the exact benefit amount is
 * calculated server-side before checkout. That leaves a gap — the draft order
 * exists, the customer has not paid — during which the benefit must be unusable
 * elsewhere without being spent.
 *
 * Spending it at draft creation consumes it on an abandoned checkout. Spending
 * it only at payment lets two simultaneous checkouts both carry the discount.
 * So the gap is a row with a lifecycle, and the partial UNIQUE indexes on
 * `beat_quote_redemption_intent` are the actual concurrency boundary: one
 * `reserved` and one `completed` per benefit, whatever this code does.
 *
 * ============================================================================
 * NOTHING HERE TRUSTS A BROWSER-SUPPLIED RELATIONSHIP
 * ============================================================================
 * The caller passes the AUTHENTICATED customer and a benefit code. The benefit
 * is then loaded server-side and its own `customerRef` compared — possession of
 * a code is not entitlement, because the benefit is non-transferable. Nothing
 * reads a customer or an eligibility claim out of a request body.
 */

export type ReserveRefusal =
  | FallbackRefusal
  | "benefit_not_found"
  /** Another checkout already holds the one reservation this benefit allows. */
  | "already_reserved"
  | "calculation_refused";

export type ReserveRedemptionResult =
  | { readonly outcome: "reserved"; readonly intent: BeatQuoteRedemptionIntent }
  | { readonly outcome: "refused"; readonly refusal: ReserveRefusal; readonly detail?: string };

export interface ReserveRedemptionInput {
  /** As quoted by the customer. Located with, never trusted for authorisation. */
  readonly benefitCode: string;
  /** The AUTHENTICATED Shopify customer. Never from a request body. */
  readonly customerRef: string;
  readonly surface: BeatQuoteRedemptionSurface;
  /** The authoritative lines, already classified by the caller. */
  readonly lines: readonly RedemptionLineInput[];
  readonly otherPromotionApplied: boolean;
  readonly stackingExpresslyAuthorized: boolean;
  readonly now: Date;
}

/**
 * Reserves the benefit against a specific set of lines, returning the exact
 * discount to put on the draft order.
 *
 * EVERY PRE-CONDITION IS CHECKED BEFORE ANYTHING IS WRITTEN, and the refusal
 * reported is the most fundamental one — `evaluateFallbackRedeemability` orders
 * them so a customer with an expired benefit is told it expired rather than
 * being sent to try a different cart with a dead code.
 */
export async function reserveBeatQuoteRedemption(
  input: ReserveRedemptionInput
): Promise<ReserveRedemptionResult> {
  const benefit = await prisma.beatQuoteFallbackBenefit.findUnique({
    where: { benefitCode: input.benefitCode },
  });
  // Deliberately the same answer for "no such code" and, below, a code
  // belonging to someone else: distinguishing them would make this an oracle
  // for guessing another customer's benefit.
  if (!benefit) return { outcome: "refused", refusal: "benefit_not_found" };

  const redeemability = evaluateFallbackRedeemability({
    issuedAt: benefit.issuedAt,
    expiresAt: benefit.expiresAt,
    redeemedAt: benefit.redeemedAt,
    revokedAt: benefit.revokedAt,
    attemptingCustomerRef: input.customerRef,
    issuedToCustomerRef: benefit.customerRef,
    surface: input.surface,
    otherPromotionApplied: input.otherPromotionApplied,
    stackingExpresslyAuthorized: input.stackingExpresslyAuthorized,
    now: input.now,
  });
  if (!redeemability.redeemable) {
    logger.info("beat_quote_redemption.refused", { refusal: redeemability.refusal });
    return { outcome: "refused", refusal: redeemability.refusal };
  }

  // The quote, computed from the benefit's OWN frozen cap rather than today's
  // constant.
  let quote;
  try {
    quote = quoteRedemption({
      lines: input.lines,
      surface: input.surface,
      benefitMaxDiscount: Money.fromMinorUnits(benefit.maxDiscountMinorUnits, benefit.currency),
      otherPromotionApplied: input.otherPromotionApplied,
      stackingExpresslyAuthorized: input.stackingExpresslyAuthorized,
    });
  } catch (error) {
    if (error instanceof RedemptionCalculationError) {
      return { outcome: "refused", refusal: "calculation_refused", detail: error.message };
    }
    throw error;
  }

  try {
    const intent = await prisma.beatQuoteRedemptionIntent.create({
      data: {
        benefitId: benefit.id,
        customerRef: input.customerRef,
        // Narrowed by `evaluateFallbackRedeemability` above, which refuses the
        // ineligible surfaces — and the database enum has no members for them.
        surface: input.surface as "buy_now" | "custom_jewelry",
        eligibleSubtotalMinorUnits: quote.eligibleSubtotal.amountMinorUnits,
        discountMinorUnits: quote.discount.amountMinorUnits,
        currency: quote.discount.currency,
        // Copied, not referenced: a CHECK can only see its own row, and this
        // intent must be judged against the terms it was created under.
        benefitMaxDiscountMinorUnits: benefit.maxDiscountMinorUnits,
        benefitExpiresAt: benefit.expiresAt,
        eligibleLines: quote.includedLines.map((line) => ({
          reference: line.reference,
          quantity: line.quantity,
          unitPriceMinorUnits: line.unitPrice.amountMinorUnits.toString(),
          currency: line.unitPrice.currency,
        })),
        reservedAt: input.now,
      },
    });
    logger.info("beat_quote_redemption.reserved", {
      intentId: intent.id,
      discountMinorUnits: intent.discountMinorUnits.toString(),
    });
    return { outcome: "reserved", intent };
  } catch (error) {
    // THE CONCURRENCY BOUNDARY. Two checkouts both passed every check above;
    // the partial UNIQUE index on (benefit_id) WHERE status='reserved' decides
    // it. The loser is told the benefit is already in a checkout rather than
    // being handed a second usable discount.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      logger.info("beat_quote_redemption.already_reserved", { benefitId: benefit.id });
      return { outcome: "refused", refusal: "already_reserved" };
    }
    throw error;
  }
}

/**
 * Records the Shopify draft order this reservation produced.
 *
 * Written once — the trigger refuses a change — so an intent cannot be
 * re-pointed at a different checkout after the fact.
 */
export async function attachRedemptionDraftOrder(input: {
  readonly intentId: string;
  readonly draftOrderGid: string;
}): Promise<void> {
  await prisma.beatQuoteRedemptionIntent.update({
    where: { id: input.intentId },
    data: { draftOrderGid: input.draftOrderGid },
  });
}

export type ReleaseReason = "abandoned" | "checkout_failed" | "superseded" | "staff_released";

/**
 * Releases a reservation so the benefit becomes usable again.
 *
 * CONDITIONAL ON STILL BEING `reserved`, in the WHERE clause. A completed
 * redemption must never be released back into usability — that would hand a
 * spent benefit back — and the trigger refuses it independently.
 */
export async function releaseBeatQuoteRedemption(input: {
  readonly intentId: string;
  readonly reason: ReleaseReason;
  readonly detail: string;
  readonly now: Date;
}): Promise<{ released: boolean }> {
  const result = await prisma.beatQuoteRedemptionIntent.updateMany({
    where: { id: input.intentId, status: "reserved" },
    data: {
      status: "released",
      releasedAt: input.now,
      releaseReason: `${input.reason}: ${input.detail}`,
    },
  });
  return { released: result.count === 1 };
}

export interface VerifyAndCompleteInput {
  readonly intentId: string;
  readonly orderGid: string;
  /** The customer the ORDER is attached to, read from Shopify. */
  readonly orderCustomerRef: string | null;
  /** The discount the order ACTUALLY carries, in minor units. */
  readonly observedDiscountMinorUnits: bigint;
  readonly observedCurrency: string;
  /** True when the order carries any other promotional discount. */
  readonly otherPromotionOnOrder: boolean;
  /** True when the order contains Group Buy or Luxury Steals merchandise. */
  readonly containsExcludedMerchandise: boolean;
  readonly now: Date;
}

export type CompleteRedemptionResult =
  | { readonly outcome: "completed" }
  | { readonly outcome: "already_completed" }
  | { readonly outcome: "failed_review"; readonly reason: string }
  | { readonly outcome: "intent_not_found" };

/**
 * Order-time verification, and completion only if everything agrees.
 *
 * ============================================================================
 * ANY MISMATCH FAILS CLOSED TO STAFF REVIEW — NEVER TO "REDEEMED"
 * ============================================================================
 * Owner decision, and the reasoning is worth keeping: a disagreement between
 * the discount we calculated and the discount the order actually carries is
 * either our bug or someone's tampering. Marking the benefit redeemed would
 * quietly accept a wrong discount AND consume the customer's one use; marking
 * it released would hand back a benefit that may already have been honoured on
 * a real paid order. Neither is safe, so the intent goes to `failed_review` and
 * a person decides.
 *
 * The comparison is against the FROZEN reservation, not a recomputation. A cart
 * can change between reservation and payment; what was promised cannot.
 */
export async function verifyAndCompleteBeatQuoteRedemption(
  input: VerifyAndCompleteInput
): Promise<CompleteRedemptionResult> {
  const intent = await prisma.beatQuoteRedemptionIntent.findUnique({
    where: { id: input.intentId },
    include: { benefit: true },
  });
  if (!intent) return { outcome: "intent_not_found" };

  // Idempotent under redelivery: the same order arriving twice finds the
  // intent already completed and does nothing.
  if (intent.status === "completed") return { outcome: "already_completed" };

  if (intent.status !== "reserved") {
    // Released or already under review. Not something a webhook should
    // silently resurrect.
    return {
      outcome: "failed_review",
      reason: `an order arrived for an intent in status ${intent.status}`,
    };
  }

  const mismatches: string[] = [];
  if (input.orderCustomerRef !== intent.customerRef) {
    mismatches.push(
      `order customer ${input.orderCustomerRef ?? "none"} is not the reserving customer ${intent.customerRef}`
    );
  }
  if (input.observedDiscountMinorUnits !== intent.discountMinorUnits) {
    mismatches.push(
      `order discount ${input.observedDiscountMinorUnits} does not equal the reserved ${intent.discountMinorUnits}`
    );
  }
  if (input.observedCurrency.toUpperCase() !== intent.currency.toUpperCase()) {
    mismatches.push(`order currency ${input.observedCurrency} does not equal the reserved ${intent.currency}`);
  }
  if (input.containsExcludedMerchandise) {
    // Amendment §3: Group Buys and Luxury Steals are excluded. An order that
    // received the benefit alongside them did not honour the terms.
    mismatches.push("the order contains Group Buy or Luxury Steals merchandise");
  }
  if (input.otherPromotionOnOrder) {
    mismatches.push("the order carries another promotional discount and stacking was not authorized");
  }
  // The benefit's own expiry, checked against the ORDER's arrival rather than
  // the reservation's: a checkout that sat past the expiry must not complete.
  if (input.now.getTime() >= intent.benefitExpiresAt.getTime()) {
    mismatches.push(`the benefit expired at ${intent.benefitExpiresAt.toISOString()} before the order completed`);
  }

  if (mismatches.length > 0) {
    const reason = mismatches.join("; ");
    logger.error("beat_quote_redemption.failed_review", { intentId: intent.id, reason });
    await prisma.beatQuoteRedemptionIntent.updateMany({
      where: { id: intent.id, status: "reserved" },
      data: { status: "failed_review", reviewReason: reason, orderGid: input.orderGid },
    });
    return { outcome: "failed_review", reason };
  }

  // ONE TRANSACTION. The intent completing and the benefit being spent are one
  // fact; a completed intent beside an unspent benefit would let it be
  // redeemed again.
  try {
    await prisma.$transaction(async (tx) => {
      const completed = await tx.beatQuoteRedemptionIntent.updateMany({
        where: { id: intent.id, status: "reserved" },
        data: { status: "completed", completedAt: input.now, orderGid: input.orderGid },
      });
      if (completed.count !== 1) {
        // Lost a race to another delivery of the same order. Throwing rolls
        // back and the caller reports idempotently below.
        throw new Prisma.PrismaClientKnownRequestError("intent no longer reserved", {
          code: "P2002",
          clientVersion: "x",
        });
      }
      await tx.beatQuoteFallbackBenefit.update({
        where: { id: intent.benefitId },
        data: {
          redeemedAt: input.now,
          redemptionOrderRef: input.orderGid,
          redemptionDiscountMinorUnits: intent.discountMinorUnits,
        },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { outcome: "already_completed" };
    }
    throw error;
  }

  logger.info("beat_quote_redemption.completed", { intentId: intent.id, orderGid: input.orderGid });
  return { outcome: "completed" };
}
