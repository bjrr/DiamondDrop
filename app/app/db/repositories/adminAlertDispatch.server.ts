import { renderAlertEmail } from "~/domain/alerts/emailContent";
import type { AlertEvent, AlertSourceKind } from "~/domain/alerts/types";
import { resolveEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { logger } from "~/lib/logger.server";

import { loadCalculationAlertViewModel, loadSyncAlertViewModel } from "./adminAlertEpisodes.server";
import { recordAlertNotification } from "./adminAlertNotificationRepository.server";

/**
 * The dispatch entry point (Slice 2 stage 2A, owner §7: "notify the admin
 * immediately"; owner §15: "notify admin ... through both email and a
 * persistent embedded-admin alert"). Called from the existing wiring points
 * in `app/jobs/pricing/` — `runRecalculation.server.ts` on a calculation
 * -failure episode opening/suspending/resolving, `syncApprovedIntent.server.ts`
 * on the sync-failure equivalents — never from inside
 * `priceCalculationFailureRepository.server.ts` or
 * `priceSyncFailureRepository.server.ts` themselves, which stay untouched.
 *
 * WHY A CALLER PASSES `event` RATHER THAN THIS FUNCTION INFERRING IT. The
 * caller already knows exactly which transition just happened — it is
 * reading `newEpisode`/`newlySuspended` off `recordCalculationFailure`'s own
 * return value, or `restored` off `recordCalculationSuccess`'s — and that
 * transition is the ONLY thing that should ever produce a notification.
 * Recomputing "did this just open/suspend/resolve" from the row's current
 * state here would fire again on every subsequent retry of an
 * already-suspended episode, exactly the spam owner §7/§15 rule out.
 *
 * THREE PER EPISODE, MAXIMUM. Each of `opened`/`suspended`/`resolved` can
 * produce at most one notification row per episode — enforced by
 * `admin_alert_notification`'s own unique constraint via
 * `recordAlertNotification`'s insert-and-catch-unique, not by any check in
 * this function. A caller invoking `dispatchAdminAlert` twice for the same
 * (sourceKind, sourceId, event) is safe: the second call still resolves the
 * email port and view model (see the ordering note below) but its
 * `recordAlertNotification` call returns `recorded: false` and this
 * function returns `dispatched: false`.
 *
 * ORDERING: SEND, THEN CLAIM — not claim-then-send. This function attempts
 * delivery (or determines it is unconfigured) BEFORE inserting the
 * dedup row, deliberately the opposite order from the
 * claim-before-attempt shape `app/domain/idempotency` uses for payment
 * -adjacent operations. That module's ordering exists to guarantee
 * at-most-once execution of something with an external side effect that
 * must never double-fire; an admin notification email has no such
 * guarantee to protect, and the failure mode of the OTHER ordering —
 * claim first, then crash before sending — is worse here: it would
 * permanently mark this (episode, event) as "notified" via the unique
 * constraint while no email was ever sent, with no way to retry. The
 * accepted tradeoff is the reverse, rarer failure: two truly concurrent
 * callers for the same brand-new transition could each send one email
 * before either has inserted its row. Given `newEpisode`/`newlySuspended`/
 * `restored` are each true for exactly one caller under this codebase's
 * existing per-variant concurrency guarantees (the partial unique index on
 * each failure table's OPEN episode), that race requires two concurrent
 * recalculation/sync runs landing on the identical transition for the
 * identical variant at the same instant — far rarer than a mid-send crash.
 */

export interface DispatchAdminAlertInput {
  sourceKind: AlertSourceKind;
  /** The episode's own id (`price_calculation_failure.id` or `price_sync_failure.id`). */
  sourceId: string;
  event: AlertEvent;
  now?: Date;
}

export interface DispatchAdminAlertResult {
  /** False when the episode no longer exists, or this (episode, event) was already notified. */
  dispatched: boolean;
  emailDeliveryStatus?: "sent" | "skipped_unconfigured" | "failed";
}

export interface DispatchAdminAlertDeps {
  /**
   * Defaults to the real `resolveEmailPort` (reads process env). Injectable
   * so a test can exercise the `sent`/`failed` branches with a fake
   * `EmailPort` without setting real `EMAIL_API_KEY`/`EMAIL_FROM`/
   * `STAFF_EMAIL_ALLOWLIST` — same `deps` seam
   * `syncApprovedPriceSyncIntent` uses for its `ShopifyPriceSyncPort`.
   */
  resolveEmailPort: () => EmailPortResolution;
}

const DEFAULT_DEPS: DispatchAdminAlertDeps = { resolveEmailPort };

export async function dispatchAdminAlert(
  input: DispatchAdminAlertInput,
  deps: DispatchAdminAlertDeps = DEFAULT_DEPS
): Promise<DispatchAdminAlertResult> {
  const now = input.now ?? new Date();

  const viewModel =
    input.sourceKind === "calculation_failure"
      ? await loadCalculationAlertViewModel(input.sourceId, now)
      : await loadSyncAlertViewModel(input.sourceId, now);

  if (!viewModel) {
    // Should not happen in practice (the caller only ever passes an id it
    // just read/wrote), but a missing episode must not throw and abort the
    // job that is calling this from inside its own try/catch either way —
    // logged, not silent.
    logger.error("admin_alert.dispatch_episode_not_found", {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      event: input.event,
    });
    return { dispatched: false };
  }

  const email = renderAlertEmail(viewModel, input.event);
  const resolution = deps.resolveEmailPort();

  let emailDeliveryStatus: "sent" | "skipped_unconfigured" | "failed";
  let emailDeliveryReason: string | null = null;
  let emailProviderMessageId: string | null = null;

  if (!resolution.configured) {
    emailDeliveryStatus = "skipped_unconfigured";
    emailDeliveryReason = resolution.reason;
    // Distinctly named so "we claimed to notify but did not" is never
    // confused with an ordinary error log line elsewhere in the pricing
    // jobs (team-lead directive: a row/log claiming delivery when none
    // occurred is worse than no row at all).
    logger.error("admin_alert.email_unconfigured", {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      event: input.event,
      reason: resolution.reason,
    });
  } else {
    try {
      const sent = await resolution.port.send({
        from: resolution.from,
        to: resolution.recipients,
        subject: email.subject,
        text: email.text,
      });
      emailDeliveryStatus = "sent";
      emailProviderMessageId = sent.providerMessageId;
    } catch (error) {
      emailDeliveryStatus = "failed";
      // Name only — never the caught error's message, which for an
      // EmailSendError from `ResendEmailPort` is already scoped to a status
      // code, but this keeps the same "name only" discipline every other
      // failure-log line in this codebase follows (criterion 30).
      emailDeliveryReason = error instanceof Error ? error.name : "UnknownError";
      logger.error("admin_alert.email_send_failed", {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        event: input.event,
        error: emailDeliveryReason,
      });
    }
  }

  const recorded = await recordAlertNotification({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    event: input.event,
    masterVariantId: viewModel.masterVariantId,
    emailDeliveryStatus,
    emailDeliveryReason,
    emailProviderMessageId,
    now,
  });

  if (!recorded.recorded) {
    logger.info("admin_alert.duplicate_suppressed", {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      event: input.event,
    });
  }

  return { dispatched: recorded.recorded, emailDeliveryStatus };
}
