import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { BeatQuoteSubmission, BeatQuoteSubmissionKind, BeatQuoteTreatment } from "@prisma/client";

import { prisma } from "../client.server";

/**
 * "Let Us Beat Your Quote!" submissions.
 *
 * ============================================================================
 * TREATMENT IS DERIVED BY THE CALLER AND NEVER ACCEPTED FROM A REQUEST
 * ============================================================================
 * This repository takes `treatment` and `quoteAgeCalendarDays` as inputs
 * because it is a persistence layer, not a policy engine — but the ONLY caller
 * that may supply them is the intake path, which computes them with
 * `deriveIntakeTreatment` from the submission kind and two calendar dates.
 *
 * The public request schema (`apps.carat.beat-quote-submission.tsx`) does not
 * carry a treatment field at all. Not "carries it and ignores it": a field that
 * is accepted is a field somebody later wires up, and the failure mode is a
 * customer granting themselves a guaranteed match-or-beat plus a $100 benefit.
 * The database refuses the impossible combinations independently
 * (`beat_quote_submission_guarantee_requires_custom_quote` and
 * `..._guarantee_within_window`), so a mistake here cannot persist either.
 *
 * ============================================================================
 * THE FROZEN FACTS, AND WHY THEY ARE STORED RATHER THAN DERIVED ON READ
 * ============================================================================
 * `submittedOn`, `quoteIssuedOn`, `quoteAgeCalendarDays` and `treatment` are
 * written once. Nothing recomputes them from `now()` when staff opens the case:
 * a quote must not become ineligible because review took four days, which would
 * be the customer's position changing because of our latency. The source facts
 * are all stored, so the intake decision can be reproduced and audited later
 * rather than merely trusted.
 */

export interface CreateBeatQuoteSubmissionInput {
  /** Client-minted, so a retry converges instead of creating a second submission. */
  readonly id: string;
  /** The AUTHENTICATED customer when there is one. Never read from the body. */
  readonly customerRef: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;

  readonly kind: BeatQuoteSubmissionKind;

  /** DERIVED server-side. See this module's header. */
  readonly treatment: BeatQuoteTreatment;
  /** `YYYY-MM-DD`; null for kinds with no age rule. */
  readonly quoteIssuedOn: Date | null;
  /** The business-calendar date the window was measured against. */
  readonly submittedOn: Date;
  /** The instant, in UTC. */
  readonly submittedAt: Date;
  /** The IANA zone `submittedOn` was derived in. Resolved, never assumed. */
  readonly calendarZone: string;
  readonly quoteAgeCalendarDays: number | null;

  readonly competitorSellerName: string | null;
  readonly competitorWebsite: string | null;
  readonly listingUrl: string | null;
  readonly competitorPriceMinorUnits: bigint | null;
  readonly competitorPriceCurrency: string | null;
  readonly specifications: string | null;
  readonly competitorTimeline: string | null;
  readonly competitorReturnPolicy: string | null;
  readonly competitorWarranty: string | null;
}

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A customer-facing reference, e.g. `BQ-7Q2MPX4N`.
 *
 * Unambiguous alphabet — no I/O/0/1 — so it survives being read aloud to
 * support, the same choice `WarrantyClaim` and `CustomJewelryProject` make.
 * CSPRNG rather than a sequence so one reference does not reveal how many
 * submissions exist or let a customer guess another.
 */
function newSubmissionReference(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `BQ-${out}`;
}

/** Thrown when the reference generator cannot find a free value. Effectively unreachable. */
export class BeatQuoteReferenceCollisionError extends Error {
  constructor(attempts: number) {
    super(`could not generate a unique submission reference in ${attempts} attempts`);
    this.name = "BeatQuoteReferenceCollisionError";
  }
}

/**
 * Creates a submission, or returns the existing one for the same id.
 *
 * ============================================================================
 * RETRIES CONVERGE; THEY DO NOT ACCUMULATE
 * ============================================================================
 * The id is minted by the client and is the duplicate barrier, so a
 * double-submitted form, a retried request after a dropped response, or a
 * mobile browser replaying a POST all resolve to ONE submission rather than
 * three. The primary key is the authority under concurrency: the loser of a
 * race gets P2002 and is answered with the row the winner wrote.
 *
 * DELIBERATELY NOT AN UPSERT. An upsert would let a second request REWRITE the
 * first submission's frozen facts — including its treatment — which is exactly
 * the tampering this feature must not permit. A repeat returns what exists,
 * untouched, and the caller compares nothing: there is no "update" path into a
 * submission's eligibility at all.
 *
 * ============================================================================
 * ONE ATTEMPT, AND ANY UNIQUE VIOLATION IS RETHROWN
 * ============================================================================
 * There is no retry loop here, and that is forced rather than chosen. This
 * function runs inside the caller's transaction, and in Postgres a failed
 * statement POISONS that transaction: every subsequent query returns 25P02,
 * "current transaction is aborted, commands ignored until end of transaction
 * block". So neither recovery that looks reasonable actually works in here —
 * re-reading the winner's row after an id collision, and re-rolling a
 * colliding reference, both fail with 25P02 rather than succeeding.
 *
 * That is not a theory: the concurrency test for this path failed with exactly
 * that error, which is why the loop that used to be here is gone.
 *
 * So both cases rethrow, and the caller converges OUTSIDE its transaction
 * where a read can succeed. A reference collision — 32^8, about one in 10^12 —
 * surfaces as an error whose retry simply draws a different reference.
 */
export async function createBeatQuoteSubmission(
  input: CreateBeatQuoteSubmissionInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<{ submission: BeatQuoteSubmission; created: boolean }> {
  const existing = await tx.beatQuoteSubmission.findUnique({ where: { id: input.id } });
  if (existing) return { submission: existing, created: false };

  {
    {
      const submission = await tx.beatQuoteSubmission.create({
        data: {
          id: input.id,
          submissionReference: newSubmissionReference(),
          customerRef: input.customerRef,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          kind: input.kind,
          treatment: input.treatment,
          quoteIssuedOn: input.quoteIssuedOn,
          submittedOn: input.submittedOn,
          submittedAt: input.submittedAt,
          calendarZone: input.calendarZone,
          quoteAgeCalendarDays: input.quoteAgeCalendarDays,
          competitorSellerName: input.competitorSellerName,
          competitorWebsite: input.competitorWebsite,
          listingUrl: input.listingUrl,
          competitorPriceMinorUnits: input.competitorPriceMinorUnits,
          competitorPriceCurrency: input.competitorPriceCurrency,
          specifications: input.specifications,
          competitorTimeline: input.competitorTimeline,
          competitorReturnPolicy: input.competitorReturnPolicy,
          competitorWarranty: input.competitorWarranty,
        },
      });
      return { submission, created: true };
    }
  }
}

/**
 * Is this error the submission-id uniqueness violation — i.e. a concurrent
 * request for the same submission got there first?
 *
 * Exported because convergence belongs to the CALLER, outside the transaction
 * this repository may be running in. Matched on the Prisma error code and the
 * violated target rather than on message text, which is not a stable contract.
 */
export function isBeatQuoteSubmissionIdCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = (error.meta as { target?: string[] | string } | undefined)?.target;
  const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return fields.includes("id") || fields.includes("pkey");
}

export interface BeatQuoteSubmissionConfirmation {
  readonly submissionId: string;
  readonly submissionReference: string;
  readonly treatment: BeatQuoteTreatment;
  readonly quoteAgeCalendarDays: number | null;
  readonly status: string;
}

/**
 * The CLOSED allow-list returned to the customer.
 *
 * An explicit field list, never a spread. The row carries reviewer identities,
 * internal verification evidence and a decision reason, none of which belongs
 * in a storefront response — and a spread would start leaking any of those the
 * moment a column was added.
 *
 * `treatment` IS returned, because the customer must be told which path their
 * submission is on and the approved acknowledgment copy says so explicitly.
 * Returning it is not the same as accepting it.
 */
export function toBeatQuoteSubmissionConfirmation(
  submission: BeatQuoteSubmission
): BeatQuoteSubmissionConfirmation {
  return {
    submissionId: submission.id,
    submissionReference: submission.submissionReference,
    treatment: submission.treatment,
    quoteAgeCalendarDays: submission.quoteAgeCalendarDays,
    status: submission.status,
  };
}

/**
 * The owner of a submission, or `null` if no submission with this id exists
 * yet.
 *
 * Used only by `apps.carat.beat-quote-upload-destination` to answer one
 * question: may this authenticated customer attach a file to this id?
 *
 * A MISSING SUBMISSION IS NOT AN ERROR. Destinations are requested while the
 * form is still being filled in, before anything has been submitted — the
 * same lifecycle as warranty claim uploads. Only a submission that EXISTS
 * and belongs to somebody else is a refusal, and the route returns the same
 * response for both cases so this never becomes an oracle for which ids
 * exist.
 *
 * `customerRef` is nullable because the submission route accepts anonymous
 * submissions. An anonymous submission can never be matched by an
 * authenticated caller's gid, so it falls through to the refusal path.
 */
export async function getBeatQuoteSubmissionForCustomer(
  submissionId: string
): Promise<{ id: string; customerRef: string | null } | null> {
  return prisma.beatQuoteSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, customerRef: true },
  });
}
