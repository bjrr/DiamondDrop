/**
 * Sync-failure state machine — the decision layer (owner §4 in
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md; spec criteria 20-27; ruling
 * R2 in docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §16.5, which this
 * module now implements as binding).
 *
 * PURE — no database access, no I/O, no ambient clock (every "now" is a
 * parameter). Mirrors `overrideExpiry.ts`'s discipline: the repository side
 * (`app/app/db/repositories/priceSyncFailureRepository.server.ts`) resolves
 * the real `price_sync_failure` row and calls these functions with explicit
 * inputs; nothing here queries anything.
 *
 * ONE EPISODE, MANY ATTEMPTS. A `price_sync_failure` row is a FAILURE
 * EPISODE — it accumulates across retries via `attemptCount`/
 * `lastAttemptAt`/`lastError` and closes exactly once, when `resolvedAt` is
 * set by a genuine success. These functions operate on one episode's fields
 * at a time; which row is "the open episode for this variant" is a
 * repository concern (the partial unique index guarantees at most one).
 *
 * ============================================================================
 * R2 — THE AVAILABILITY PREDICATE (binding, this module's own prior ruling).
 * ============================================================================
 * A variant is withdrawn IF AND ONLY IF `suspendedAt IS NOT NULL AND
 * resolvedAt IS NULL`. NEVER `alertState`. Dismissing the persistent alert
 * (criterion 22) silences a notification; it must not be able to put an
 * unpublishable price back on sale by itself. `isVariantWithdrawn` is the
 * ONLY function in this codebase that is allowed to answer "is this variant
 * currently unavailable", precisely so that rule cannot be reimplemented
 * slightly wrong at a second call site.
 *
 * ============================================================================
 * THE 48-HOUR TRAP (criterion 23) — read this before touching either
 * `decideSuspension` or `decideRetryFailure`.
 * ============================================================================
 * The 48-hour timer anchors on `firstFailedAt` and ONLY `firstFailedAt`.
 * `lastAttemptAt` and `attemptCount` never enter the suspension comparison.
 * If they did, every retry would push the deadline forward and a variant
 * retried every 10 minutes would NEVER suspend — a guard that looks correct,
 * compiles, and passes a naive "does it suspend eventually" test, while
 * silently never firing in the one scenario (a persistently failing sync)
 * it exists to catch. `decideSuspension` takes `firstFailedAt` as its only
 * time-of-failure input for exactly this reason, and `decideRetryFailure`
 * delegates to it rather than re-deriving the comparison itself.
 */

export const SUSPENSION_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export interface SuspensionDecisionInput {
  /** When this failure EPISODE began — never the latest retry. */
  firstFailedAt: Date;
  now: Date;
}

export interface SuspensionDecision {
  shouldSuspend: boolean;
  reason: string;
}

/**
 * Boundary is INCLUSIVE: elapsed >= 48h suspends. "Exactly 48 hours" is a
 * named test case, not an incidental one — `>` alone would leave the
 * instant named by the owner's own "48 hours" wording unsuspended.
 */
export function decideSuspension(input: SuspensionDecisionInput): SuspensionDecision {
  const elapsedMs = input.now.getTime() - input.firstFailedAt.getTime();
  const shouldSuspend = elapsedMs >= SUSPENSION_THRESHOLD_MS;

  return {
    shouldSuspend,
    reason: shouldSuspend
      ? `unresolved for ${elapsedMs}ms since the first failure — at or past the 48-hour threshold`
      : `unresolved for ${elapsedMs}ms since the first failure — under the 48-hour threshold`,
  };
}

/**
 * The availability predicate (R2, binding). See the module doc comment.
 */
export function isVariantWithdrawn(input: {
  suspendedAt: Date | null;
  resolvedAt: Date | null;
}): boolean {
  return input.suspendedAt !== null && input.resolvedAt === null;
}

/**
 * Bounded exponential backoff — an ENGINEERING DEFAULT, not an owner-locked
 * figure. Owner §4 says only "retry automatically" on "a bounded backoff";
 * no schedule is specified. These three constants are tunable in one place
 * without touching a call site, the same shape as `DEFAULT_STALE_CLAIM_MS`
 * in `webhookEventRepository.server.ts`.
 *
 * "BOUNDED" MEANS THE DELAY STOPS GROWING, NOT THAT RETRIES STOP. Criterion
 * 25's auto-restore requires a LATER sync to succeed, so retrying continues
 * indefinitely at the capped interval — including past the 48-hour
 * suspension. A backoff that gave up would make auto-restore impossible.
 */
export const RETRY_BASE_DELAY_MS = 30_000; // 30 seconds
export const RETRY_BACKOFF_MULTIPLIER = 2;
export const RETRY_MAX_DELAY_MS = 30 * 60_000; // 30 minutes

export interface RetryBackoffInput {
  /** Attempts already made for this episode, including the one just failed. Minimum 1. */
  attemptCount: number;
}

export interface RetryBackoffDecision {
  nextAttemptDelayMs: number;
}

export function decideNextRetryDelay(input: RetryBackoffInput): RetryBackoffDecision {
  if (!Number.isInteger(input.attemptCount) || input.attemptCount < 1) {
    throw new RangeError(`attemptCount must be a positive integer (received ${input.attemptCount})`);
  }

  const exponent = input.attemptCount - 1;
  const uncapped = RETRY_BASE_DELAY_MS * RETRY_BACKOFF_MULTIPLIER ** exponent;

  return { nextAttemptDelayMs: Math.min(uncapped, RETRY_MAX_DELAY_MS) };
}

export interface FirstFailureOutcome {
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: 1;
  alertState: "active";
  lastError: string;
}

/** The row a brand-new failure episode is created with (owner §4: alert raised on the FIRST failure). */
export function decideFirstFailure(input: { now: Date; error: string }): FirstFailureOutcome {
  return {
    firstFailedAt: input.now,
    lastAttemptAt: input.now,
    attemptCount: 1,
    alertState: "active",
    lastError: input.error,
  };
}

export interface RetryFailureInput {
  now: Date;
  error: string;
  firstFailedAt: Date;
  attemptCountBefore: number;
  /** The episode's CURRENT suspendedAt — null if not yet suspended. */
  currentSuspendedAt: Date | null;
}

export interface RetryFailureOutcome {
  lastAttemptAt: Date;
  attemptCount: number;
  lastError: string;
  /**
   * Carried forward UNCHANGED from `currentSuspendedAt` unless this attempt
   * is the one that newly crosses the 48-hour threshold. Never reset once
   * set (R4, binding): a variant already suspended stays suspended at the
   * SAME instant it was first suspended, not the instant of its latest
   * retry — `suspended_at` is the record of when the 48-hour outage began,
   * and overwriting it forward in time would erase that.
   */
  suspendedAt: Date | null;
  /** True only on the transition from not-suspended to suspended. */
  newlySuspended: boolean;
  nextRetryDelayMs: number;
}

/**
 * A subsequent failed attempt on an ALREADY-OPEN episode. Composes
 * `decideSuspension` (the 48-hour trap, exercised through its own tests) and
 * `decideNextRetryDelay` rather than re-deriving either comparison here.
 */
export function decideRetryFailure(input: RetryFailureInput): RetryFailureOutcome {
  const attemptCount = input.attemptCountBefore + 1;
  const suspension = decideSuspension({ firstFailedAt: input.firstFailedAt, now: input.now });
  const newlySuspended = input.currentSuspendedAt === null && suspension.shouldSuspend;

  return {
    lastAttemptAt: input.now,
    attemptCount,
    lastError: input.error,
    suspendedAt: newlySuspended ? input.now : input.currentSuspendedAt,
    newlySuspended,
    nextRetryDelayMs: decideNextRetryDelay({ attemptCount }).nextAttemptDelayMs,
  };
}

export interface RestorationOutcome {
  resolvedAt: Date;
  alertState: "cleared";
}

/**
 * A genuinely successful sync (criterion 25). ALWAYS sets `resolvedAt` and
 * `alertState: cleared` TOGETHER — the outcome object carries no
 * `suspendedAt` field at all, so a caller that spreads this result cannot
 * accidentally null it out. Availability is restored because
 * `isVariantWithdrawn` reads `resolvedAt`, not because anything here touches
 * `suspendedAt` directly (R4: never nulled, ever).
 */
export function decideRestoration(input: { now: Date }): RestorationOutcome {
  return { resolvedAt: input.now, alertState: "cleared" };
}

export class DismissalActorRequiredError extends Error {
  constructor() {
    super("Dismissing a sync-failure alert requires the actor who dismissed it.");
    this.name = "DismissalActorRequiredError";
  }
}

export class DismissalReasonRequiredError extends Error {
  constructor() {
    super("Dismissing a sync-failure alert requires a reason (owner §4.3).");
    this.name = "DismissalReasonRequiredError";
  }
}

export interface DismissalOutcome {
  alertState: "dismissed";
  dismissedBy: string;
  dismissedReason: string;
  dismissedAt: Date;
}

/**
 * A human silencing the persistent alert (owner §4.3, criterion 22).
 *
 * The outcome object carries NEITHER `resolvedAt` NOR `suspendedAt` — by
 * construction, not by caller discipline. A dismissal cannot resolve the
 * episode and cannot lift a suspension (R2's whole point): those two facts
 * are only ever produced by `decideRestoration`, from a genuine sync
 * success, never from this function.
 */
export function decideDismissal(input: { actor: string; reason: string; now: Date }): DismissalOutcome {
  if (!input.actor || input.actor.trim() === "") throw new DismissalActorRequiredError();
  if (!input.reason || input.reason.trim() === "") throw new DismissalReasonRequiredError();

  return {
    alertState: "dismissed",
    dismissedBy: input.actor.trim(),
    dismissedReason: input.reason.trim(),
    dismissedAt: input.now,
  };
}
