import { Prisma } from "@prisma/client";
import type { BeatQuoteFallbackBenefit } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { createFallbackBenefit } from "~/db/repositories/beatQuoteReviewRepository.server";
import {
  BEAT_QUOTE_FALLBACK_CURRENCY,
  BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS,
  BEAT_QUOTE_FALLBACK_PERCENT,
  fallbackExpiresAt,
} from "~/domain/beatyourquote/fallbackBenefit";
import { isGuaranteeInForce } from "~/domain/beatyourquote/eligibility";
import { logger } from "~/lib/logger.server";

/**
 * Issues the 10%-off fallback benefit.
 *
 * ============================================================================
 * THE GATE, AND EVERY PART OF IT IS LOCKED POLICY
 * ============================================================================
 * A benefit is owed in exactly one situation (amendment §2 and §4 case 6):
 *
 *   treatment    = guarantee              a custom quote inside the 7-day
 *                                         window, FROZEN at intake
 *   verification = verified               a human checked the seller, price,
 *                                         date and comparability
 *   status       = declined_cannot_beat   a human concluded CaratForUs cannot
 *                                         match or beat the verified price
 *
 * Every other combination owes nothing, and each for its own stated reason:
 * an older quote, an online listing and a competing Group Buy are review-only
 * (amendment §1); an unverified or rejected submission is excluded by the
 * original §"Verification and Fraud Protection"; and an offer that WAS made
 * fulfils the guarantee rather than triggering its fallback (§4 case 5).
 *
 * ============================================================================
 * THIS FUNCTION DOES NOT DECIDE ANYTHING
 * ============================================================================
 * It acts on a decision already recorded by a reviewer. The specification's
 * Implementation Principle forbids an engine that commits CaratForUs from
 * uploaded documents, so there is no path here that evaluates a competitor's
 * price. `status = declined_cannot_beat` is a human's conclusion; this merely
 * honours the promise attached to it.
 *
 * ============================================================================
 * AN ANONYMOUS SUBMISSION CANNOT HOLD A BENEFIT — FAIL CLOSED
 * ============================================================================
 * Intake is deliberately open to signed-out visitors. The benefit is
 * deliberately NON-TRANSFERABLE (amendment §3), which is meaningless without an
 * identity to bind it to — and `beat_quote_fallback_benefit.customer_ref` is
 * NOT NULL for exactly that reason.
 *
 * Binding to an email instead would make the benefit claimable by anyone who
 * controls that mailbox, which is transferability wearing a different name. And
 * redemption happens on a purchase, which `docs/REQUIRED-CUSTOMER-ACCOUNTS.md`
 * already requires an account for — so an account is needed before the benefit
 * can be used regardless.
 *
 * So this refuses with `customer_not_linked` rather than inventing a holder.
 * That is a derived consequence of two locked rules rather than a new policy,
 * but it is a real operational step — staff must get the customer signed in and
 * the submission linked before the benefit exists.
 */

export type IssueFallbackBenefitResult =
  | { readonly outcome: "issued"; readonly benefit: BeatQuoteFallbackBenefit }
  | { readonly outcome: "already_issued"; readonly benefit: BeatQuoteFallbackBenefit }
  | { readonly outcome: "submission_not_found" }
  /** Review-only path, or the guarantee is not in force. Nothing is owed. */
  | { readonly outcome: "not_owed"; readonly detail: string }
  | { readonly outcome: "customer_not_linked" };

export interface IssueFallbackBenefitInput {
  readonly submissionId: string;
  readonly issuedByActorRef: string;
  readonly now: Date;
}

export async function issueBeatQuoteFallbackBenefit(
  input: IssueFallbackBenefitInput
): Promise<IssueFallbackBenefitResult> {
  const submission = await prisma.beatQuoteSubmission.findUnique({
    where: { id: input.submissionId },
    select: {
      id: true,
      submissionReference: true,
      customerRef: true,
      kind: true,
      treatment: true,
      verification: true,
      status: true,
      fallbackBenefit: true,
    },
  });
  if (!submission) return { outcome: "submission_not_found" };

  // Already issued. Not an error — a retried job or a double-clicked button
  // reaching here is routine, and the answer is the benefit that exists.
  if (submission.fallbackBenefit) {
    return { outcome: "already_issued", benefit: submission.fallbackBenefit };
  }

  // THE GATE. Read from the FROZEN treatment rather than recomputed from
  // dates, so a submission's eligibility cannot shift because staff opened the
  // case a week later.
  if (!isGuaranteeInForce({ treatment: submission.treatment, verification: submission.verification })) {
    const detail =
      submission.treatment !== "guarantee"
        ? `treatment is ${submission.treatment} (${submission.kind} is review-only or outside the 7-day window)`
        : `verification is ${submission.verification}, not verified`;
    logger.info("beat_quote_fallback.not_owed", {
      submissionReference: submission.submissionReference,
      detail,
    });
    return { outcome: "not_owed", detail };
  }

  if (submission.status !== "declined_cannot_beat") {
    // Includes the case that MATTERS most: an offer was made, which fulfils
    // the guarantee. Issuing a fallback as well would pay twice for one
    // promise.
    const detail = `status is ${submission.status}; a fallback is owed only when CaratForUs declined because it cannot beat the price`;
    logger.info("beat_quote_fallback.not_owed", {
      submissionReference: submission.submissionReference,
      detail,
    });
    return { outcome: "not_owed", detail };
  }

  if (!submission.customerRef) {
    // See the module comment: non-transferable needs an identity, and there is
    // none to bind to yet.
    logger.warn("beat_quote_fallback.customer_not_linked", {
      submissionReference: submission.submissionReference,
    });
    return { outcome: "customer_not_linked" };
  }

  const issuedAt = input.now;
  try {
    const benefit = await createFallbackBenefit({
      submissionId: submission.id,
      customerRef: submission.customerRef,
      // The terms, FROZEN onto the row. A later policy change must not restate
      // what this holder was promised.
      percent: BEAT_QUOTE_FALLBACK_PERCENT,
      maxDiscountMinorUnits: BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS,
      currency: BEAT_QUOTE_FALLBACK_CURRENCY,
      issuedAt,
      expiresAt: fallbackExpiresAt(issuedAt),
      issuedByActorRef: input.issuedByActorRef,
    });

    logger.info("beat_quote_fallback.issued", {
      submissionReference: submission.submissionReference,
      expiresAt: benefit.expiresAt.toISOString(),
    });
    return { outcome: "issued", benefit };
  } catch (error) {
    // TWO CONCURRENT ISSUANCES. Both passed the check above before either
    // wrote; the UNIQUE index on submission_id decides it. The loser is
    // answered with the winner's benefit — amendment §3 requires that one
    // qualifying outcome yields one benefit, and it has.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.beatQuoteFallbackBenefit.findUnique({
        where: { submissionId: submission.id },
      });
      if (existing) {
        logger.info("beat_quote_fallback.concurrent_duplicate", {
          submissionReference: submission.submissionReference,
        });
        return { outcome: "already_issued", benefit: existing };
      }
    }
    throw error;
  }
}
