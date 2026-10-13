import { Prisma } from "@prisma/client";
import type { UploadDestinationPurpose, WarrantyClaimUploadKind } from "@prisma/client";

import { prisma } from "../client.server";

/**
 * THE ONE implementation of issued-destination security, shared by every
 * upload flow (owner-directed 2026-10-05).
 *
 * ============================================================================
 * WHY ONE AND NOT TWO
 * ============================================================================
 * Custom Jewelry needs exactly the guarantees warranty uploads already have:
 * authenticated-customer binding, a persisted issued destination, single use,
 * expiry, a storage key bound to that destination, arbitrary keys rejected,
 * and evidence that cannot be silently dropped. Two copies of that would
 * agree until the day they did not — the same failure this codebase already
 * had with two refund formulas, and now fences against.
 *
 * ============================================================================
 * PURPOSE IS PART OF THE MATCH, NOT A FIELD CALLERS CHECK
 * ============================================================================
 * A destination issued for a warranty claim must be unusable on a Custom
 * Jewelry submission and vice versa. That is enforced by `purpose` appearing
 * in the consumption WHERE clause, so cross-purpose reuse finds no row and
 * fails closed. It is NOT enforced by callers comparing a field, because a
 * caller that forgets produces a silent hole rather than an error.
 *
 * ============================================================================
 * EVERY FAILURE LOOKS THE SAME FROM OUTSIDE
 * ============================================================================
 * Never issued, wrong owner, wrong customer, wrong purpose, expired, already
 * consumed — all return `false`. Callers MUST render one generic refusal.
 * Distinguishing them would turn this into an oracle for guessing another
 * customer's storage key.
 */

export interface RecordIssuedUploadDestinationInput {
  readonly purpose: UploadDestinationPurpose;
  /** The warranty claim id, or the Custom Jewelry project id. */
  readonly ownerId: string;
  /** The AUTHENTICATED customer this destination is issued to. Never browser-supplied. */
  readonly customerRef: string;
  readonly kind: WarrantyClaimUploadKind;
  readonly contentType: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export async function recordIssuedUploadDestination(
  input: RecordIssuedUploadDestinationInput
): Promise<void> {
  await prisma.warrantyClaimUploadDestination.create({
    data: {
      purpose: input.purpose,
      ownerId: input.ownerId,
      // `claimId` is NO LONGER WRITTEN. Contract step A
      // (20261007020000) relaxed it to nullable precisely so this line could
      // go while the previous deploy was still setting it; step B drops the
      // column once nothing running references it. Do not reinstate it.
      customerRef: input.customerRef,
      kind: input.kind,
      contentType: input.contentType,
      storageKey: input.storageKey,
      expiresAt: input.expiresAt,
    },
  });
}

export interface ConsumeUploadDestinationInput {
  readonly purpose: UploadDestinationPurpose;
  readonly ownerId: string;
  readonly customerRef: string;
  readonly storageKey: string;
}

/**
 * Verifies AND consumes a destination in ONE atomic conditional `UPDATE`,
 * never a read-then-write. The WHERE clause is simultaneously the
 * authorisation check (purpose, owner, customer, unexpired) and the
 * single-use enforcement (`consumedAt IS NULL`).
 *
 * Two concurrent callers racing on the same key can never both succeed: the
 * first to commit moves `consumedAt` away from NULL, which removes the row
 * from the second's WHERE clause.
 *
 * Accepts a transaction client so a batch of uploads in one submission is
 * verified atomically — if any key fails, destinations already consumed
 * earlier in the same batch roll back with it. An unverifiable key must
 * refuse the whole submission, never be quietly dropped from it.
 */
export async function consumeUploadDestination(
  input: ConsumeUploadDestinationInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<boolean> {
  const result = await tx.warrantyClaimUploadDestination.updateMany({
    where: {
      storageKey: input.storageKey,
      purpose: input.purpose,
      ownerId: input.ownerId,
      customerRef: input.customerRef,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
