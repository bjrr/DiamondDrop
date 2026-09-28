import { Prisma } from "@prisma/client";
import type { WarrantyClaimUploadDestination, WarrantyClaimUploadKind } from "@prisma/client";

import { prisma } from "../client.server";

/**
 * Persistence for issued upload destinations — closes the storageKey trust
 * gap flagged in the R2 adapter handoff. See `WarrantyClaimUploadDestination`'s
 * doc comment in schema.prisma for the full reasoning (why `claimId` is not a
 * foreign key, and why this table is deliberately not append-only).
 *
 * TWO OPERATIONS ONLY, matching the two moments this record's lifecycle has:
 * `recordIssuedWarrantyClaimUploadDestination` (issuance, by
 * `apps.carat.warranty-claim-upload-destination.tsx`) and
 * `consumeWarrantyClaimUploadDestination` (consumption, by
 * `apps.carat.warranty-claim.tsx`, immediately before recording the
 * corresponding `WarrantyClaimUpload`). There is no update-by-id, no delete,
 * no "mark unconsumed" — the one legal state transition is expressed as the
 * single atomic operation below, not as separate read/decide/write steps.
 */

export interface RecordIssuedWarrantyClaimUploadDestinationInput {
  readonly claimId: string;
  readonly customerRef: string;
  readonly kind: WarrantyClaimUploadKind;
  readonly contentType: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export async function recordIssuedWarrantyClaimUploadDestination(
  input: RecordIssuedWarrantyClaimUploadDestinationInput
): Promise<WarrantyClaimUploadDestination> {
  return prisma.warrantyClaimUploadDestination.create({
    data: {
      claimId: input.claimId,
      customerRef: input.customerRef,
      kind: input.kind,
      contentType: input.contentType,
      storageKey: input.storageKey,
      expiresAt: input.expiresAt,
    },
  });
}

export interface ConsumeWarrantyClaimUploadDestinationInput {
  readonly storageKey: string;
  /** The REAL claim id this upload is being recorded against — must equal the value recorded at issuance. */
  readonly claimId: string;
  /** The authenticated identity recording the upload — must equal the identity the destination was issued to. */
  readonly customerRef: string;
}

/**
 * THE SINGLE MOST IMPORTANT FUNCTION IN THIS MODULE. Verifies AND consumes a
 * destination in one atomic conditional `UPDATE ... WHERE ...`, never a
 * read-then-write — the WHERE clause is simultaneously the authorization
 * check (claim match, customer match, unexpired) and the single-use
 * enforcement (`consumedAt IS NULL`). Two concurrent callers racing to
 * consume the same key can never both succeed: at most one `UPDATE` matches
 * a row, because the first one to commit changes `consumedAt` away from
 * `NULL`, which removes the row from the second caller's WHERE clause.
 *
 * Returns `true` only if EXACTLY ONE row was updated. Every failure mode —
 * the key was never issued, issued for a different claim, issued to a
 * different customer, expired, or already consumed — collapses to the same
 * `false`. Callers MUST treat all of them identically (a single generic
 * refusal response), never distinguishing which condition failed: doing so
 * would make this an enumeration oracle for guessing another customer's
 * storage key (assigning message's explicit constraint).
 *
 * `tx` defaults to the plain client but accepts a `Prisma.TransactionClient`
 * so a caller consuming several destinations for one claim submission can do
 * so within one transaction — if any one of several uploads fails
 * verification, the whole batch (including destinations already consumed
 * earlier in the same loop) rolls back, matching "an unverifiable key must
 * be REFUSED, not silently dropped from the claim" (assigning message).
 */
export async function consumeWarrantyClaimUploadDestination(
  input: ConsumeWarrantyClaimUploadDestinationInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<boolean> {
  const result = await tx.warrantyClaimUploadDestination.updateMany({
    where: {
      storageKey: input.storageKey,
      claimId: input.claimId,
      customerRef: input.customerRef,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
