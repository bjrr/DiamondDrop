import type { PriceSyncIntent } from "@prisma/client";

import { logger } from "~/lib/logger.server";

import { type DecisionInput, decideIntent } from "./intentTransitions.server";
import type { ShopifyPriceSyncPort } from "./ports";
import { type SyncOutcome, syncApprovedPriceSyncIntent } from "./syncApprovedIntent.server";

/**
 * Closes criterion 59 (spec §16.8) — the "half of F-27" gap. A human approval
 * reached `approved` and stopped; nothing then published it. This is now the
 * ONLY way a human approval reaches Shopify, and it does so by calling the
 * exact same `syncApprovedPriceSyncIntent` the auto-apply branch of
 * `runRecalculation.server.ts` calls — not a second implementation that could
 * drift from it (§16.8: "coupling an Admin API call into a state-transition
 * function would be the wrong layering", which is why the call sits HERE,
 * outside `decideIntent`, rather than inside it).
 *
 * `decideIntent` stays a pure state transition (unchanged, still importable
 * and testable with no Shopify involved). This module is the layer that
 * INVOKES the approval and, only when the decision was "approved", follows it
 * with the one real publish function. A "rejected" decision never reaches the
 * port — there is nothing to sync.
 *
 * FAILURE MATCHES AUTO-APPLY, ON PURPOSE. `runRecalculation.server.ts` gives
 * its own auto-apply sync call an independent try/catch so a Shopify failure
 * is never mistaken for a calculation failure, and does not rethrow — the
 * run keeps going and T4's failure machinery (spec §4.4) picks the `syncing`
 * intent up from there. A manual approval must degrade the same way: the
 * approval itself already happened and is real (decideIntent's transaction
 * committed and wrote its own audit event) — a subsequent publish failure
 * must not un-approve it or be swallowed as if publish had succeeded either.
 * So this function does not throw the sync error; it returns it, and the
 * caller (the CLI today, an admin route later) is responsible for saying so
 * plainly rather than printing a bare "approved" that implies more than is
 * true.
 */

export interface DecideAndSyncResult {
  intent: PriceSyncIntent;
  /** Present only when `input.status === "approved"` and the sync attempt ran. */
  sync?: SyncOutcome;
  /**
   * Present only when the sync attempt THREW. Mirrors the boundary
   * `syncApprovedPriceSyncIntent` documents: an Admin API failure propagates
   * with the intent left in `syncing`, for T4's retry/suspension path — this
   * function catches it here only so a manual approval does not crash the
   * caller the way the auto-apply branch does not crash the run.
   */
  syncError?: Error;
}

export interface DecideAndSyncDeps {
  port: ShopifyPriceSyncPort;
}

export async function decideAndSyncIntent(
  input: DecisionInput,
  deps: DecideAndSyncDeps
): Promise<DecideAndSyncResult> {
  const intent = await decideIntent(input);

  if (input.status !== "approved") {
    // Rejections need no publish — the intent is terminal already.
    return { intent };
  }

  try {
    const sync = await syncApprovedPriceSyncIntent(intent.id, { port: deps.port });
    return { intent, sync };
  } catch (error) {
    const syncError = error instanceof Error ? error : new Error(String(error));
    // Same log event name / shape as the auto-apply branch's own catch in
    // runRecalculation.server.ts, so an operator grepping logs for a failed
    // publish finds both paths under one search regardless of which one ran.
    logger.error("pricing.manual_publish_failed", {
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
      error: syncError.name,
    });
    return { intent, syncError };
  }
}
