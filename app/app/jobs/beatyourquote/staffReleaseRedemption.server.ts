import { prisma } from "~/db/client.server";
import { logger } from "~/lib/logger.server";
import type { DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

import { recordRedemptionAudit } from "./bankPaymentRedemption.server";

/**
 * Staff release of a stale redemption hold (owner decision 2026-10-11).
 *
 * ============================================================================
 * THE OWNER'S CENTRAL INSTRUCTION, AND WHY IT IS THE WHOLE DESIGN
 * ============================================================================
 * "Do not implement it as a simple Release button that only clears the database
 * reservation. Before a reservation can be released, the associated Shopify
 * checkout/draft/order must no longer be capable of completing with that
 * benefit."
 *
 * The reason is worth stating plainly: a redemption hold exists because a
 * discounted, payable object exists in Shopify. Clearing our row does not
 * un-discount that object. A customer with the invoice link in their inbox
 * could pay it an hour later and receive the discount a second time — once on
 * the released benefit's new reservation, once on this one. Our database would
 * show a single use and the business would have given two.
 *
 * So the ORDER OF OPERATIONS is the safety property, and it is the owner's
 * order exactly:
 *
 *   1. staff select Release
 *   2. a non-empty reason is required
 *   3. the benefit must not be redeemed
 *   4. payment must not be received, verified, or ambiguous
 *   5. the Shopify payable object is invalidated
 *   6. Shopify must CONFIRM it
 *   7. only then is the database reservation released
 *   8. actor, reason, timestamp and Shopify reference are recorded
 *
 * IF STEP 6 FAILS OR IS UNCERTAIN, THE BENEFIT STAYS RESERVED. Not released
 * optimistically, not retried silently. An old discounted checkout that might
 * still be payable is precisely the condition under which the benefit must not
 * become available, so an uncertain cancellation leaves the hold in place and
 * puts the problem in front of a person.
 *
 * ============================================================================
 * IDEMPOTENT, BECAUSE STAFF DOUBLE-CLICK
 * ============================================================================
 * A second release of an already-released reservation reports success and
 * writes nothing. It does not re-cancel the Shopify object (already gone), does
 * not re-stamp the timestamps (which would rewrite who released it and when),
 * and does not record a second audit event implying two releases happened.
 */

export type StaffReleaseRefusal =
  /** Step 2. */
  | "reason_required"
  | "intent_not_found"
  /** Step 3. A spent benefit is not a stale hold. */
  | "already_redeemed"
  /** Step 4. Received, verified, or ambiguous — all of them block. */
  | "payment_not_confirmed_absent"
  /** Steps 5-6. Shopify did not confirm the object is unpayable. */
  | "shopify_invalidation_failed";

export type StaffReleaseResult =
  | {
      readonly outcome: "released";
      readonly intentId: string;
      /** Unchanged by the release. The 90-day clock is never restarted. */
      readonly benefitExpiresAt: Date;
      readonly benefitExpiredWhileReserved: boolean;
      readonly shopifyRef: string;
    }
  /** Already released. Reported as success, having written nothing. */
  | { readonly outcome: "already_released"; readonly intentId: string }
  | { readonly outcome: "refused"; readonly refusal: StaffReleaseRefusal; readonly detail: string };

export interface StaffReleaseInput {
  readonly intentId: string;
  /** Step 2. Free text, required, non-empty after trimming. */
  readonly reason: string;
  /** The AUTHENTICATED staff identity. Never a form field. */
  readonly actorRef: string;
  /**
   * Step 4, as a human-confirmed fact.
   *
   * ONLY `true` PROCEEDS, and the caller has to assert it. "The order looks
   * unpaid in our records" is not confirmation that no money arrived — a
   * transfer can be in flight, or received and not yet reconciled. The staff
   * surface asks for this explicitly rather than inferring it from a status.
   */
  readonly paymentConfirmedNotReceived: boolean;
  readonly draftOrderPort: DraftOrderPort;
  readonly now: Date;
}

/**
 * Releases a hold, having first proven the discounted checkout cannot complete.
 */
export async function staffReleaseRedemptionHold(input: StaffReleaseInput): Promise<StaffReleaseResult> {
  // ---- STEP 2: a reason, before anything is read or written. -------------
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return {
      outcome: "refused",
      refusal: "reason_required",
      detail: "a release must say why; the benefit becoming available again is a decision, not a cleanup",
    };
  }

  const intent = await prisma.beatQuoteRedemptionIntent.findUnique({
    where: { id: input.intentId },
    select: {
      id: true,
      status: true,
      benefitId: true,
      benefitExpiresAt: true,
      draftOrderGid: true,
      bankPaymentOrderId: true,
      paymentBasis: true,
    },
  });
  if (!intent) {
    return { outcome: "refused", refusal: "intent_not_found", detail: `no redemption intent ${input.intentId}` };
  }

  // Idempotent: a double-click reports success and writes nothing. Re-stamping
  // would rewrite who released it and when.
  if (intent.status === "released") return { outcome: "already_released", intentId: intent.id };

  // ---- STEP 3: a spent benefit is not a stale hold. ---------------------
  if (intent.status === "completed") {
    logger.error("beat_quote_staff_release.refused_completed", { intentId: intent.id, actorRef: input.actorRef });
    return {
      outcome: "refused",
      refusal: "already_redeemed",
      detail:
        "this redemption completed: the benefit is spent and the purchase was made. Releasing it would " +
        "hand back a benefit that has already been honoured.",
    };
  }

  // ---- STEP 4: payment must be confirmed ABSENT. ------------------------
  if (!input.paymentConfirmedNotReceived) {
    const detail =
      "release requires positive confirmation that payment was not received. Received, verified, partial " +
      "or uncertain all block it: freeing the benefit while a discounted checkout may still be payable is " +
      "how one benefit funds two purchases.";
    await recordRedemptionAudit({
      intentId: intent.id,
      action: "staff_release_refused_payment_unconfirmed",
      actorType: "staff",
      actorRef: input.actorRef,
      reason: `${detail} Staff reason given: ${reason}`,
    });
    return { outcome: "refused", refusal: "payment_not_confirmed_absent", detail };
  }

  // ---- STEPS 5 AND 6: make Shopify's object unpayable, and be told so. ---
  //
  // THIS HAPPENS BEFORE THE DATABASE CHANGES, and that ordering is the whole
  // point of the control. If it runs after, there is a window — however
  // short — in which the benefit is available AND the old discounted checkout
  // is payable.
  const shopifyRef = await invalidateShopifyPayable(intent, input);
  if (!shopifyRef.ok) {
    // THE HOLD STAYS. An uncertain cancellation is the condition under which
    // the benefit must not become available.
    const detail =
      `the discounted Shopify object could not be confirmed unpayable (${shopifyRef.error}). The benefit ` +
      `stays reserved: it must not become available while that checkout might still complete. ` +
      `Investigate the object directly, then retry.`;
    logger.error("beat_quote_staff_release.shopify_invalidation_failed", {
      intentId: intent.id,
      actorRef: input.actorRef,
      error: shopifyRef.error,
    });
    await flagForReview(intent.id, detail, input.actorRef);
    return { outcome: "refused", refusal: "shopify_invalidation_failed", detail };
  }

  // ---- STEP 7: now, and only now, release. -----------------------------
  //
  // Conditional on the status we read, so a redemption that completed while we
  // were talking to Shopify is not released out from under its own payment.
  // That ordering has a real consequence worth naming: we may have cancelled a
  // draft order for a redemption that completed in the meantime. A completed
  // redemption's draft has already become a real order, so cancelling the draft
  // cannot unmake it — which is why this check is a safety net rather than a
  // race we lose money on.
  const released = await prisma.beatQuoteRedemptionIntent.updateMany({
    where: { id: intent.id, status: { in: ["reserved", "failed_review"] } },
    data: {
      status: "released",
      releasedAt: input.now,
      releaseReason: `staff_released: ${reason}`,
      releasedByActorRef: input.actorRef,
      releaseShopifyRef: shopifyRef.ref,
    },
  });

  if (released.count !== 1) {
    const current = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({
      where: { id: intent.id },
      select: { status: true },
    });
    if (current.status === "released") return { outcome: "already_released", intentId: intent.id };
    return {
      outcome: "refused",
      refusal: "already_redeemed",
      detail: `the redemption moved to ${current.status} while the Shopify object was being invalidated`,
    };
  }

  // ---- STEP 8: the evidence. -------------------------------------------
  await recordRedemptionAudit({
    intentId: intent.id,
    action: "staff_release_completed",
    actorType: "staff",
    actorRef: input.actorRef,
    reason:
      `released by ${input.actorRef} at ${input.now.toISOString()}: ${reason}. Shopify object ` +
      `${shopifyRef.ref} was confirmed unpayable first. The benefit returns to available with its ` +
      `ORIGINAL expiry of ${intent.benefitExpiresAt.toISOString()} — the 90-day clock is not restarted.`,
  });

  logger.info("beat_quote_staff_release.released", {
    intentId: intent.id,
    actorRef: input.actorRef,
    shopifyRef: shopifyRef.ref,
  });

  return {
    outcome: "released",
    intentId: intent.id,
    benefitExpiresAt: intent.benefitExpiresAt,
    // Said out loud: the benefit is back, and it may be back expired. Releasing
    // does not extend it, so a staff member should not promise the customer a
    // second go that the benefit will refuse.
    benefitExpiredWhileReserved: input.now.getTime() >= intent.benefitExpiresAt.getTime(),
    shopifyRef: shopifyRef.ref,
  };
}

type InvalidationResult = { ok: true; ref: string } | { ok: false; error: string };

/**
 * Steps 5 and 6: make the discounted object incapable of completing, and
 * require Shopify to confirm it.
 *
 * ============================================================================
 * A MISSING DRAFT ORDER IS NOT A SUCCESS, AND NOT A FAILURE EITHER
 * ============================================================================
 * An intent with no `draftOrderGid` never got as far as creating one — the
 * reservation was taken and the Shopify call failed or never happened. There is
 * no payable object, so there is nothing to invalidate and nothing that could
 * complete with the benefit. That is a legitimate release, and the recorded
 * reference says so explicitly rather than leaving a blank that reads like an
 * un-run step.
 */
async function invalidateShopifyPayable(
  intent: {
    readonly id: string;
    readonly draftOrderGid: string | null;
    readonly bankPaymentOrderId: string | null;
    readonly paymentBasis: string;
  },
  input: StaffReleaseInput
): Promise<InvalidationResult> {
  if (!intent.draftOrderGid) {
    return {
      ok: true,
      ref: `no_payable_object:${intent.paymentBasis}:intent_${intent.id}_never_reached_draft_order_creation`,
    };
  }

  try {
    const cancelled = await input.draftOrderPort.cancelDraftOrder({ draftOrderGid: intent.draftOrderGid });
    // SHOPIFY'S OWN ANSWER, COMPARED. The adapter already refuses a response
    // that names a different id, but checking here too means this function
    // cannot be satisfied by a call that merely did not throw.
    if (cancelled.cancelledDraftOrderGid !== intent.draftOrderGid) {
      return {
        ok: false,
        error: `asked Shopify to delete ${intent.draftOrderGid} but it confirmed ${cancelled.cancelledDraftOrderGid}`,
      };
    }
    return { ok: true, ref: `draft_order_deleted:${cancelled.cancelledDraftOrderGid}` };
  } catch (error) {
    // INCLUDING "ALREADY GONE". A draft order that Shopify says does not exist
    // is arguably unpayable, but "arguably" is not the standard here: it could
    // equally have been COMPLETED into a real order, which is payable and in
    // fact may already be paid. Distinguishing those needs a human reading the
    // order, so this is a refusal and the hold stays.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Puts a failed release in front of a person, without freeing the benefit. */
async function flagForReview(intentId: string, detail: string, actorRef: string): Promise<void> {
  // From `reserved` only: a row already in `failed_review` keeps its original
  // reason, which is the one that first needed attention.
  await prisma.beatQuoteRedemptionIntent.updateMany({
    where: { id: intentId, status: "reserved" },
    data: { status: "failed_review", reviewReason: detail },
  });
  await recordRedemptionAudit({
    intentId,
    action: "staff_release_failed_shopify_invalidation",
    actorType: "staff",
    actorRef,
    reason: detail,
  });
}
