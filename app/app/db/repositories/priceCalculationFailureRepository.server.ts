import { Prisma } from "@prisma/client";

import {
  decideFirstFailure,
  decideRestoration,
  decideRetryFailure,
  isVariantWithdrawn,
  timeRemainingBeforeSuspensionMs,
  type CalculationFailureType,
} from "~/domain/pricing/calculationFailure";

import { prisma } from "../client.server";

/**
 * Recalculation-failure state machine — the repository side (owner §7).
 * Pairs with the PURE decisions in `~/domain/pricing/calculationFailure`:
 * this module resolves the real `price_calculation_failure` row, calls the
 * decision functions with explicit inputs, and applies the resulting
 * outcome with Prisma.
 *
 * A DOCUMENTED SEAM, not wired into anything. Mirrors
 * `priceSyncFailureRepository.server.ts`: a self-contained, independently
 * -testable unit that a job calls, rather than this module reaching out to
 * trigger itself. Whoever wires the calculation-failure path into
 * `runRecalculation.server.ts` calls `recordCalculationFailure` on a caught
 * per-variant error and `recordCalculationSuccess` on the next successful
 * calculation for that variant; an admin surface reads
 * `getCalculationFailureStatus` / `listOpenCalculationFailures`.
 *
 * See `~/domain/pricing/calculationFailure`'s module doc comment for why
 * this is a separate table/module from price_sync_failure rather than a
 * shared one, and in particular why there is no dismiss/alert workflow here.
 */

/** The OPEN episode for a variant — at most one, enforced by the partial unique index. */
async function findOpenEpisode(masterVariantId: string) {
  return prisma.priceCalculationFailure.findFirst({
    where: { masterVariantId, resolvedAt: null },
  });
}

export interface RecordCalculationFailureInput {
  masterVariantId: string;
  /** The thrown error's `.name` only — never its message (criterion 30's discipline, applied here too). */
  errorName: string;
  /** A human-readable detail, stored (not logged) on the access-controlled row. */
  error: string;
  now?: Date;
}

export interface RecordCalculationFailureResult {
  failureId: string;
  attemptCount: number;
  failureType: CalculationFailureType;
  /** True only for the attempt that opened this episode — owner §7's "notify the admin immediately" hook. */
  newEpisode: boolean;
  /** True only on the attempt that newly crosses the 48-hour threshold. */
  newlySuspended: boolean;
  suspended: boolean;
}

/**
 * Records a failed calculation attempt, opening a new episode if none is
 * open or accumulating onto the existing one. NEVER publishes or overwrites
 * the last valid published price (owner §7 immediate behaviour 1/3) — this
 * module only records the failure and decides suspension; the last-valid
 * price simply stays untouched because nothing here touches
 * `price_calculation`/`price_sync_intent` at all.
 *
 * IDEMPOTENT/RACE-SAFE under two concurrent callers for the SAME variant:
 * both may see no open episode, both attempt to open one, and the partial
 * unique index lets exactly one INSERT win. The loser's P2002 is caught and
 * re-read as a retry against the winner's just-created episode, rather than
 * surfaced as a crash — mirrors `recordSyncFailure`.
 */
export async function recordCalculationFailure(
  input: RecordCalculationFailureInput
): Promise<RecordCalculationFailureResult> {
  const now = input.now ?? new Date();
  const open = await findOpenEpisode(input.masterVariantId);

  if (!open) {
    try {
      return await openNewEpisode(input.masterVariantId, now, input.errorName, input.error);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await findOpenEpisode(input.masterVariantId);
        if (winner) return recordRetryFailure(winner, now, input.errorName, input.error);
      }
      throw error;
    }
  }

  return recordRetryFailure(open, now, input.errorName, input.error);
}

async function openNewEpisode(
  masterVariantId: string,
  now: Date,
  errorName: string,
  error: string
): Promise<RecordCalculationFailureResult> {
  const outcome = decideFirstFailure({ now, errorName, error });
  const created = await prisma.priceCalculationFailure.create({
    data: {
      masterVariantId,
      firstFailedAt: outcome.firstFailedAt,
      lastAttemptAt: outcome.lastAttemptAt,
      attemptCount: outcome.attemptCount,
      failureType: outcome.failureType,
      lastError: outcome.lastError,
    },
  });

  return {
    failureId: created.id,
    attemptCount: created.attemptCount,
    failureType: created.failureType,
    newEpisode: true,
    newlySuspended: false,
    suspended: false,
  };
}

async function recordRetryFailure(
  open: { id: string; firstFailedAt: Date; attemptCount: number; suspendedAt: Date | null },
  now: Date,
  errorName: string,
  error: string
): Promise<RecordCalculationFailureResult> {
  const outcome = decideRetryFailure({
    now,
    errorName,
    error,
    firstFailedAt: open.firstFailedAt,
    attemptCountBefore: open.attemptCount,
    currentSuspendedAt: open.suspendedAt,
  });

  const updated = await prisma.priceCalculationFailure.update({
    where: { id: open.id },
    data: {
      lastAttemptAt: outcome.lastAttemptAt,
      attemptCount: outcome.attemptCount,
      failureType: outcome.failureType,
      lastError: outcome.lastError,
      suspendedAt: outcome.suspendedAt,
    },
  });

  return {
    failureId: updated.id,
    attemptCount: updated.attemptCount,
    failureType: updated.failureType,
    newEpisode: false,
    newlySuspended: outcome.newlySuspended,
    suspended: updated.suspendedAt !== null,
  };
}

export interface RecordCalculationSuccessResult {
  /** False when there was no open episode — a success with nothing to resolve. */
  restored: boolean;
  failureId?: string;
}

/**
 * A genuinely successful recalculation (owner §7 recovery). Restores
 * availability with NO separate manual re-enable step, because
 * `isVariantWithdrawn` reads `resolvedAt` — set here — not any action a
 * person took beyond correcting the underlying data. `suspendedAt` is never
 * touched.
 *
 * REQUIRES `trigger` (unlike `recordSyncSuccess`): owner §7 recovery step 5
 * requires recording what triggered the successful recalculation —
 * `"scheduled"` for the routine run that happened to pick up the fix, or a
 * staff identifier (`"staff:alex"`) for a deliberately triggered one.
 */
export async function recordCalculationSuccess(input: {
  masterVariantId: string;
  trigger: string;
  now?: Date;
}): Promise<RecordCalculationSuccessResult> {
  const now = input.now ?? new Date();
  // Validated BEFORE the read, so a malformed call fails the same way
  // whether or not an episode happens to be open.
  const outcome = decideRestoration({ now, trigger: input.trigger });

  const open = await findOpenEpisode(input.masterVariantId);
  if (!open) return { restored: false };

  const updated = await prisma.priceCalculationFailure.update({
    where: { id: open.id },
    data: { resolvedAt: outcome.resolvedAt, resolvedTrigger: outcome.resolvedTrigger },
  });

  return { restored: true, failureId: updated.id };
}

/**
 * The availability predicate, applied against the real row. Returns false
 * when there is no open episode at all — nothing to withdraw over.
 */
export async function isVariantCurrentlyWithdrawn(masterVariantId: string): Promise<boolean> {
  const open = await findOpenEpisode(masterVariantId);
  if (!open) return false;
  return isVariantWithdrawn({ suspendedAt: open.suspendedAt, resolvedAt: open.resolvedAt });
}

export interface CalculationFailureStatus {
  failureId: string;
  masterVariantId: string;
  failureType: CalculationFailureType;
  lastError: string;
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: number;
  suspendedAt: Date | null;
  resolvedAt: Date | null;
  withdrawn: boolean;
  /** Zero once suspended or past the 48-hour boundary. */
  timeRemainingBeforeSuspensionMs: number;
}

/**
 * The admin-visibility shape owner §7 requires: product/variant (join left
 * to the caller — this returns the variant id, not a product name),
 * failure reason/type, first-failure timestamp, time remaining before
 * automatic unavailability, and current resolved/unresolved state. Returns
 * null when the variant has no failure episode at all (open OR resolved),
 * which is the common case and distinct from "resolved".
 */
export async function getCalculationFailureStatus(
  masterVariantId: string,
  now: Date = new Date()
): Promise<CalculationFailureStatus | null> {
  const row = await prisma.priceCalculationFailure.findFirst({
    where: { masterVariantId },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;

  return {
    failureId: row.id,
    masterVariantId: row.masterVariantId,
    failureType: row.failureType,
    lastError: row.lastError,
    firstFailedAt: row.firstFailedAt,
    lastAttemptAt: row.lastAttemptAt,
    attemptCount: row.attemptCount,
    suspendedAt: row.suspendedAt,
    resolvedAt: row.resolvedAt,
    withdrawn: isVariantWithdrawn({ suspendedAt: row.suspendedAt, resolvedAt: row.resolvedAt }),
    timeRemainingBeforeSuspensionMs: row.resolvedAt
      ? 0
      : timeRemainingBeforeSuspensionMs({ firstFailedAt: row.firstFailedAt, now }),
  };
}

/**
 * Every currently OPEN episode, oldest first — the admin dashboard listing
 * owner §7's admin-visibility requirement implies. Oldest first surfaces the
 * episode closest to (or past) automatic unavailability at the top.
 */
export async function listOpenCalculationFailures(
  now: Date = new Date()
): Promise<CalculationFailureStatus[]> {
  const rows = await prisma.priceCalculationFailure.findMany({
    where: { resolvedAt: null },
    orderBy: { firstFailedAt: "asc" },
  });

  return rows.map((row) => ({
    failureId: row.id,
    masterVariantId: row.masterVariantId,
    failureType: row.failureType,
    lastError: row.lastError,
    firstFailedAt: row.firstFailedAt,
    lastAttemptAt: row.lastAttemptAt,
    attemptCount: row.attemptCount,
    suspendedAt: row.suspendedAt,
    resolvedAt: row.resolvedAt,
    withdrawn: isVariantWithdrawn({ suspendedAt: row.suspendedAt, resolvedAt: row.resolvedAt }),
    timeRemainingBeforeSuspensionMs: timeRemainingBeforeSuspensionMs({
      firstFailedAt: row.firstFailedAt,
      now,
    }),
  }));
}
