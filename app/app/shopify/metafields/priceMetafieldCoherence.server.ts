import { prisma } from "~/db/client.server";
import { dispatchAdminAlert } from "~/db/repositories/adminAlertDispatch.server";
import { recordSyncFailure } from "~/db/repositories/priceSyncFailureRepository.server";
import { logger } from "~/lib/logger.server";

import {
  compareMetafieldToPublishedCalculation,
  type PriceBearingMetafieldPayload,
  type PriceMetafieldCoherenceCheck,
} from "./priceMetafieldPayload";

/**
 * The server-side coherence check C5 / criterion 56 depends on.
 *
 * Given a price-bearing metafield's own payload, resolves the variant's
 * ACTUALLY PUBLISHED calculation (via `master_variant.lastSyncedPriceCalculationId`
 * — the same criterion 52 anchor `publishedPriceRepository.server.ts` reads)
 * and compares it against the id embedded in the metafield. On a mismatch,
 * raises "the same persistent admin alert used for sync failure" — the team
 * lead's exact instruction — by reusing `price_sync_failure` and
 * `dispatchAdminAlert` verbatim rather than inventing a new failure kind.
 *
 * WHY REUSE `sync_failure` RATHER THAN A NEW ALERT KIND. Both mean the same
 * thing to staff: "what Shopify shows for this variant cannot be trusted as
 * the published price." `AdminAlertSourceKind` is a closed two-value
 * database enum (`calculation_failure` | `sync_failure`); a metafield/price
 * disagreement is not a third kind of problem needing a third response, it
 * is the SAME state-machine and the SAME 48-hour-withdrawal reasoning as an
 * Admin API publish failure, arrived at from the other write instead of the
 * price write. Adding a new enum value would need a migration and a second,
 * near-identical admin surface for no behavioural benefit.
 *
 * ONE DIRECTION ONLY. A coherent check never calls `recordSyncSuccess` —
 * doing so on the strength of a metafield merely still agreeing with the
 * database would risk silently resolving (and restoring availability for)
 * an OPEN sync-failure episode opened for a genuinely different reason
 * (e.g. a real Admin API rejection), which this check has no basis to judge
 * fixed. Only a real, successful Shopify price publish may resolve that
 * episode — this function only ever escalates, never clears.
 *
 * NOT WIRED INTO THE PUBLISH PATH. Per the team lead's Stage 2B entry
 * -condition instructions, calling this from the real publish flow is
 * Stage 2B implementation work, not this task.
 */

export interface CheckPriceMetafieldCoherenceResult extends PriceMetafieldCoherenceCheck {
  readonly masterVariantId: string;
}

export async function checkPriceMetafieldCoherence(
  payload: Pick<PriceBearingMetafieldPayload, "masterVariantId" | "priceCalculationId">
): Promise<CheckPriceMetafieldCoherenceResult> {
  const variant = await prisma.masterVariant.findUnique({
    where: { id: payload.masterVariantId },
    select: { lastSyncedPriceCalculationId: true },
  });
  const publishedPriceCalculationId = variant?.lastSyncedPriceCalculationId ?? null;

  const comparison = compareMetafieldToPublishedCalculation(payload.priceCalculationId, publishedPriceCalculationId);

  if (!comparison.coherent) {
    try {
      const failure = await recordSyncFailure({
        masterVariantId: payload.masterVariantId,
        error:
          `price metafield/variant coherence mismatch: metafield names calculation ` +
          `${payload.priceCalculationId}, but the variant's published calculation is ` +
          `${publishedPriceCalculationId ?? "none (never synced)"}`,
      });

      // Same dispatch shape `syncApprovedIntent.server.ts` uses on a real
      // Admin API failure: "opened" fires only on the attempt that newly
      // opens the episode, "suspended" only on the attempt that newly
      // crosses the 48-hour threshold. Its own try/catch: a notification
      // failure must never mask the coherence result returned below.
      try {
        if (failure.attemptCount === 1) {
          await dispatchAdminAlert({ sourceKind: "sync_failure", sourceId: failure.failureId, event: "opened" });
        }
        if (failure.newlySuspended) {
          await dispatchAdminAlert({ sourceKind: "sync_failure", sourceId: failure.failureId, event: "suspended" });
        }
      } catch (alertError) {
        logger.error("admin_alert.dispatch_failed", {
          masterVariantId: payload.masterVariantId,
          sourceKind: "sync_failure",
          event: failure.attemptCount === 1 ? "opened" : "suspended",
          error: alertError instanceof Error ? alertError.name : "UnknownError",
        });
      }
    } catch (recordError) {
      logger.error("shopify.metafield_coherence_record_failed", {
        masterVariantId: payload.masterVariantId,
        error: recordError instanceof Error ? recordError.name : "UnknownError",
      });
    }
  }

  return { ...comparison, masterVariantId: payload.masterVariantId };
}
