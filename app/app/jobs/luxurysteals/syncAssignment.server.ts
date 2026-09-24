import { getLuxuryStealAssignment } from "~/db/repositories/luxuryStealRepository.server";
import {
  recordLuxuryStealSyncFailure,
  recordLuxuryStealSyncSuccess,
} from "~/db/repositories/luxuryStealSyncFailureRepository.server";
import { logger } from "~/lib/logger.server";

import type { LuxuryStealMetafieldSyncPort } from "./ports";

/**
 * Sequences ONE variant's `carat.luxury_steal` metafield sync (Slice 3 task
 * 3-2b, criteria 126, 152, docs/specs/SLICE-3-LUXURY-STEALS.md).
 *
 * OWNS THE ORDERING, per the assigning message: Postgres is the system of
 * record and has ALREADY committed by the time this function is called (the
 * admin route calls `setLuxuryStealAssignment`/`bulkAssignLuxuryStealForProduct`
 * first, then this) — this module never writes `master_variant`, only reads
 * its current state and attempts to publish it. A sync failure NEVER blocks
 * or rolls back that write: this function always returns a result, never
 * throwing for an ordinary Admin API failure, so a caller cannot accidentally
 * make the Postgres assignment conditional on Shopify being reachable.
 *
 * BOUNDED IMMEDIATE RETRY, no scheduled retry loop. Attempts the sync, and
 * if it fails, retries exactly once more immediately (no backoff — this is
 * the "bounded immediate retry at write time" the assigning message asked
 * for). If BOTH attempts fail, the failure is recorded durably via
 * `recordLuxuryStealSyncFailure` and surfaced for the admin page to show; a
 * SLOWER, human-paced retry is the admin "Retry sync" action, which calls
 * this exact same function again — there is no separate scheduled retry
 * (cron) here, which is a known, deliberately out-of-scope limitation (see
 * this task's handoff).
 *
 * NEVER TOUCHES PURCHASABILITY. Nothing in this module calls
 * `isMasterVariantLuxurySteal`, reads or writes any suspension state, or
 * otherwise affects whether the variant can be sold — criterion 152's whole
 * point, enforced structurally by there being no such call available to make.
 */

export class LuxuryStealVariantNotFoundError extends Error {
  constructor(readonly masterVariantId: string) {
    super(`No master_variant with id ${masterVariantId} — cannot sync a Luxury Steal assignment for it.`);
    this.name = "LuxuryStealVariantNotFoundError";
  }
}

export type SyncLuxuryStealAssignmentOutcome =
  | { kind: "synced"; masterVariantId: string; attempts: number; resolvedPriorFailure: boolean }
  | { kind: "skipped_not_linked"; masterVariantId: string }
  | { kind: "failed"; masterVariantId: string; failureId: string; attemptCount: number; error: string };

export interface SyncLuxuryStealAssignmentDeps {
  port: LuxuryStealMetafieldSyncPort;
  /**
   * What invoked this sync attempt — recorded as the resolution trigger IF
   * this call closes an open failure episode (never used otherwise). E.g.
   * `"automatic-retry"` for the write-time call immediately following an
   * admin assignment mutation, or `"staff:<shopify-user-id>"` for a manual
   * "Retry sync" click. See `~/domain/luxurysteals/syncFailure`'s
   * `decideRestoration` for why this is worth recording.
   */
  trigger: string;
  now?: Date;
}

/** The write-time bounded retry: one initial attempt, one immediate retry, no more. */
const MAX_ATTEMPTS = 2;

export async function syncLuxuryStealAssignment(
  masterVariantId: string,
  deps: SyncLuxuryStealAssignmentDeps
): Promise<SyncLuxuryStealAssignmentOutcome> {
  const assignment = await getLuxuryStealAssignment(masterVariantId);
  if (!assignment) {
    throw new LuxuryStealVariantNotFoundError(masterVariantId);
  }

  if (!assignment.shopifyVariantGid) {
    // Not yet linked to a Shopify variant — there is no metafield write to
    // attempt, and nothing at risk in Postgres. Distinct from a sync
    // FAILURE so the admin page does not confuse "nothing to sync yet" with
    // "Shopify rejected a real attempt".
    logger.info("luxurysteals.sync_skipped_not_linked", { masterVariantId });
    return { kind: "skipped_not_linked", masterVariantId };
  }

  const target = { shopifyVariantGid: assignment.shopifyVariantGid, isLuxurySteal: assignment.isLuxurySteal };

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await deps.port.syncAssignments([target]);

      const recovery = await recordLuxuryStealSyncSuccess({
        masterVariantId,
        trigger: deps.trigger,
        now: deps.now,
      });
      logger.info("luxurysteals.sync_succeeded", {
        masterVariantId,
        attempt,
        resolvedPriorFailure: recovery.restored,
      });
      return { kind: "synced", masterVariantId, attempts: attempt, resolvedPriorFailure: recovery.restored };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      logger.warn("luxurysteals.sync_attempt_failed", { masterVariantId, attempt, error: lastError });
    }
  }

  const failure = await recordLuxuryStealSyncFailure({ masterVariantId, error: lastError, now: deps.now });
  logger.error("luxurysteals.sync_failed", {
    masterVariantId,
    attemptCount: failure.attemptCount,
    newEpisode: failure.newEpisode,
  });
  return { kind: "failed", masterVariantId, failureId: failure.failureId, attemptCount: failure.attemptCount, error: lastError };
}

/**
 * Convenience for a bulk "apply to all variants" write (§5's product-level
 * action): syncs each variant id in turn. NOT a batched Admin API call and
 * NOT a transaction — each variant's sync succeeds or fails independently,
 * exactly like `bulkAssignLuxuryStealForProduct`'s own Postgres write is N
 * independent row updates rather than a second storage location. Sequential
 * rather than parallel: the set of ids here is always one product's variant
 * list (small, per §5), and sequential calls keep Admin API usage predictable
 * and each variant's outcome individually attributable.
 */
export async function syncLuxuryStealAssignments(
  masterVariantIds: readonly string[],
  deps: SyncLuxuryStealAssignmentDeps
): Promise<SyncLuxuryStealAssignmentOutcome[]> {
  const outcomes: SyncLuxuryStealAssignmentOutcome[] = [];
  for (const masterVariantId of masterVariantIds) {
    outcomes.push(await syncLuxuryStealAssignment(masterVariantId, deps));
  }
  return outcomes;
}
