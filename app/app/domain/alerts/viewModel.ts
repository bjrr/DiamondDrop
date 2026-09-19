import type { CalculationFailureType } from "~/domain/pricing/calculationFailure";

import type { AlertSourceKind, AlertStatus } from "./types";

/**
 * The admin-alert view model — the single source both the persistent
 * embedded-admin surface and the notification email render from (team-lead
 * directive: "so the admin surface and the email body render from ONE
 * source rather than two that can disagree").
 *
 * PURE — no database access, no I/O, no ambient clock (`now` is a
 * parameter), same discipline as `~/domain/pricing/calculationFailure` and
 * `~/domain/pricing/syncFailure`. The repository side
 * (`app/db/repositories/adminAlertRepository.server.ts` for the admin
 * listing, `app/db/repositories/adminAlertDispatch.server.ts` for the
 * notification) resolves the real `price_calculation_failure` /
 * `price_sync_failure` row plus its `master_variant`/`master_product` join
 * and calls `buildAlertViewModel` with explicit inputs.
 *
 * NOT mechanically fenced by `app/domain/pricing/layering.test.ts` (that
 * test's directory walk covers `app/domain/pricing` only), but held to the
 * same rule by convention: no `~/db/`, no `@prisma/client`, no `.server`
 * import, no `process.env`, no `Date.now()`/`new Date()`. A future criterion
 * extending that fence to this directory should find nothing to change.
 */

export const SUSPENSION_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/**
 * Deliberately its OWN constant, not imported from
 * `~/domain/pricing/calculationFailure` or `~/domain/pricing/syncFailure` —
 * mirrors those two modules' own choice to each define the figure
 * independently (see their doc comments) even though all three currently
 * agree on 48 hours. This module observes BOTH failure kinds and must not
 * make either one's module the source of truth for a number owner §7 and
 * owner §15 each specify on their own terms.
 */

export type AlertFailureDetail =
  | { sourceKind: "calculation_failure"; failureType: CalculationFailureType }
  | { sourceKind: "sync_failure" };

export interface AlertEpisodeInput {
  /** The failure episode's own id (`price_calculation_failure.id` or `price_sync_failure.id`). */
  sourceId: string;
  masterVariantId: string;
  /** Resolved product name — the repository's join, never looked up here. */
  product: string;
  /** Resolved variant description (metal, purity, band) — the repository's join. */
  variant: string;
  firstFailedAt: Date;
  lastAttemptAt: Date;
  attemptCount: number;
  /**
   * The stored failure/rejection message. Trusted as already safe to
   * surface off-infrastructure (an email body): both source repositories
   * populate this from a thrown error's `.message` via a NAMED error type
   * (see `~/domain/pricing/errors.ts` and the Admin API rejection reason),
   * never from a cost/margin breakdown. This module does not re-sanitize
   * it — see the dispatch module's own doc comment for the line this rule
   * draws.
   */
  lastError: string;
  suspendedAt: Date | null;
  resolvedAt: Date | null;
  now: Date;
  detail: AlertFailureDetail;
}

export interface AlertLatestRetry {
  attemptedAt: Date;
  attemptCount: number;
  outcome: "failed" | "succeeded";
}

export interface AlertViewModel {
  sourceKind: AlertSourceKind;
  sourceId: string;
  masterVariantId: string;
  product: string;
  variant: string;
  /**
   * Human-readable failure classification. For a calculation failure this
   * is the closed taxonomy value (`unresolved_band`, `missing_cost_input`,
   * ...). For a sync failure it is the fixed label `"sync_rejected"` —
   * Shopify's refusal has exactly one cause to name, unlike a calculation
   * failure's own taxonomy (see `AlertFailureDetail`'s doc comment).
   */
  failureType: string;
  reason: string;
  firstFailedAt: Date;
  /** Milliseconds since `firstFailedAt`, as of the `now` the caller supplied. */
  ageMs: number;
  /** Floored at zero. Zero once suspended or resolved, or once genuinely past the 48h boundary. */
  timeRemainingBeforeSuspensionMs: number;
  latestRetry: AlertLatestRetry;
  status: AlertStatus;
}

function isEpisodeSuspended(suspendedAt: Date | null, resolvedAt: Date | null): boolean {
  // Mirrors `isVariantWithdrawn` in `~/domain/pricing/calculationFailure`
  // and `~/domain/pricing/syncFailure` exactly — R2's predicate, restated
  // here rather than imported so this module stays independent of either
  // failure module (see the module doc comment above).
  return suspendedAt !== null && resolvedAt === null;
}

function describeFailureType(detail: AlertFailureDetail): string {
  return detail.sourceKind === "calculation_failure" ? detail.failureType : "sync_rejected";
}

export function buildAlertViewModel(input: AlertEpisodeInput): AlertViewModel {
  const suspended = isEpisodeSuspended(input.suspendedAt, input.resolvedAt);
  const status: AlertStatus = input.resolvedAt ? "resolved" : suspended ? "suspended" : "open";

  const ageMs = Math.max(0, input.now.getTime() - input.firstFailedAt.getTime());
  const timeRemainingBeforeSuspensionMs =
    status === "open" ? Math.max(0, SUSPENSION_THRESHOLD_MS - ageMs) : 0;

  const latestRetry: AlertLatestRetry =
    status === "resolved"
      ? {
          attemptedAt: input.resolvedAt as Date,
          attemptCount: input.attemptCount,
          outcome: "succeeded",
        }
      : {
          attemptedAt: input.lastAttemptAt,
          attemptCount: input.attemptCount,
          outcome: "failed",
        };

  return {
    sourceKind: input.detail.sourceKind,
    sourceId: input.sourceId,
    masterVariantId: input.masterVariantId,
    product: input.product,
    variant: input.variant,
    failureType: describeFailureType(input.detail),
    reason: input.lastError,
    firstFailedAt: input.firstFailedAt,
    ageMs,
    timeRemainingBeforeSuspensionMs,
    latestRetry,
    status,
  };
}
