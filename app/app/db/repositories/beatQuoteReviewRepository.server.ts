import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  BeatQuoteFallbackBenefit,
  BeatQuoteSubmission,
  BeatQuoteSubmissionStatus,
  BeatQuoteVerificationOutcome,
} from "@prisma/client";

import { prisma } from "../client.server";

/**
 * Staff review of a "Let Us Beat Your Quote" submission, and issuance of the
 * fallback benefit.
 *
 * ============================================================================
 * NOTHING HERE RECOMPUTES ELIGIBILITY
 * ============================================================================
 * `treatment`, `quoteAgeCalendarDays`, `submittedOn` and `calendarZone` were
 * frozen at intake and are never touched by review. A reviewer records what
 * they VERIFIED and what they DECIDED; they do not re-derive whether the quote
 * was inside the window, because the answer to that question belongs to the
 * moment of submission. A quote must not age out because review took four days.
 *
 * ============================================================================
 * REVIEW IS MANUAL, BY DESIGN
 * ============================================================================
 * The specification's Implementation Principle forbids "an automated engine
 * that commits CaratForUs to matching or beating a competitor based solely on
 * uploaded documents or scraped prices". So there is no function here that
 * decides whether to match a price. `recordDecision` persists a decision a
 * human already made, and `issueFallbackBenefit` acts only on the one outcome
 * that owes a benefit.
 */

export interface RecordVerificationInput {
  readonly submissionId: string;
  readonly outcome: Exclude<BeatQuoteVerificationOutcome, "pending">;
  /** CaratForUs's OWN evidence — what was checked, where, when. */
  readonly evidence: string;
  readonly actorRef: string;
  readonly at: Date;
}

/** Raised when a submission does not exist. */
export class BeatQuoteSubmissionNotFoundError extends Error {
  constructor(id: string) {
    super(`no beat-quote submission with id ${id}`);
    this.name = "BeatQuoteSubmissionNotFoundError";
  }
}

/** Raised when a verification verdict would overwrite an existing one. */
export class BeatQuoteAlreadyVerifiedError extends Error {
  constructor(id: string, existing: BeatQuoteVerificationOutcome) {
    super(
      `submission ${id} is already ${existing}. A verification verdict is not re-recorded: ` +
        `changing it would rewrite the basis on which a $100 benefit was owed or refused.`
    );
    this.name = "BeatQuoteAlreadyVerifiedError";
  }
}

/**
 * Records the reviewer's verification verdict.
 *
 * WRITTEN ONCE. A verdict that could be flipped is a verdict that can be
 * flipped after a benefit was issued or refused on the strength of it, which
 * would leave the evidence disagreeing with the outcome. A genuine correction
 * is a new submission or a documented override, not an edit.
 *
 * The `beat_quote_submission_verification_attributed` CHECK independently
 * refuses a verdict with no actor or no timestamp, so an anonymous verdict
 * cannot be stored even if this function were bypassed.
 */
export async function recordVerification(
  input: RecordVerificationInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<BeatQuoteSubmission> {
  const existing = await tx.beatQuoteSubmission.findUnique({
    where: { id: input.submissionId },
    select: { verification: true },
  });
  if (!existing) throw new BeatQuoteSubmissionNotFoundError(input.submissionId);
  if (existing.verification !== "pending") {
    throw new BeatQuoteAlreadyVerifiedError(input.submissionId, existing.verification);
  }

  // Conditional on still being `pending`, in the WHERE clause rather than
  // trusting the read above — two reviewers acting at once must not both
  // succeed, and a read-then-write loses that race.
  const result = await tx.beatQuoteSubmission.updateMany({
    where: { id: input.submissionId, verification: "pending" },
    data: {
      verification: input.outcome,
      verificationEvidence: input.evidence,
      verifiedAt: input.at,
      verifiedByActorRef: input.actorRef,
      status: "in_review",
    },
  });
  if (result.count !== 1) {
    // Lost the race. Re-read to report what actually happened rather than
    // asserting something that is no longer true.
    const now = await tx.beatQuoteSubmission.findUniqueOrThrow({
      where: { id: input.submissionId },
      select: { verification: true },
    });
    throw new BeatQuoteAlreadyVerifiedError(input.submissionId, now.verification);
  }

  return tx.beatQuoteSubmission.findUniqueOrThrow({ where: { id: input.submissionId } });
}

export interface RecordDecisionInput {
  readonly submissionId: string;
  /** The outcome a HUMAN reached. This function does not compute it. */
  readonly status: Extract<
    BeatQuoteSubmissionStatus,
    "offer_made" | "declined_cannot_beat" | "rejected" | "closed"
  >;
  readonly reason: string;
  readonly actorRef: string;
  readonly at: Date;
  /** Present when an offer was made. Integer minor units, never a float. */
  readonly offeredPriceMinorUnits?: bigint;
  readonly offeredPriceCurrency?: string;
  /** What CaratForUs disclosed alongside the price — timeline, warranty, returns. */
  readonly offerTermsShown?: string;
}

/** Raised when an offer status carries no price, or a non-offer carries one. */
export class BeatQuoteDecisionIncoherentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatQuoteDecisionIncoherentError";
  }
}

/**
 * Records the reviewer's decision.
 *
 * AN OFFER NEEDS A PRICE. `offer_made` without one is not a record of an offer,
 * and the comparison the specification asks CaratForUs to present ("competing
 * jewelry price / CaratForUs jewelry price") cannot be built from it.
 * Conversely a declined or rejected submission must NOT carry an offered price:
 * storing one would make a refusal look like an offer in any later report.
 */
export async function recordDecision(
  input: RecordDecisionInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<BeatQuoteSubmission> {
  const hasPrice = input.offeredPriceMinorUnits !== undefined;
  if (input.status === "offer_made" && !hasPrice) {
    throw new BeatQuoteDecisionIncoherentError(
      "an offer_made decision requires the offered price — without it there is no offer to compare"
    );
  }
  if (input.status !== "offer_made" && hasPrice) {
    throw new BeatQuoteDecisionIncoherentError(
      `a ${input.status} decision must not carry an offered price; it would read as an offer later`
    );
  }
  if (hasPrice !== (input.offeredPriceCurrency !== undefined)) {
    throw new BeatQuoteDecisionIncoherentError("an offered price needs both an amount and a currency");
  }
  if (input.reason.trim() === "") {
    throw new BeatQuoteDecisionIncoherentError("a decision carries its reason");
  }

  const existing = await tx.beatQuoteSubmission.findUnique({
    where: { id: input.submissionId },
    select: { id: true },
  });
  if (!existing) throw new BeatQuoteSubmissionNotFoundError(input.submissionId);

  return tx.beatQuoteSubmission.update({
    where: { id: input.submissionId },
    data: {
      status: input.status,
      decisionReason: input.reason,
      decidedAt: input.at,
      decidedByActorRef: input.actorRef,
      offeredPriceMinorUnits: hasPrice ? input.offeredPriceMinorUnits : null,
      offeredPriceCurrency: hasPrice ? input.offeredPriceCurrency!.toUpperCase() : null,
      offerTermsShown: input.offerTermsShown ?? null,
    },
  });
}

/**
 * A benefit code the customer quotes to redeem.
 *
 * CSPRNG, not a sequence: a guessable code is a benefit anyone can claim, and
 * the benefit is non-transferable. The alphabet excludes I/O/0/1 so the code
 * survives being read over the phone.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newBenefitCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `BQ10-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export interface CreateFallbackBenefitInput {
  readonly submissionId: string;
  /** NOT NULL — see `issueFallbackBenefit` on why an anonymous submission cannot hold one. */
  readonly customerRef: string;
  readonly percent: number;
  readonly maxDiscountMinorUnits: bigint;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly issuedByActorRef: string;
}

/**
 * Writes the benefit row.
 *
 * A P2002 on `submission_id` means this submission already has a benefit —
 * amendment §3's duplicate-issuance rule, enforced by the index rather than by
 * a prior read. Deliberately NOT swallowed here: the caller decides what a
 * duplicate means, and a repository that quietly returned the existing row
 * would hide a genuine double-issuance attempt.
 */
export async function createFallbackBenefit(
  input: CreateFallbackBenefitInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<BeatQuoteFallbackBenefit> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await tx.beatQuoteFallbackBenefit.create({
        data: {
          submissionId: input.submissionId,
          benefitCode: newBenefitCode(),
          customerRef: input.customerRef,
          percent: input.percent,
          maxDiscountMinorUnits: input.maxDiscountMinorUnits,
          currency: input.currency,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
          issuedByActorType: "staff",
          issuedByActorRef: input.issuedByActorRef,
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const target = (error.meta as { target?: string[] | string } | undefined)?.target;
      const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");
      // A code collision is astronomically unlikely but retryable; a
      // submission collision is the duplicate-issuance rule and must surface.
      if (!fields.includes("benefit_code")) throw error;
    }
  }
  throw new Error("could not generate a unique benefit code in 5 attempts");
}

export interface BeatQuoteStaffListRow {
  readonly id: string;
  readonly submissionReference: string;
  readonly kind: string;
  readonly treatment: string;
  readonly verification: string;
  readonly status: string;
  readonly customerName: string;
  readonly email: string;
  readonly hasAccount: boolean;
  readonly quoteAgeCalendarDays: number | null;
  readonly submittedAt: Date;
  readonly competitorPriceMinorUnits: bigint | null;
  readonly competitorPriceCurrency: string | null;
  readonly benefitIssuedAt: Date | null;
}

export interface SearchBeatQuoteSubmissionsInput {
  /** Matches the submission reference or the customer's email, case-insensitively. */
  readonly query?: string;
  readonly status?: BeatQuoteSubmissionStatus | readonly BeatQuoteSubmissionStatus[];
  readonly page?: number;
}

const PAGE_SIZE = 25;

/**
 * The staff triage list.
 *
 * AN EXPLICIT `select` ALLOWLIST, never a spread. The row carries reviewer
 * identities, internal verification evidence and a decision reason; a spread
 * would start surfacing any of those on a list screen the moment a column was
 * added.
 *
 * `specifications` and `verificationEvidence` are deliberately ABSENT: both are
 * long free text that makes a list unreadable, and the detail page is where
 * they belong.
 *
 * `hasAccount` rather than the raw `customerRef`. What a triaging reviewer
 * needs to know is whether a benefit COULD be issued — issuance fails closed
 * for an anonymous submission because the benefit is non-transferable — and
 * that is a yes/no, not a gid to copy around.
 */
export async function searchBeatQuoteSubmissionsForStaff(
  input: SearchBeatQuoteSubmissionsInput = {}
): Promise<{ rows: BeatQuoteStaffListRow[]; totalCount: number; pageSize: number }> {
  const page = input.page && input.page > 0 ? input.page : 1;

  const where: Prisma.BeatQuoteSubmissionWhereInput = {
    ...(input.query
      ? {
          OR: [
            { submissionReference: { contains: input.query, mode: "insensitive" } },
            { email: { contains: input.query, mode: "insensitive" } },
          ],
        }
      : {}),
    // Normalised to an `in` filter either way: `Array.isArray` does not narrow
    // a `readonly T[]` union usefully, and one shape is simpler than two.
    ...(input.status
      ? { status: { in: Array.isArray(input.status) ? [...input.status] : [input.status] } }
      : {}),
  };

  const [rows, totalCount] = await Promise.all([
    prisma.beatQuoteSubmission.findMany({
      where,
      // Oldest first: a triage queue is worked front to back, and the
      // submission waiting longest is the one a customer is waiting on.
      orderBy: { submittedAt: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        submissionReference: true,
        kind: true,
        treatment: true,
        verification: true,
        status: true,
        firstName: true,
        lastName: true,
        email: true,
        customerRef: true,
        quoteAgeCalendarDays: true,
        submittedAt: true,
        competitorPriceMinorUnits: true,
        competitorPriceCurrency: true,
        fallbackBenefit: { select: { issuedAt: true } },
      },
    }),
    prisma.beatQuoteSubmission.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      submissionReference: row.submissionReference,
      kind: row.kind,
      treatment: row.treatment,
      verification: row.verification,
      status: row.status,
      customerName: `${row.firstName} ${row.lastName}`,
      email: row.email,
      hasAccount: row.customerRef !== null,
      quoteAgeCalendarDays: row.quoteAgeCalendarDays,
      submittedAt: row.submittedAt,
      competitorPriceMinorUnits: row.competitorPriceMinorUnits,
      competitorPriceCurrency: row.competitorPriceCurrency,
      benefitIssuedAt: row.fallbackBenefit?.issuedAt ?? null,
    })),
    totalCount,
    pageSize: PAGE_SIZE,
  };
}

/**
 * How long a reservation may sit before staff should look at it.
 *
 * NOT A POLICY DEADLINE and deliberately not called one. Nothing expires a
 * reservation automatically — the benefit stays unusable until someone releases
 * it or the customer pays — so this threshold only decides when the queue
 * starts asking for attention. Two hours is long enough that a customer
 * finishing a normal checkout is never flagged, and short enough that a
 * benefit is not quietly locked for a day.
 */
export const STALE_RESERVATION_HOURS = 2;

export interface RedemptionAttentionRow {
  readonly intentId: string;
  readonly benefitCode: string;
  /** The SUBMISSION this benefit came from — what the staff detail page is keyed on. */
  readonly submissionId: string;
  readonly submissionReference: string;
  readonly customerRef: string;
  readonly status: string;
  readonly discountMinorUnits: bigint;
  readonly currency: string;
  readonly reservedAt: Date;
  readonly orderGid: string | null;
  readonly draftOrderGid: string | null;
  /** Why verification failed, for `failed_review` rows. */
  readonly reviewReason: string | null;
  /** True when a person must decide, as opposed to merely release a stale hold. */
  readonly needsDecision: boolean;
}

/**
 * Redemptions a human has to deal with.
 *
 * ============================================================================
 * WHY THIS EXISTS AT ALL
 * ============================================================================
 * Order-time verification fails CLOSED to `failed_review` rather than marking a
 * benefit redeemed or releasing it, because a discount that does not match what
 * we reserved is either our bug or someone's tampering and neither is safe to
 * resolve automatically. That is only a real safeguard if somebody sees it.
 * A fail-closed state nobody can find is a silent failure with extra steps.
 *
 * TWO DIFFERENT JOBS, RETURNED TOGETHER AND DISTINGUISHED BY `needsDecision`:
 *
 *   `failed_review`  a paid order disagreed with the reservation. A person must
 *                    decide what actually happened. Always surfaced.
 *   stale `reserved` a checkout that was started and apparently abandoned. The
 *                    benefit is unusable until released, so the customer cannot
 *                    try again — a smaller problem, but one with a customer
 *                    waiting on the other end.
 *
 * `completed` and `released` are absent: both are finished, and a queue that
 * lists finished work is a queue nobody reads.
 */
export async function listRedemptionsNeedingAttention(
  now: Date = new Date()
): Promise<RedemptionAttentionRow[]> {
  const staleBefore = new Date(now.getTime() - STALE_RESERVATION_HOURS * 60 * 60 * 1000);

  const rows = await prisma.beatQuoteRedemptionIntent.findMany({
    where: {
      OR: [
        { status: "failed_review" },
        { status: "reserved", reservedAt: { lt: staleBefore } },
      ],
    },
    // Oldest first, same reasoning as the submission queue: the one waiting
    // longest has a customer waiting longest.
    orderBy: { reservedAt: "asc" },
    select: {
      id: true,
      status: true,
      customerRef: true,
      discountMinorUnits: true,
      currency: true,
      reservedAt: true,
      orderGid: true,
      draftOrderGid: true,
      reviewReason: true,
      benefit: {
        select: {
          benefitCode: true,
          submission: { select: { id: true, submissionReference: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    intentId: row.id,
    benefitCode: row.benefit.benefitCode,
    submissionId: row.benefit.submission.id,
    submissionReference: row.benefit.submission.submissionReference,
    customerRef: row.customerRef,
    status: row.status,
    discountMinorUnits: row.discountMinorUnits,
    currency: row.currency,
    reservedAt: row.reservedAt,
    orderGid: row.orderGid,
    draftOrderGid: row.draftOrderGid,
    reviewReason: row.reviewReason,
    needsDecision: row.status === "failed_review",
  }));
}
