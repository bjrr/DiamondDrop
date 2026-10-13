import { Prisma } from "@prisma/client";

import {
  decideDismissal,
  decideFirstFailure,
  decideNextRetryDelay,
  decideRestoration,
  decideRetryFailure,
  isVariantWithdrawn,
} from "~/domain/pricing/syncFailure";

import { prisma } from "../client.server";

/**
 * Sync-failure state machine — the repository side (owner §4; spec criteria
 * 20-27; ruling R2, §16.5). Pairs with the PURE decisions in
 * `~/domain/pricing/syncFailure`: this module resolves the real
 * `price_sync_failure` row, calls the decision functions with explicit
 * inputs, and applies the resulting outcome with Prisma.
 *
 * A DOCUMENTED SEAM, not wired into anything. Mirrors
 * `priceOverrideExpiryRepository.server.ts` and, further back,
 * `app/app/jobs/pricing/ports.ts`: a self-contained, independently-testable
 * unit a job file calls, rather than this module reaching out to trigger
 * itself. Whoever wires the sync adapter's failure path (T1/T4) calls
 * `recordSyncFailure` on a failed Admin API call and `recordSyncSuccess` on
 * a successful one; an admin route calls `dismissSyncFailureAlert`.
 */

/** The OPEN episode for a variant — at most one, enforced by the partial unique index. */
async function findOpenEpisode(masterVariantId: string) {
  return prisma.priceSyncFailure.findFirst({
    where: { masterVariantId, resolvedAt: null },
  });
}

export interface RecordSyncFailureInput {
  masterVariantId: string;
  error: string;
  now?: Date;
}

export interface RecordSyncFailureResult {
  failureId: string;
  attemptCount: number;
  /** True only on the attempt that newly crosses the 48-hour threshold. */
  newlySuspended: boolean;
  suspended: boolean;
  nextRetryDelayMs: number;
}

/**
 * Records a failed sync attempt, opening a new episode if none is open or
 * accumulating onto the existing one. NEVER touches the price published on
 * Shopify (criterion 20) — this module only records the failure and decides
 * suspension; publishing is the sync adapter's job, out of scope here.
 *
 * IDEMPOTENT/RACE-SAFE under two concurrent callers for the SAME variant
 * (e.g. an overlapping retry and a fresh attempt landing at once): both may
 * see no open episode, both attempt to open one, and the partial unique
 * index lets exactly one INSERT win. The loser's P2002 is caught and
 * re-read as a retry against the winner's just-created episode, rather than
 * surfaced as a crash — see the concurrency test in the integration suite.
 */
export async function recordSyncFailure(input: RecordSyncFailureInput): Promise<RecordSyncFailureResult> {
  const now = input.now ?? new Date();
  const open = await findOpenEpisode(input.masterVariantId);

  if (!open) {
    try {
      return await openNewEpisode(input.masterVariantId, now, input.error);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await findOpenEpisode(input.masterVariantId);
        if (winner) return recordRetryFailure(winner, now, input.error);
      }
      throw error;
    }
  }

  return recordRetryFailure(open, now, input.error);
}

async function openNewEpisode(
  masterVariantId: string,
  now: Date,
  error: string
): Promise<RecordSyncFailureResult> {
  const outcome = decideFirstFailure({ now, error });
  const created = await prisma.priceSyncFailure.create({
    data: {
      masterVariantId,
      firstFailedAt: outcome.firstFailedAt,
      lastAttemptAt: outcome.lastAttemptAt,
      attemptCount: outcome.attemptCount,
      lastError: outcome.lastError,
      alertState: outcome.alertState,
    },
  });

  return {
    failureId: created.id,
    attemptCount: created.attemptCount,
    newlySuspended: false,
    suspended: false,
    // First attempt's own retry timing, for the caller to schedule attempt 2.
    nextRetryDelayMs: decideNextRetryDelay({ attemptCount: created.attemptCount }).nextAttemptDelayMs,
  };
}

async function recordRetryFailure(
  open: { id: string; firstFailedAt: Date; attemptCount: number; suspendedAt: Date | null },
  now: Date,
  error: string
): Promise<RecordSyncFailureResult> {
  const outcome = decideRetryFailure({
    now,
    error,
    firstFailedAt: open.firstFailedAt,
    attemptCountBefore: open.attemptCount,
    currentSuspendedAt: open.suspendedAt,
  });

  const updated = await prisma.priceSyncFailure.update({
    where: { id: open.id },
    data: {
      lastAttemptAt: outcome.lastAttemptAt,
      attemptCount: outcome.attemptCount,
      lastError: outcome.lastError,
      suspendedAt: outcome.suspendedAt,
    },
  });

  return {
    failureId: updated.id,
    attemptCount: updated.attemptCount,
    newlySuspended: outcome.newlySuspended,
    suspended: updated.suspendedAt !== null,
    nextRetryDelayMs: outcome.nextRetryDelayMs,
  };
}

export interface RecordSyncSuccessResult {
  /** False when there was no open episode — a success with nothing to resolve. */
  restored: boolean;
  failureId?: string;
}

/**
 * A genuinely successful sync (criterion 25). Restores availability with NO
 * human action, because `isVariantWithdrawn` reads `resolvedAt` — set here —
 * not any action a person took. `suspendedAt` is never touched (R4).
 */
export async function recordSyncSuccess(input: {
  masterVariantId: string;
  now?: Date;
}): Promise<RecordSyncSuccessResult> {
  const now = input.now ?? new Date();
  const open = await findOpenEpisode(input.masterVariantId);
  if (!open) return { restored: false };

  const outcome = decideRestoration({ now });
  const updated = await prisma.priceSyncFailure.update({
    where: { id: open.id },
    data: { resolvedAt: outcome.resolvedAt, alertState: outcome.alertState },
  });

  return { restored: true, failureId: updated.id };
}

export interface DismissSyncFailureAlertInput {
  masterVariantId: string;
  actor: string;
  reason: string;
  now?: Date;
}

export interface DismissSyncFailureAlertResult {
  /** False when there is no open episode to dismiss — nothing is silenced. */
  dismissed: boolean;
  failureId?: string;
}

/**
 * A human silencing the persistent alert (owner §4.3, criterion 22). Throws
 * `DismissalActorRequiredError`/`DismissalReasonRequiredError` (from
 * `decideDismissal`) before touching the database if either is missing.
 * Does NOT resolve the episode and does NOT lift a suspension — R2's whole
 * point, enforced structurally by `decideDismissal`'s outcome shape.
 */
export async function dismissSyncFailureAlert(
  input: DismissSyncFailureAlertInput
): Promise<DismissSyncFailureAlertResult> {
  const now = input.now ?? new Date();
  // Validate BEFORE the read, so a malformed call fails the same way whether
  // or not an episode happens to be open (fail fast, per CLAUDE.md #9).
  const outcome = decideDismissal({ actor: input.actor, reason: input.reason, now });

  const open = await findOpenEpisode(input.masterVariantId);
  if (!open) return { dismissed: false };

  const updated = await prisma.priceSyncFailure.update({
    where: { id: open.id },
    data: {
      alertState: outcome.alertState,
      dismissedBy: outcome.dismissedBy,
      dismissedReason: outcome.dismissedReason,
      dismissedAt: outcome.dismissedAt,
    },
  });

  return { dismissed: true, failureId: updated.id };
}

/**
 * The availability predicate (R2), applied against the real row. Returns
 * false when there is no open episode at all — nothing to withdraw over.
 */
export async function isVariantCurrentlyWithdrawn(masterVariantId: string): Promise<boolean> {
  const open = await findOpenEpisode(masterVariantId);
  if (!open) return false;
  return isVariantWithdrawn({ suspendedAt: open.suspendedAt, resolvedAt: open.resolvedAt });
}
