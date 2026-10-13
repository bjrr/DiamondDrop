import { Prisma } from "@prisma/client";

import { decideFirstFailure, decideRestoration, decideRetryFailure } from "~/domain/luxurysteals/syncFailure";

import { prisma } from "../client.server";

/**
 * Luxury Steal metafield sync-failure state machine — the repository side
 * (Slice 3 task 3-2b, criterion 152, docs/specs/SLICE-3-LUXURY-STEALS.md).
 * Pairs with the PURE decisions in `~/domain/luxurysteals/syncFailure`: this
 * module resolves the real `luxury_steal_sync_failure` row, calls the
 * decision functions with explicit inputs, and applies the resulting outcome
 * with Prisma. Mirrors `priceCalculationFailureRepository.server.ts`'s shape
 * closely — same race-safe open/retry idiom — with the purchasability
 * consequence removed entirely rather than merely unused; see that module's
 * own doc comment and the domain module's header for why.
 *
 * NEVER TOUCHES MASTERVARIANT OR ANY PURCHASABILITY-RELATED STATE. This
 * module records and resolves failure episodes only; nothing here can make a
 * variant unavailable, by construction — there is no suspension concept to
 * call.
 *
 * Called from `app/app/jobs/luxurysteals/syncAssignment.server.ts`, both for
 * the bounded immediate retry at write time and for a manual "Retry sync"
 * from the admin page — the SAME function serves both callers, exactly like
 * `recordSyncFailure`/`recordCalculationFailure` serve their own callers.
 */

/** The OPEN episode for a variant — at most one, enforced by the partial unique index. */
async function findOpenEpisode(masterVariantId: string) {
  return prisma.luxuryStealSyncFailure.findFirst({
    where: { masterVariantId, resolvedAt: null },
  });
}

export interface RecordLuxuryStealSyncFailureInput {
  masterVariantId: string;
  error: string;
  now?: Date;
}

export interface RecordLuxuryStealSyncFailureResult {
  failureId: string;
  attemptCount: number;
  /** True only for the attempt that opened this episode — the admin surfacing hook. */
  newEpisode: boolean;
}

/**
 * Records a failed sync attempt, opening a new episode if none is open or
 * accumulating onto the existing one. NEVER touches `master_variant` or any
 * availability state (criterion 152) — this module only records the
 * failure; the variant stays exactly as purchasable as it was a moment ago.
 *
 * IDEMPOTENT/RACE-SAFE under two concurrent callers for the SAME variant
 * (e.g. the write-time bounded retry and a manual admin retry landing at
 * once): both may see no open episode, both attempt to open one, and the
 * partial unique index lets exactly one INSERT win. The loser's P2002 is
 * caught and re-read as a retry against the winner's just-created episode,
 * rather than surfaced as a crash — mirrors `recordSyncFailure`/
 * `recordCalculationFailure`.
 */
export async function recordLuxuryStealSyncFailure(
  input: RecordLuxuryStealSyncFailureInput
): Promise<RecordLuxuryStealSyncFailureResult> {
  const now = input.now ?? new Date();
  const open = await findOpenEpisode(input.masterVariantId);

  if (!open) {
    try {
      return await openNewEpisode(input.masterVariantId, now, input.error);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await findOpenEpisode(input.masterVariantId);
        if (winner) return recordRetry(winner, now, input.error);
      }
      throw error;
    }
  }

  return recordRetry(open, now, input.error);
}

async function openNewEpisode(
  masterVariantId: string,
  now: Date,
  error: string
): Promise<RecordLuxuryStealSyncFailureResult> {
  const outcome = decideFirstFailure({ now, error });
  const created = await prisma.luxuryStealSyncFailure.create({
    data: {
      masterVariantId,
      firstFailedAt: outcome.firstFailedAt,
      lastAttemptAt: outcome.lastAttemptAt,
      attemptCount: outcome.attemptCount,
      lastError: outcome.lastError,
    },
  });

  return { failureId: created.id, attemptCount: created.attemptCount, newEpisode: true };
}

async function recordRetry(
  open: { id: string; attemptCount: number },
  now: Date,
  error: string
): Promise<RecordLuxuryStealSyncFailureResult> {
  const outcome = decideRetryFailure({ now, error, attemptCountBefore: open.attemptCount });

  const updated = await prisma.luxuryStealSyncFailure.update({
    where: { id: open.id },
    data: {
      lastAttemptAt: outcome.lastAttemptAt,
      attemptCount: outcome.attemptCount,
      lastError: outcome.lastError,
    },
  });

  return { failureId: updated.id, attemptCount: updated.attemptCount, newEpisode: false };
}

export interface RecordLuxuryStealSyncSuccessResult {
  /** False when there was no open episode — a success with nothing to resolve. */
  restored: boolean;
  failureId?: string;
}

/**
 * A genuinely successful sync (criterion 126 — never marked resolved before
 * Shopify confirms; the caller only invokes this AFTER a confirmed write).
 * `trigger` names what closed the episode — `"automatic-retry"` for the
 * bounded immediate retry at write time, or `"staff:<id>"` for a manual
 * admin retry — see `~/domain/luxurysteals/syncFailure`'s `decideRestoration`
 * for why this differs from the pricing sync-failure module's equivalent.
 */
export async function recordLuxuryStealSyncSuccess(input: {
  masterVariantId: string;
  trigger: string;
  now?: Date;
}): Promise<RecordLuxuryStealSyncSuccessResult> {
  const now = input.now ?? new Date();
  // Validated BEFORE the read, so a malformed call fails the same way
  // whether or not an episode happens to be open.
  const outcome = decideRestoration({ now, trigger: input.trigger });

  const open = await findOpenEpisode(input.masterVariantId);
  if (!open) return { restored: false };

  const updated = await prisma.luxuryStealSyncFailure.update({
    where: { id: open.id },
    data: { resolvedAt: outcome.resolvedAt, resolvedTrigger: outcome.resolvedTrigger },
  });

  return { restored: true, failureId: updated.id };
}

export interface LuxuryStealSyncFailureStatus {
  failureId: string;
  masterVariantId: string;
  lastError: string;
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: number;
  resolvedAt: Date | null;
  resolvedTrigger: string | null;
}

function toStatus(row: {
  id: string;
  masterVariantId: string;
  lastError: string;
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: number;
  resolvedAt: Date | null;
  resolvedTrigger: string | null;
}): LuxuryStealSyncFailureStatus {
  return {
    failureId: row.id,
    masterVariantId: row.masterVariantId,
    lastError: row.lastError,
    firstFailedAt: row.firstFailedAt,
    lastAttemptAt: row.lastAttemptAt,
    attemptCount: row.attemptCount,
    resolvedAt: row.resolvedAt,
    resolvedTrigger: row.resolvedTrigger,
  };
}

/**
 * The CURRENT open episode for one variant, or `null` — the admin
 * assignment page's per-row "does this variant have a failing sync right
 * now" read, and what the manual "Retry sync" action is offered against.
 */
export async function getOpenLuxuryStealSyncFailure(
  masterVariantId: string
): Promise<LuxuryStealSyncFailureStatus | null> {
  const row = await findOpenEpisode(masterVariantId);
  return row ? toStatus(row) : null;
}

/**
 * Every currently OPEN episode across every variant, oldest first — the
 * admin listing read. Surfaces exactly what criterion 152 requires ("surface
 * it in the admin") and nothing about purchasability, because nothing here
 * touches purchasability.
 */
export async function listOpenLuxuryStealSyncFailures(): Promise<LuxuryStealSyncFailureStatus[]> {
  const rows = await prisma.luxuryStealSyncFailure.findMany({
    where: { resolvedAt: null },
    orderBy: { firstFailedAt: "asc" },
  });
  return rows.map(toStatus);
}
