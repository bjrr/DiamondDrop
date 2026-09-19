import type { AlertViewModel } from "./viewModel";
import type { AlertEvent } from "./types";

/**
 * Renders the notification email's subject/body from the SAME
 * `AlertViewModel` the admin surface reads (see `viewModel.ts`'s doc
 * comment). PURE — no I/O, no clock; every fact it prints was already
 * computed onto the view model by the caller.
 *
 * SECURITY (team-lead directive): this text leaves CaratForUs
 * infrastructure. It prints product, variant, failure type, the stored
 * failure `reason`, and timing/status facts only — never a cost, margin,
 * landed-cost, pricing-profile internal, uplift rate, rule id, token or
 * secret. `AlertViewModel.reason` is already scoped to plain failure text
 * by its producing repository (see `viewModel.ts`'s `AlertEpisodeInput.lastError`
 * doc comment); this function does not attempt a second sanitization pass
 * and must not be treated as one.
 */

export interface AlertEmailContent {
  subject: string;
  text: string;
}

const KIND_LABEL: Record<AlertViewModel["sourceKind"], string> = {
  calculation_failure: "Pricing calculation failure",
  sync_failure: "Shopify price sync failure",
};

const EVENT_LABEL: Record<AlertEvent, string> = {
  opened: "New",
  suspended: "Variant unavailable (48h unresolved)",
  resolved: "Resolved",
};

/**
 * `7265000` -> `"2h 1m"`. Zero minutes still prints `"0h 0m"` rather than an
 * empty string.
 *
 * Integer arithmetic rather than `Math.floor` — not because this is money,
 * but because the repo-wide guard against ad-hoc rounding
 * (`no-restricted-syntax` in `.eslintrc.cjs`) is deliberately blunt with no
 * allowlist, and a duration is not worth an exception to a rule that exists
 * to protect prices (same reasoning as `~/domain/groupbuy/campaignProgress.ts`'s
 * countdown). Subtracting the remainder before dividing floors exactly for
 * any non-negative `ms`, which every caller here already guarantees
 * (`AlertViewModel.ageMs`/`timeRemainingBeforeSuspensionMs` are never
 * negative).
 */
function formatDuration(ms: number): string {
  const totalMinutes = (ms - (ms % 60_000)) / 60_000;
  const hours = (totalMinutes - (totalMinutes % 60)) / 60;
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function formatTimeRemaining(viewModel: AlertViewModel): string {
  if (viewModel.status === "resolved") return "n/a — resolved";
  if (viewModel.status === "suspended") return "n/a — variant already unavailable";
  return formatDuration(viewModel.timeRemainingBeforeSuspensionMs);
}

export function renderAlertEmail(viewModel: AlertViewModel, event: AlertEvent): AlertEmailContent {
  const kindLabel = KIND_LABEL[viewModel.sourceKind];
  const eventLabel = EVENT_LABEL[event];

  const subject = `[CaratForUs admin] ${eventLabel} — ${kindLabel}: ${viewModel.product} (${viewModel.variant})`;

  const lines = [
    `${kindLabel} — ${eventLabel}`,
    "",
    `Product: ${viewModel.product}`,
    `Variant: ${viewModel.variant}`,
    `Failure type: ${viewModel.failureType}`,
    `Reason: ${viewModel.reason}`,
    `First failed at: ${viewModel.firstFailedAt.toISOString()}`,
    `Age: ${formatDuration(viewModel.ageMs)}`,
    `Time remaining before 48h cutoff: ${formatTimeRemaining(viewModel)}`,
    `Latest retry: attempt #${viewModel.latestRetry.attemptCount} at ` +
      `${viewModel.latestRetry.attemptedAt.toISOString()} — ${viewModel.latestRetry.outcome}`,
    `Status: ${viewModel.status}`,
  ];

  return { subject, text: lines.join("\n") };
}
