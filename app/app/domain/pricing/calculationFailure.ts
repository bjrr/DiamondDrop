/**
 * Recalculation-failure state machine — the decision layer (owner §7 in
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md; sibling to
 * `syncFailure.ts`, which implements owner §4/§15 and ruling R2 in
 * docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §16.5).
 *
 * PURE — no database access, no I/O, no ambient clock (every "now" is a
 * parameter). Same discipline as `syncFailure.ts`: the repository side
 * (`app/app/db/repositories/priceCalculationFailureRepository.server.ts`)
 * resolves the real `price_calculation_failure` row and calls these
 * functions with explicit inputs; nothing here queries anything.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE MODULE FROM syncFailure.ts, NOT A SHARED ONE.
 * ============================================================================
 * A sync failure means a price WAS computed and Shopify refused to accept
 * it. A calculation failure means NO price could be computed at all — an
 * unresolved ring-size band, a missing stone cost, an invalid weight, absent
 * labour/metal inputs, a currency mismatch, or an unavailable pricing
 * rule/profile (owner §7's own examples). The remedies rhyme (keep the last
 * valid price live, a 48-hour unresolved timer anchored on the FIRST
 * failure, an automatic no-human-action restore) but the cause taxonomy, the
 * admin diagnosis and the recovery trigger are different, and collapsing
 * both into one table/module would make "what is actually wrong with this
 * variant" unanswerable. Two concrete differences from syncFailure.ts:
 *
 *   1. `CalculationFailureType` — a CLOSED, typed cause taxonomy
 *      (classifyCalculationFailureType below), not a freeform message.
 *      price_sync_failure has no equivalent; a sync failure's cause is
 *      always "Shopify refused the write" and only the message varies.
 *   2. NO dismissible alert. price_sync_failure's alert_state (active /
 *      cleared / dismissed) exists because owner §4/§15 describes a
 *      PERSISTENT alert a human can silence. Owner §7 describes only an
 *      immediate one-time notification on the first failure — there is
 *      nothing here for that dismiss/resolve split to apply to.
 *   3. `decideRestoration` here REQUIRES a `trigger` (owner §7 recovery step
 *      5: "record the resolution timestamp and trigger/actor"). A sync's
 *      resolution is always "a later sync succeeded" with no separate actor
 *      to name; a calculation can be corrected by either the next routine
 *      recalculation run or a deliberate staff action, and owner §7 requires
 *      telling those apart.
 *
 * NO RETRY-BACKOFF SCHEDULE HERE (unlike syncFailure.ts's
 * decideNextRetryDelay). A sync failure retries against a live external API
 * on its own timer; a calculation failure is naturally re-attempted by the
 * NEXT price recalculation (scheduled, or triggered by the input correction
 * itself via `pricing_input_change`) — there is no independent retry loop
 * for this module to schedule.
 *
 * ============================================================================
 * THE AVAILABILITY PREDICATE — same shape as syncFailure.ts's R2, restated
 * here because R2 is binding on every failure-episode table this slice adds,
 * not only price_sync_failure.
 * ============================================================================
 * A variant is withdrawn IF AND ONLY IF `suspendedAt IS NOT NULL AND
 * resolvedAt IS NULL`. `isVariantWithdrawn` is the ONLY function in this
 * module allowed to answer "is this variant currently unavailable because of
 * a calculation failure", precisely so the rule cannot be reimplemented
 * slightly wrong at a second call site.
 *
 * ============================================================================
 * THE 48-HOUR TRAP (owner §7: "repeated retries must not reset the 48-hour
 * timer") — read this before touching either `decideSuspension` or
 * `decideRetryFailure`.
 * ============================================================================
 * The 48-hour timer anchors on `firstFailedAt` and ONLY `firstFailedAt`.
 * `lastAttemptAt` and `attemptCount` never enter the suspension comparison.
 * If they did, every retry would push the deadline forward and a variant
 * retried on every recalculation run would NEVER suspend — a guard that
 * looks correct, compiles, and passes a naive "does it suspend eventually"
 * test, while silently never firing in the one scenario (a persistently
 * unresolvable calculation) it exists to catch. `decideSuspension` takes
 * `firstFailedAt` as its only time-of-failure input for exactly this reason,
 * and `decideRetryFailure` delegates to it rather than re-deriving the
 * comparison itself.
 */

/**
 * Owner §7's own 48-hour window. Defined independently of
 * `syncFailure.ts`'s `SUSPENSION_THRESHOLD_MS` rather than imported from it:
 * the two failure modes are conceptually separate (owner ruling), so one
 * module must not depend on the other even though the current figures
 * happen to agree.
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
 * named test case, not an incidental one.
 */
export function decideSuspension(input: SuspensionDecisionInput): SuspensionDecision {
  const elapsedMs = input.now.getTime() - input.firstFailedAt.getTime();
  const shouldSuspend = elapsedMs >= SUSPENSION_THRESHOLD_MS;

  return {
    shouldSuspend,
    reason: shouldSuspend
      ? `unresolved for ${elapsedMs}ms since the first calculation failure — at or past the 48-hour threshold`
      : `unresolved for ${elapsedMs}ms since the first calculation failure — under the 48-hour threshold`,
  };
}

/**
 * The availability predicate. See the module doc comment.
 */
export function isVariantWithdrawn(input: { suspendedAt: Date | null; resolvedAt: Date | null }): boolean {
  return input.suspendedAt !== null && input.resolvedAt === null;
}

/**
 * How much of the 48-hour window remains before an unresolved episode would
 * cross into suspension — the "time remaining before automatic
 * unavailability" admin visibility requires. Floored at zero: an already
 * -suspended episode has none left, never a negative number.
 */
export function timeRemainingBeforeSuspensionMs(input: { firstFailedAt: Date; now: Date }): number {
  const elapsedMs = input.now.getTime() - input.firstFailedAt.getTime();
  return Math.max(0, SUSPENSION_THRESHOLD_MS - elapsedMs);
}

/**
 * The calculation-failure cause taxonomy (owner §7's own examples): an
 * unresolved ring-size band, a missing stone cost, an invalid weight, absent
 * labour/metal inputs, a currency mismatch, or an unavailable pricing
 * rule/profile.
 */
export type CalculationFailureType =
  | "unresolved_band"
  | "invalid_size"
  | "invalid_weight"
  | "missing_cost_input"
  | "ambiguous_cost_input"
  | "currency_mismatch"
  | "margin_unreachable"
  | "unknown";

/**
 * Maps a thrown error's `.name` to a taxonomy value. Takes only the NAME
 * (never the message) so this module stays clear of leaking cost structure
 * (the same discipline `runPriceRecalculation` already applies when logging:
 * `app/app/jobs/pricing/runRecalculation.server.ts` logs `error.name` only),
 * and — just as importantly — so this file can classify the engine's own
 * named errors (`app/app/domain/pricing/errors.ts`) and the repository
 * layer's cost-resolution errors (`MissingCostInputError`,
 * `AmbiguousCostInputError` in `effectiveDated.server.ts`) and the job
 * layer's `BandResolutionError` (`jobs/pricing/ports.ts`) WITHOUT importing
 * any of them — importing from `~/db/` or a `.server` module here would trip
 * `layering.test.ts`'s fence (criterion 34: L3 depends on nothing).
 *
 * An unrecognised name maps to `"unknown"` rather than guessing — a silent
 * default in either direction is exactly the class of bug §5's named errors
 * exist to prevent for prices, and the same principle applies to classifying
 * failures about them.
 */
const ERROR_NAME_TO_FAILURE_TYPE: Readonly<Record<string, CalculationFailureType>> = {
  InvalidBandError: "unresolved_band",
  BandResolutionError: "unresolved_band",
  InvalidSizeError: "invalid_size",
  InvalidWeightError: "invalid_weight",
  MissingCostInputError: "missing_cost_input",
  AmbiguousCostInputError: "ambiguous_cost_input",
  PricingCurrencyMismatchError: "currency_mismatch",
  UnreachableMarginError: "margin_unreachable",
  MarginFloorUnreachableError: "margin_unreachable",
};

export function classifyCalculationFailureType(errorName: string): CalculationFailureType {
  return ERROR_NAME_TO_FAILURE_TYPE[errorName] ?? "unknown";
}

export interface FirstFailureOutcome {
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: 1;
  failureType: CalculationFailureType;
  lastError: string;
}

/**
 * The row a brand-new failure episode is created with (owner §7: "notify
 * the admin immediately" on the first failure). This function does not send
 * any notification itself — see the repository's `newEpisode` result flag —
 * it only decides the row's initial shape.
 */
export function decideFirstFailure(input: {
  now: Date;
  errorName: string;
  error: string;
}): FirstFailureOutcome {
  return {
    firstFailedAt: input.now,
    lastAttemptAt: input.now,
    attemptCount: 1,
    failureType: classifyCalculationFailureType(input.errorName),
    lastError: input.error,
  };
}

export interface RetryFailureInput {
  now: Date;
  errorName: string;
  error: string;
  firstFailedAt: Date;
  attemptCountBefore: number;
  /** The episode's CURRENT suspendedAt — null if not yet suspended. */
  currentSuspendedAt: Date | null;
}

export interface RetryFailureOutcome {
  lastAttemptAt: Date;
  attemptCount: number;
  /**
   * Reclassified on every attempt — a later retry within the SAME open
   * episode can hit a different unresolved input than the first attempt did
   * (e.g. a missing labour rate gets fixed, and the next attempt then finds
   * a missing stone cost). The episode stays open either way; only the
   * recorded cause and message move forward to the latest attempt.
   */
  failureType: CalculationFailureType;
  lastError: string;
  /**
   * Carried forward UNCHANGED from `currentSuspendedAt` unless this attempt
   * is the one that newly crosses the 48-hour threshold. Never reset once
   * set: a variant already suspended stays suspended at the SAME instant it
   * was first suspended, not the instant of its latest retry.
   */
  suspendedAt: Date | null;
  /** True only on the transition from not-suspended to suspended. */
  newlySuspended: boolean;
}

/**
 * A subsequent failed attempt on an ALREADY-OPEN episode. Composes
 * `decideSuspension` (the 48-hour trap) rather than re-deriving the
 * comparison here.
 */
export function decideRetryFailure(input: RetryFailureInput): RetryFailureOutcome {
  const attemptCount = input.attemptCountBefore + 1;
  const suspension = decideSuspension({ firstFailedAt: input.firstFailedAt, now: input.now });
  const newlySuspended = input.currentSuspendedAt === null && suspension.shouldSuspend;

  return {
    lastAttemptAt: input.now,
    attemptCount,
    failureType: classifyCalculationFailureType(input.errorName),
    lastError: input.error,
    suspendedAt: newlySuspended ? input.now : input.currentSuspendedAt,
    newlySuspended,
  };
}

export class ResolutionTriggerRequiredError extends Error {
  constructor() {
    super(
      "Resolving a calculation-failure episode requires the trigger/actor that " +
        "caused the successful recalculation (owner §7 recovery step 5)."
    );
    this.name = "ResolutionTriggerRequiredError";
  }
}

export interface RestorationOutcome {
  resolvedAt: Date;
  resolvedTrigger: string;
}

/**
 * A genuinely successful recalculation (owner §7 recovery). ALWAYS sets
 * `resolvedAt` and `resolvedTrigger` TOGETHER — the outcome object carries
 * no `suspendedAt` field at all, so a caller that spreads this result cannot
 * accidentally null it out (same discipline as syncFailure.ts's
 * `decideRestoration`). Availability is restored because `isVariantWithdrawn`
 * reads `resolvedAt`, not because anything here touches `suspendedAt`
 * directly — `suspendedAt` is never cleared, ever.
 *
 * REQUIRES a non-blank `trigger`, unlike syncFailure.ts's equivalent: a
 * sync's resolution is always "a later sync succeeded" with nothing further
 * to name, but owner §7 explicitly requires recording WHAT triggered the
 * successful recalculation — the routine scheduler or a specific member of
 * staff.
 */
export function decideRestoration(input: { now: Date; trigger: string }): RestorationOutcome {
  if (!input.trigger || input.trigger.trim() === "") throw new ResolutionTriggerRequiredError();

  return { resolvedAt: input.now, resolvedTrigger: input.trigger.trim() };
}
