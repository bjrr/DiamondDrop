import { Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { logger } from "~/lib/logger.server";

/**
 * The fallback benefit on a Bank Payment order (owner decision 2026-10-11).
 *
 * ============================================================================
 * WHY THIS IS NOT THE CARD PATH WITH A DIFFERENT PRICE
 * ============================================================================
 * A card redemption completes when Shopify tells us an order was paid. A Bank
 * Payment order is not paid by Shopify at all — the money moves outside it, and
 * a human verifies the transfer by hand (§22; `verification.server.ts`). So the
 * moment that redeems the benefit is a STAFF ACTION, not a webhook, and the
 * moments that release it are a cancellation or a human decision.
 *
 * The owner's sequence, which this module implements and names:
 *
 *   order creation        reserve, do NOT redeem. Validate ownership and the
 *                         benefit's standing, freeze the amount against THIS
 *                         order's Bank Payment merchandise subtotal, allow one
 *                         active hold and no second.
 *   funds verified        redeem, exactly once.
 *   unpaid cancellation   release — but ONLY on positive confirmation that
 *                         payment was not received.
 *   anything uncertain    do not release. Route to a person.
 *   late payment          do not resurrect, do not consume. Hold the order and
 *                         the payment for reconciliation.
 *
 * ============================================================================
 * THE EXPIRY CLOCK IS NEVER TOUCHED
 * ============================================================================
 * Releasing a reservation returns the benefit to available with its ORIGINAL
 * expiration. It does not restart or extend the 90 days — the benefit was
 * issued once, and an unpaid order is not a reason to have been issued it
 * again. That falls out of where expiry lives: on the benefit, written at
 * issuance, and nothing in this file writes it. A benefit that expired while
 * reserved therefore comes back expired, which is the owner's instruction and
 * also simply the truth.
 */

/**
 * Whether payment was received, as a HUMAN-CONFIRMED fact.
 *
 * ============================================================================
 * THERE IS NO "PROBABLY NOT" — THAT IS WHAT `uncertain` IS FOR
 * ============================================================================
 * The owner drew the line precisely: release requires POSITIVE confirmation
 * that payment was not received. Everything else — in doubt, received but
 * unverified, partially received, a transfer we cannot trace — must not
 * auto-release, because releasing while a discounted checkout is still payable
 * is how one benefit funds two purchases.
 *
 * So this is three-valued and the third value is not a failure mode, it is the
 * normal answer when nobody has actually checked. `confirmed_not_received` is
 * the only one that frees a benefit, and a caller has to say it deliberately.
 */
export type PaymentOutcome =
  /** Somebody established that the money never arrived. The only releasing answer. */
  | "confirmed_not_received"
  /** Received and verified. Redeems. */
  | "confirmed_received"
  /** In doubt, unverified, partial, untraceable. Routes to a person. */
  | "uncertain";

export type AttachBankRedemptionResult =
  | { readonly outcome: "attached" }
  | { readonly outcome: "already_attached" }
  | { readonly outcome: "intent_not_reserved"; readonly status: string };

/**
 * Links a reservation to the bank payment order it was calculated for.
 *
 * SEPARATE FROM RESERVING because of the order of operations, not for
 * flexibility: the discount must exist before the draft order can carry it, and
 * the `bank_payment_order` row is written after that draft. The window between
 * them is the reason the benefit is reserved rather than merely intended.
 *
 * Write-once — the trigger refuses a change, so a reservation cannot be
 * re-pointed at a different order after the fact.
 */
export async function attachBankPaymentOrderToRedemption(input: {
  readonly intentId: string;
  readonly bankPaymentOrderId: string;
}): Promise<AttachBankRedemptionResult> {
  const intent = await prisma.beatQuoteRedemptionIntent.findUnique({
    where: { id: input.intentId },
    select: { status: true, bankPaymentOrderId: true, paymentBasis: true },
  });
  if (!intent) return { outcome: "intent_not_reserved", status: "missing" };
  if (intent.bankPaymentOrderId === input.bankPaymentOrderId) return { outcome: "already_attached" };
  if (intent.status !== "reserved") return { outcome: "intent_not_reserved", status: intent.status };

  await prisma.beatQuoteRedemptionIntent.update({
    where: { id: input.intentId },
    data: { bankPaymentOrderId: input.bankPaymentOrderId },
  });
  return { outcome: "attached" };
}

export type RedeemOnVerifiedPaymentResult =
  | { readonly outcome: "redeemed"; readonly intentId: string; readonly discountMinorUnits: bigint }
  /** A redelivery or a second verification attempt. Nothing written. */
  | { readonly outcome: "already_redeemed"; readonly intentId: string }
  /** No benefit was applied to this order. The overwhelmingly common case. */
  | { readonly outcome: "no_redemption" }
  /**
   * Money arrived against an order whose reservation was ALREADY RELEASED. The
   * benefit is NOT consumed and NOT resurrected; the order is held for
   * reconciliation.
   */
  | { readonly outcome: "reconciliation_required"; readonly intentId: string; readonly reason: string }
  /** The reservation is waiting on a person. Verification must not pre-empt them. */
  | { readonly outcome: "held_for_review"; readonly intentId: string; readonly reason: string };

/**
 * Redeems the benefit because a human verified the funds arrived.
 *
 * ============================================================================
 * THIS IS THE ONLY PLACE A BANK REDEMPTION BECOMES REDEEMED
 * ============================================================================
 * Owner decision: "the benefit becomes redeemed only when the Bank Payment is
 * actually received and manually verified." Not at order creation, not at
 * draft-order creation, not when the customer says they have sent a transfer.
 *
 * CALLED INSIDE THE VERIFICATION TRANSACTION. The funds being verified and the
 * benefit being spent are one fact: a verified order beside an unspent benefit
 * would let the benefit be used again on a second purchase, and a spent benefit
 * beside an unverified order would consume it for nothing. `tx` is therefore
 * required rather than optional.
 *
 * ============================================================================
 * A LATE PAYMENT DOES NOT RESURRECT A RELEASED RESERVATION
 * ============================================================================
 * Owner decision, verbatim in substance. If the reservation was released, the
 * benefit may already have been re-reserved or redeemed on a different
 * purchase; consuming it here could take it twice, and resurrecting this intent
 * could hand out two discounts. Neither is ours to decide automatically, so the
 * order and the payment are held for a person and the intent stays released.
 */
export async function redeemBankPaymentRedemptionOnVerifiedFunds(
  tx: Prisma.TransactionClient,
  input: {
    readonly bankPaymentOrderId: string;
    readonly verifiedAt: Date;
    readonly verifiedByActorRef: string;
  }
): Promise<RedeemOnVerifiedPaymentResult> {
  const intent = await tx.beatQuoteRedemptionIntent.findUnique({
    where: { bankPaymentOrderId: input.bankPaymentOrderId },
    select: {
      id: true,
      status: true,
      benefitId: true,
      discountMinorUnits: true,
      benefitExpiresAt: true,
      reviewReason: true,
      reconciliationRequiredAt: true,
    },
  });
  // No benefit on this order. Every ordinary Bank Payment order lands here.
  if (!intent) return { outcome: "no_redemption" };

  if (intent.status === "completed") return { outcome: "already_redeemed", intentId: intent.id };

  if (intent.status === "released") {
    const reason =
      `payment for bank payment order ${input.bankPaymentOrderId} was verified at ` +
      `${input.verifiedAt.toISOString()}, after this reservation had already been released. The benefit ` +
      `was NOT consumed and the reservation was NOT resurrected: it may already have been used on another ` +
      `purchase. Reconcile the order and the payment by hand.`;
    // Recorded once — the trigger refuses an overwrite, so a second late
    // payment leaves the first discrepancy intact and adds an audit event.
    if (intent.reconciliationRequiredAt === null) {
      await tx.beatQuoteRedemptionIntent.update({
        where: { id: intent.id },
        data: { reconciliationRequiredAt: input.verifiedAt, reconciliationReason: reason },
      });
    }
    logger.error("beat_quote_bank_redemption.late_payment_after_release", {
      intentId: intent.id,
      bankPaymentOrderId: input.bankPaymentOrderId,
    });
    return { outcome: "reconciliation_required", intentId: intent.id, reason };
  }

  if (intent.status === "failed_review") {
    // A person is already looking at this reservation. Redeeming underneath
    // them would resolve the question they were asked to answer.
    return {
      outcome: "held_for_review",
      intentId: intent.id,
      reason: intent.reviewReason ?? "the reservation is under staff review",
    };
  }

  // THE EXPIRY, JUDGED AGAINST WHEN THE MONEY ARRIVED. Same rule as the card
  // path: the customer's payment time is what counts, not when staff got round
  // to verifying it. A transfer that landed inside the window is in time even
  // if it was verified a week later.
  //
  // Note this uses the VERIFIED-AT instant, which for Bank Payment is the
  // closest thing to a payment timestamp we hold: the funds are confirmed by a
  // human reading a bank record, and `verifiedAt` is when they confirmed it.
  // Judging a bank payment stricter than a card one would be the wrong way
  // round, so an expiry breach here goes to review rather than being refused
  // outright — a human can see the bank record's own date.
  if (input.verifiedAt.getTime() >= intent.benefitExpiresAt.getTime()) {
    const reason =
      `funds were verified at ${input.verifiedAt.toISOString()}, at or after the benefit expired at ` +
      `${intent.benefitExpiresAt.toISOString()}. The bank record's own value date decides whether the ` +
      `payment was in time, and only a person can read it.`;
    await tx.beatQuoteRedemptionIntent.updateMany({
      where: { id: intent.id, status: "reserved" },
      data: { status: "failed_review", reviewReason: reason },
    });
    logger.error("beat_quote_bank_redemption.verified_after_expiry", { intentId: intent.id });
    return { outcome: "held_for_review", intentId: intent.id, reason };
  }

  // EXACTLY ONCE, enforced by the WHERE clause and then by the partial UNIQUE
  // index on one completed intent per benefit.
  const completed = await tx.beatQuoteRedemptionIntent.updateMany({
    where: { id: intent.id, status: "reserved" },
    data: {
      status: "completed",
      completedAt: input.verifiedAt,
      // The bank payment order IS the order here. There is no Shopify order gid
      // until the draft completes, and that happens after this.
      orderGid: `bank_payment_order:${input.bankPaymentOrderId}`,
    },
  });
  if (completed.count !== 1) {
    // Lost a race to another verification of the same order.
    return { outcome: "already_redeemed", intentId: intent.id };
  }

  await tx.beatQuoteFallbackBenefit.update({
    where: { id: intent.benefitId },
    data: {
      redeemedAt: input.verifiedAt,
      redemptionOrderRef: `bank_payment_order:${input.bankPaymentOrderId}`,
      redemptionDiscountMinorUnits: intent.discountMinorUnits,
    },
  });

  logger.info("beat_quote_bank_redemption.redeemed", {
    intentId: intent.id,
    bankPaymentOrderId: input.bankPaymentOrderId,
    verifiedByActorRef: input.verifiedByActorRef,
  });
  return { outcome: "redeemed", intentId: intent.id, discountMinorUnits: intent.discountMinorUnits };
}

export type ReleaseOnCancellationResult =
  | {
      readonly outcome: "released";
      readonly intentId: string;
      /** The benefit's ORIGINAL expiry, unchanged. Returned so a caller can say so honestly. */
      readonly benefitExpiresAt: Date;
      readonly benefitExpiredWhileReserved: boolean;
    }
  | { readonly outcome: "no_redemption" }
  | { readonly outcome: "already_released"; readonly intentId: string }
  /** Completed: the funds were verified. A cancellation must not un-redeem. */
  | { readonly outcome: "refused_completed"; readonly intentId: string }
  /** Payment status was not a positive non-receipt. Routed to a person. */
  | { readonly outcome: "held_for_review"; readonly intentId: string; readonly reason: string };

/**
 * Releases the reservation because a Bank Payment order was cancelled for
 * nonpayment.
 *
 * ============================================================================
 * ONLY `confirmed_not_received` RELEASES. EVERYTHING ELSE ASKS A PERSON.
 * ============================================================================
 * Owner decision. An order cancelled by the 24-hour guarantee sweep for a price
 * change is NOT a confirmation that money did not arrive — it is a statement
 * about price. Treating every cancellation as non-receipt is exactly how a
 * benefit gets freed while its discounted checkout is still payable.
 *
 * THE ORIGINAL EXPIRATION SURVIVES, AND SO DOES AN EXPIRY. Release writes
 * nothing to the benefit's `expiresAt`; the 90 days are not restarted or
 * extended. A benefit that expired while reserved comes back expired, and
 * `benefitExpiredWhileReserved` says so, so a caller can tell the customer the
 * truth instead of offering a benefit that will refuse itself.
 */
export async function releaseBankPaymentRedemptionOnCancellation(input: {
  readonly bankPaymentOrderId: string;
  readonly paymentOutcome: PaymentOutcome;
  readonly cancellationReason: string;
  readonly actorRef: string;
  readonly now: Date;
}): Promise<ReleaseOnCancellationResult> {
  const intent = await prisma.beatQuoteRedemptionIntent.findUnique({
    where: { bankPaymentOrderId: input.bankPaymentOrderId },
    select: { id: true, status: true, benefitExpiresAt: true },
  });
  if (!intent) return { outcome: "no_redemption" };
  if (intent.status === "released") return { outcome: "already_released", intentId: intent.id };
  if (intent.status === "completed") {
    // The funds were verified. Whatever this cancellation is about, it is not
    // grounds to hand back a spent benefit.
    logger.error("beat_quote_bank_redemption.cancellation_of_completed", {
      intentId: intent.id,
      bankPaymentOrderId: input.bankPaymentOrderId,
    });
    return { outcome: "refused_completed", intentId: intent.id };
  }

  if (input.paymentOutcome !== "confirmed_not_received") {
    const reason =
      `bank payment order ${input.bankPaymentOrderId} was cancelled (${input.cancellationReason}) but the ` +
      `payment outcome is "${input.paymentOutcome}", not a positive confirmation that no money arrived. ` +
      `The benefit stays reserved: releasing it while a discounted checkout may still be payable is how ` +
      `one benefit funds two purchases.`;
    await prisma.beatQuoteRedemptionIntent.updateMany({
      where: { id: intent.id, status: "reserved" },
      data: { status: "failed_review", reviewReason: reason },
    });
    await recordRedemptionAudit({
      intentId: intent.id,
      action: "bank_redemption_release_withheld",
      actorRef: input.actorRef,
      reason,
    });
    return { outcome: "held_for_review", intentId: intent.id, reason };
  }

  const released = await prisma.beatQuoteRedemptionIntent.updateMany({
    // From `reserved` only. A `failed_review` reservation is a person's to
    // resolve through the staff release control, which proves the Shopify
    // object unpayable first; an automatic sweep must not pre-empt that.
    where: { id: intent.id, status: "reserved" },
    data: {
      status: "released",
      releasedAt: input.now,
      releaseReason: `unpaid_cancellation: ${input.cancellationReason}`,
      releasedByActorRef: input.actorRef,
      releaseShopifyRef: `bank_payment_order:${input.bankPaymentOrderId}`,
    },
  });
  if (released.count !== 1) {
    const current = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { status: true, reviewReason: true },
    });
    if (current.status === "released") return { outcome: "already_released", intentId: intent.id };
    if (current.status === "completed") return { outcome: "refused_completed", intentId: intent.id };
    return {
      outcome: "held_for_review",
      intentId: intent.id,
      reason: current.reviewReason ?? "the reservation changed state during release",
    };
  }

  await recordRedemptionAudit({
    intentId: intent.id,
    action: "bank_redemption_released_unpaid",
    actorRef: input.actorRef,
    reason:
      `released after confirmed non-receipt on bank payment order ${input.bankPaymentOrderId} ` +
      `(${input.cancellationReason}). The benefit returns to available with its ORIGINAL expiry of ` +
      `${intent.benefitExpiresAt.toISOString()} — the 90-day clock is not restarted or extended.`,
  });

  logger.info("beat_quote_bank_redemption.released_unpaid", {
    intentId: intent.id,
    bankPaymentOrderId: input.bankPaymentOrderId,
  });
  return {
    outcome: "released",
    intentId: intent.id,
    benefitExpiresAt: intent.benefitExpiresAt,
    // Said out loud rather than left for the customer to discover: the benefit
    // is back, and it is back expired.
    benefitExpiredWhileReserved: input.now.getTime() >= intent.benefitExpiresAt.getTime(),
  };
}

/**
 * An audit row for a redemption decision.
 *
 * Never throws into the caller: failing to write the note must not turn a
 * completed release into a retried one, which would make the release look
 * unsuccessful when the benefit is already available.
 */
export async function recordRedemptionAudit(input: {
  readonly intentId: string;
  readonly action: string;
  readonly actorRef: string;
  readonly reason: string;
  readonly actorType?: "staff" | "system";
}): Promise<void> {
  try {
    await createAuditEvent({
      entityType: "beat_quote_redemption",
      entityId: input.intentId,
      action: input.action,
      actorType: input.actorType ?? "system",
      actorRef: input.actorRef,
      reason: input.reason,
    });
  } catch (error) {
    logger.error("beat_quote_bank_redemption.audit_write_failed", {
      intentId: input.intentId,
      action: input.action,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}
