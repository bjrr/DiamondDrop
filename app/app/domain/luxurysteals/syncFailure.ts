/**
 * Luxury Steal metafield sync-failure state machine — the decision layer
 * (Slice 3 task 3-2b, criterion 152, docs/specs/SLICE-3-LUXURY-STEALS.md).
 *
 * PURE — no database access, no I/O, no ambient clock (every "now" is a
 * parameter). Same discipline as `~/domain/pricing/syncFailure` and
 * `~/domain/pricing/calculationFailure`: the repository side
 * (`app/app/db/repositories/luxuryStealSyncFailureRepository.server.ts`)
 * resolves the real `luxury_steal_sync_failure` row and calls the functions
 * below with explicit inputs.
 *
 * ============================================================================
 * WHY THIS MODULE HAS NO SUSPENSION LOGIC AT ALL — read this before adding
 * any.
 * ============================================================================
 * `~/domain/pricing/syncFailure` and `~/domain/pricing/calculationFailure`
 * both carry a `decideSuspension`/`isVariantWithdrawn` pair because CLAUDE.md
 * rule 17 makes an unresolved price failure withdraw the variant after 48
 * hours. Criterion 152 explicitly narrows that rule for THIS failure: a
 * failed `carat.luxury_steal` metafield sync leaves the storefront missing a
 * badge/disclosure/acknowledgment gate, not selling at a wrong price, and
 * criterion 127 already makes that fail SAFE the other way — the order-time
 * check reads Postgres directly, never this cache, so an out-of-sync variant
 * is still caught and held rather than silently fulfilled. Withdrawing a
 * correctly-priced, in-stock variant because a boolean did not reach a cache
 * would be a WORSE outcome than the defect, and self-inflicted.
 *
 * So there is no `firstFailedAt`-anchored 48-hour comparison here, no
 * `suspendedAt`, and no availability predicate — not because someone forgot
 * to port them over, but because there is nothing in this failure mode this
 * module is allowed to use to affect purchasability. `firstFailedAt` is still
 * recorded (see below) purely as evidence of how long an episode has been
 * open for admin visibility — it drives no decision here.
 */

export interface FirstFailureOutcome {
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: 1;
  lastError: string;
}

/**
 * The row a brand-new failure episode is created with. Mirrors
 * `decideFirstFailure` in the two sibling modules, minus every field that
 * exists there only to seed a suspension timer.
 */
export function decideFirstFailure(input: { now: Date; error: string }): FirstFailureOutcome {
  return {
    firstFailedAt: input.now,
    lastAttemptAt: input.now,
    attemptCount: 1,
    lastError: input.error,
  };
}

export interface RetryFailureInput {
  now: Date;
  error: string;
  attemptCountBefore: number;
}

export interface RetryFailureOutcome {
  lastAttemptAt: Date;
  attemptCount: number;
  lastError: string;
}

/**
 * A subsequent failed attempt on an ALREADY-OPEN episode — either the
 * bounded immediate retry at write time, or a later manual "Retry sync" from
 * the admin page. Deliberately takes no `firstFailedAt` and computes no
 * suspension: unlike the two sibling modules, there is no 48-hour trap to
 * guard against here, because there is no 48-hour consequence at all.
 */
export function decideRetryFailure(input: RetryFailureInput): RetryFailureOutcome {
  return {
    lastAttemptAt: input.now,
    attemptCount: input.attemptCountBefore + 1,
    lastError: input.error,
  };
}

export class LuxuryStealSyncResolutionTriggerRequiredError extends Error {
  constructor() {
    super(
      "Resolving a Luxury Steal sync-failure episode requires the trigger " +
        "that caused the successful sync (e.g. \"automatic-retry\" or " +
        "\"staff:<shopify-user-id>\")."
    );
    this.name = "LuxuryStealSyncResolutionTriggerRequiredError";
  }
}

export interface RestorationOutcome {
  resolvedAt: Date;
  resolvedTrigger: string;
}

/**
 * A genuinely successful sync. ALWAYS sets `resolvedAt` and
 * `resolvedTrigger` TOGETHER (mirrors the schema's own CHECK constraint,
 * `luxury_steal_sync_failure_resolution_pairing`). There is no
 * `suspendedAt` anywhere in this module for a caller to accidentally leave
 * stale — availability was never affected by this failure mode in the first
 * place.
 *
 * REQUIRES a non-blank `trigger`, same discipline as
 * `~/domain/pricing/calculationFailure`'s `decideRestoration`: this episode
 * can close from either the bounded immediate retry at write time or a
 * human's manual retry, and recording which one happened is worth keeping,
 * unlike `~/domain/pricing/syncFailure`'s equivalent (a price sync's
 * resolution is always "a later sync succeeded", nothing further to name).
 */
export function decideRestoration(input: { now: Date; trigger: string }): RestorationOutcome {
  if (!input.trigger || input.trigger.trim() === "") {
    throw new LuxuryStealSyncResolutionTriggerRequiredError();
  }
  return { resolvedAt: input.now, resolvedTrigger: input.trigger.trim() };
}
