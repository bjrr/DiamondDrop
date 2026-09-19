import { prisma } from "~/db/client.server";
import { dispatchAdminAlert } from "~/db/repositories/adminAlertDispatch.server";
import { getLatestComputedCalculation } from "~/db/repositories/priceCalculationRepository.server";
import { recordPricingInputChangeIfPriceAffecting } from "~/db/repositories/pricingInputChangeRepository.server";
import { recordSyncFailure, recordSyncSuccess } from "~/db/repositories/priceSyncFailureRepository.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { RegularCardPriceRuleId } from "~/domain/pricing/types";
import { logger } from "~/lib/logger.server";

import { assertTransitionAllowed } from "./intentTransitions.server";
import type { ShopifyPriceSyncPort } from "./ports";

/**
 * Closes F-26/F-27 and contract C-S2: the function that actually moves an
 * `approved` intent through `syncing -> synced` on a REAL Shopify call, and
 * writes the compare-and-set anchor (`master_variant.lastSyncedPriceCalculationId`)
 * in the same transaction as that status change (spec §4.1 criterion 5).
 *
 * THE ONE FUNCTION BOTH CALLERS MUST GO THROUGH. Two things create an
 * `approved` intent today: `runRecalculation.server.ts`'s auto-apply branch
 * (a fresh intent, created directly in `approved` status) and
 * `intentTransitions.server.ts`'s `decideIntent` (a human moving a pending
 * intent to `approved`). Both must call this function afterward for the
 * intent to ever reach Shopify — see the module comment on `decideIntent`
 * for why that wiring is NOT done inside `decideIntent` itself.
 *
 * WHAT THIS FUNCTION DECIDES, IN ORDER, ALL BEFORE ANY SHOPIFY CALL:
 *   1. Already `synced`?              -> no-op, no call (criterion 10).
 *   2. Not `approved` (or a retryable `failed`... see below)?
 *                                      -> throws InvalidIntentTransitionError.
 *   3. A newer calculation exists for this variant (compare-and-set)?
 *                                      -> `superseded`, no call (criterion 6).
 *   4. The governing profile is a placeholder, checked FRESH from the
 *      database right here rather than trusting the join loaded above?
 *                                      -> refused, no call, no status change
 *                                         (criterion 7).
 *   5. The variant or its product has no Shopify id yet?
 *                                      -> throws, no call.
 *   6. Otherwise: derive the card price from THE CALCULATION'S OWN profile
 *      (never today's active one — criterion 3), call the port, and commit
 *      `synced` + the compare-and-set anchor atomically.
 *
 * A THROWN Admin API error (step 6) is NOT caught here. It propagates with
 * the intent left in `syncing`. Catching it, recording a `price_sync_failure`
 * row, raising the email/admin alerts and driving the 48h suspension timer is
 * T4's territory (spec §4.4, test plan cases 7-12) — this function's contract
 * ends at "the call was attempted and its outcome is either committed or
 * still visibly in flight", not at "failures are handled".
 */

export type SyncOutcome =
  | { kind: "already_synced"; intentId: string }
  | { kind: "superseded"; intentId: string }
  | { kind: "placeholder_refused"; intentId: string }
  | { kind: "not_applicable"; intentId: string; reason: string }
  | {
      kind: "synced";
      intentId: string;
      regularCardPriceMinorUnits: string;
      currency: string;
    };

export class PriceSyncIntentNotFoundError extends Error {
  constructor(readonly intentId: string) {
    super(`No price sync intent with id ${intentId}.`);
    this.name = "PriceSyncIntentNotFoundError";
  }
}

/**
 * A variant (or its product) has no Shopify id yet. Thrown rather than
 * treated as a normal refusal outcome: unlike a stale calculation or a
 * placeholder profile, this is a data-setup gap that needs an operator to
 * link the record, not a decision this function can classify as routine.
 */
export class ShopifyLinkageMissingError extends Error {
  constructor(
    readonly masterVariantId: string,
    readonly missing: "variant" | "product" | "both"
  ) {
    super(
      `master_variant ${masterVariantId} is missing its Shopify ${missing === "both" ? "product and variant" : missing} id — cannot sync a price to Shopify for it.`
    );
    this.name = "ShopifyLinkageMissingError";
  }
}

async function writeSyncAuditEvent(params: {
  intentId: string;
  masterVariantId: string;
  priceCalculationId: string;
  outcome: string;
  previousBankPaymentPriceMinorUnits: bigint | null;
  previousBankPaymentPriceCurrency: string | null;
  publishedRegularCardPriceMinorUnits?: string;
  publishedRegularCardPriceCurrency?: string;
  regularCardPriceRuleId?: string;
  profileVersion?: number;
  reason?: string;
}): Promise<void> {
  // §7 evidence contract: "every sync attempt writes an audit_event: actor
  // (or system), variant, intent, previous and published price, rule id,
  // profile version, outcome." This is the ONE place that promise is kept for
  // the outcomes this function owns (synced, superseded, placeholder_refused)
  // — an Admin API failure's audit event is T4's, alongside its failure row.
  await prisma.auditEvent.create({
    data: {
      actorType: "system",
      actorRef: "price-sync-job",
      action: `price_sync_intent.${params.outcome}`,
      entityType: "price_sync_intent",
      entityId: params.intentId,
      before: {
        masterVariantId: params.masterVariantId,
        priceCalculationId: params.priceCalculationId,
        previousBankPaymentPriceMinorUnits: params.previousBankPaymentPriceMinorUnits?.toString() ?? null,
        previousBankPaymentPriceCurrency: params.previousBankPaymentPriceCurrency,
      } as never,
      after:
        params.publishedRegularCardPriceMinorUnits !== undefined
          ? ({
              regularCardPriceMinorUnits: params.publishedRegularCardPriceMinorUnits,
              regularCardPriceCurrency: params.publishedRegularCardPriceCurrency,
              regularCardPriceRuleId: params.regularCardPriceRuleId,
              profileVersion: params.profileVersion,
            } as never)
          : undefined,
      reason: params.reason ?? null,
    },
  });
}

export interface SyncApprovedIntentDeps {
  port: ShopifyPriceSyncPort;
}

export async function syncApprovedPriceSyncIntent(
  intentId: string,
  deps: SyncApprovedIntentDeps
): Promise<SyncOutcome> {
  const intent = await prisma.priceSyncIntent.findUnique({
    where: { id: intentId },
    include: {
      priceCalculation: { include: { pricingProfile: true } },
      masterVariant: { include: { masterProduct: true } },
    },
  });
  if (!intent) throw new PriceSyncIntentNotFoundError(intentId);

  // Criterion 10: re-running the sync for an already-synced intent is a
  // no-op and makes NO second Admin API call. Checked before the transition
  // table, because "synced" is terminal there (no outgoing edges at all) and
  // would otherwise read as an error rather than the routine replay it is.
  if (intent.status === "synced") {
    return { kind: "already_synced", intentId };
  }

  // Throws InvalidIntentTransitionError for anything that is not `approved`
  // (pending_approval, rejected, syncing already in flight, or a terminal
  // `failed`/`superseded`). A `failed` intent must be moved back to
  // `approved` first — by whatever retry mechanism T4 builds — before it can
  // reach this function again; that is an existing rule in the transition
  // table, not a new one introduced here.
  assertTransitionAllowed(intent.status, "syncing");

  const calc = intent.priceCalculation;
  const previousBank = {
    minorUnits: intent.previousBankPaymentPriceMinorUnits,
    currency: intent.previousBankPaymentPriceCurrency,
  };

  // COMPARE-AND-SET, before any Shopify call (criterion 6, test plan case 3).
  const latest = await getLatestComputedCalculation(intent.masterVariantId);
  if (!latest || latest.id !== intent.priceCalculationId) {
    const superseded = await prisma.priceSyncIntent.updateMany({
      where: { id: intent.id, status: intent.status },
      data: { status: "superseded", reason: "a newer price calculation exists for this variant" },
    });
    if (superseded.count === 1) {
      await writeSyncAuditEvent({
        intentId: intent.id,
        masterVariantId: intent.masterVariantId,
        priceCalculationId: intent.priceCalculationId,
        outcome: "superseded",
        previousBankPaymentPriceMinorUnits: previousBank.minorUnits,
        previousBankPaymentPriceCurrency: previousBank.currency,
        reason: "a newer price calculation exists for this variant",
      });
    }
    logger.info("pricing.sync_superseded", { intentId: intent.id, masterVariantId: intent.masterVariantId });
    return { kind: "superseded", intentId };
  }

  // PLACEHOLDER RE-CHECK, immediately before the call and via its own fresh
  // query rather than trusting the `pricingProfile` object joined above
  // (criterion 7). `decideIntent` already refuses to APPROVE a
  // placeholder-derived price, and the auto-apply path in
  // runRecalculation.server.ts carries the equivalent guard — so this is
  // belt-and-braces, not the only gate. `pricing_profile` is append-only at
  // the database level (an existing row's `isPlaceholder` cannot itself
  // change; a resolved D14 arrives as a new profile VERSION), so this cannot
  // catch a profile flipping mid-flight the way an editable-row design would
  // need it to. What it DOES catch is trusting a value carried on the intent
  // or its joined calculation across an arbitrarily long approval-to-sync
  // window without ever looking at the source of truth again — cheap
  // insurance against a future refactor that starts caching or forwarding
  // that flag instead of reading it.
  const freshProfile = await prisma.pricingProfile.findUniqueOrThrow({
    where: { id: calc.pricingProfileId },
    select: { isPlaceholder: true },
  });
  if (freshProfile.isPlaceholder) {
    await writeSyncAuditEvent({
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
      priceCalculationId: intent.priceCalculationId,
      outcome: "placeholder_refused",
      previousBankPaymentPriceMinorUnits: previousBank.minorUnits,
      previousBankPaymentPriceCurrency: previousBank.currency,
      reason: "pricing profile is a placeholder — D14 unresolved",
    });
    logger.warn("pricing.sync_placeholder_refused", {
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
    });
    return { kind: "placeholder_refused", intentId };
  }

  const shopifyVariantGid = intent.masterVariant.shopifyVariantGid;
  const shopifyProductGid = intent.masterVariant.masterProduct.shopifyProductGid;
  if (!shopifyVariantGid || !shopifyProductGid) {
    throw new ShopifyLinkageMissingError(
      intent.masterVariantId,
      !shopifyVariantGid && !shopifyProductGid ? "both" : !shopifyVariantGid ? "variant" : "product"
    );
  }

  // Guarded transition into `syncing`: matches on the CURRENT status rather
  // than blindly updating by id, so a concurrent process that has already
  // moved this intent away from `approved` (e.g. a newer recalculation
  // superseding it) cannot have its state silently overwritten by this call
  // arriving late. `attemptCount` increments here because this is the one
  // place a real attempt begins, regardless of which caller invoked it.
  const began = await prisma.priceSyncIntent.updateMany({
    where: { id: intent.id, status: intent.status },
    data: { status: "syncing", attemptCount: { increment: 1 } },
  });
  if (began.count !== 1) {
    logger.warn("pricing.sync_lost_race_before_call", {
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
    });
    return { kind: "not_applicable", intentId, reason: "intent moved concurrently before sync began" };
  }

  // THE CALCULATION'S OWN PROFILE, never today's active one (criterion 3,
  // C-S2 note 2). `calc.pricingProfile` was loaded in the same query as the
  // calculation itself, so this is the profile that governed THIS price —
  // re-resolving "the active profile" here would let a rule change re-price
  // history the instant it publishes.
  const derived = deriveRegularCardPrice(
    calc.bankPaymentPriceMinorUnits,
    new MoneyDecimal(calc.pricingProfile.fixedCardUpliftRate.toString()),
    calc.pricingProfile.regularCardPriceRuleId as RegularCardPriceRuleId
  );
  const regularCardPrice = Money.fromMinorUnits(derived.regularCardPriceMinorUnits, calc.currency);

  // SYNC-FAILURE STATE MACHINE (owner §4/§15). The Admin API call is still
  // NOT swallowed — an error still propagates with the intent left in
  // `syncing`, exactly as before (the module comment's boundary is
  // unchanged: retries/alerts/48h suspension are read from the failure row
  // this records, not decided here). What is new is that the failure is now
  // CLAIMED before it propagates, via the exact seam
  // `priceSyncFailureRepository.server.ts` was built for.
  let appliedAt: Date;
  try {
    const applied = await deps.port.applyVariantPrice({
      shopifyProductGid,
      shopifyVariantGid,
      regularCardPrice,
      priceCalculationId: intent.priceCalculationId,
    });
    appliedAt = applied.appliedAt;
  } catch (syncError) {
    try {
      const failure = await recordSyncFailure({
        masterVariantId: intent.masterVariantId,
        error: syncError instanceof Error ? syncError.message : String(syncError),
      });

      // ADMIN NOTIFICATION (owner §4/§15). `attemptCount === 1` is the
      // sync-failure equivalent of `RecordCalculationFailureResult.newEpisode`
      // — `price_sync_failure`'s own result shape has no `newEpisode` field
      // (its repository is reviewed/green and not modified by this work; see
      // `dispatchAdminAlert`'s module doc comment), but
      // `decideFirstFailure`/`decideRetryFailure` in `~/domain/pricing/syncFailure`
      // guarantee `attemptCount` starts at exactly 1 for a brand-new episode
      // and only ever increments from there within one episode's lifetime,
      // so this reads the identical fact by a different name. Its own
      // try/catch: a notification failure must never mask the ORIGINAL sync
      // error re-thrown below.
      try {
        if (failure.attemptCount === 1) {
          await dispatchAdminAlert({
            sourceKind: "sync_failure",
            sourceId: failure.failureId,
            event: "opened",
          });
        }
        if (failure.newlySuspended) {
          await dispatchAdminAlert({
            sourceKind: "sync_failure",
            sourceId: failure.failureId,
            event: "suspended",
          });
        }
      } catch (alertError) {
        logger.error("admin_alert.dispatch_failed", {
          intentId: intent.id,
          masterVariantId: intent.masterVariantId,
          sourceKind: "sync_failure",
          event: failure.attemptCount === 1 ? "opened" : "suspended",
          error: alertError instanceof Error ? alertError.name : "UnknownError",
        });
      }
    } catch (recordError) {
      // Recording the failure must never mask the ORIGINAL error below, and
      // must never itself become the thing that propagates.
      logger.error("pricing.sync_failure_record_failed", {
        intentId: intent.id,
        masterVariantId: intent.masterVariantId,
        error: recordError instanceof Error ? recordError.name : "UnknownError",
      });
    }
    throw syncError;
  }

  // A genuinely successful Admin API call resolves any OPEN sync-failure
  // episode for this variant (owner §4 recovery / criterion 25), restoring
  // availability with no human action. Resolved on the PUBLISH succeeding,
  // not on the local bookkeeping transaction below winning its race — those
  // are separate concerns (see `!committed` below): Shopify already carries
  // the new price either way.
  //
  // READ AVAILABILITY AS `suspendedAt IS NOT NULL AND resolvedAt IS NULL`
  // (R2) — never `alertState`. `recordSyncSuccess` only ever sets
  // `resolvedAt`; it does not touch `alertState`'s dismissed/cleared split,
  // which governs notification noise, not whether a variant may sell.
  try {
    const recovery = await recordSyncSuccess({ masterVariantId: intent.masterVariantId, now: appliedAt });

    // ADMIN NOTIFICATION (owner §15 resolution). Own nested try/catch, same
    // reasoning as the recovery-record call it sits beside: a notification
    // failure must never turn a genuinely successful sync into a failed one.
    if (recovery.restored && recovery.failureId) {
      try {
        await dispatchAdminAlert({
          sourceKind: "sync_failure",
          sourceId: recovery.failureId,
          event: "resolved",
        });
      } catch (alertError) {
        logger.error("admin_alert.dispatch_failed", {
          intentId: intent.id,
          masterVariantId: intent.masterVariantId,
          sourceKind: "sync_failure",
          event: "resolved",
          error: alertError instanceof Error ? alertError.name : "UnknownError",
        });
      }
    }
  } catch (recordError) {
    logger.error("pricing.sync_success_record_failed", {
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
      error: recordError instanceof Error ? recordError.name : "UnknownError",
    });
  }

  // Criterion 5: the status change to `synced` and the compare-and-set anchor
  // write happen in ONE transaction. If those could be separated by a crash,
  // a price could be live on Shopify with no record that it was (F-26
  // recurring), or `lastSyncedPriceCalculationId` could point at a
  // calculation the intent record does not agree was ever synced.
  let committed = true;
  await prisma.$transaction(async (tx) => {
    // Guarded the same way the `syncing` transition was: a concurrent
    // supersession during the (already-completed) Admin API call is an
    // extremely narrow window, but a blind `update` would let this call
    // silently overwrite a `superseded` status with `synced` and anchor
    // `lastSyncedPriceCalculationId` at a calculation a concurrent process
    // has already decided is stale.
    const synced = await tx.priceSyncIntent.updateMany({
      where: { id: intent.id, status: "syncing" },
      data: { status: "synced", syncedAt: appliedAt, shopifyVariantGid },
    });
    if (synced.count !== 1) {
      committed = false;
      return;
    }
    await tx.masterVariant.update({
      where: { id: intent.masterVariantId },
      data: { lastSyncedPriceCalculationId: intent.priceCalculationId },
    });
  });

  if (!committed) {
    // The price IS live on Shopify at this point (the call above succeeded);
    // only the local bookkeeping lost the race. Logged loudly because this is
    // the one outcome this function cannot make right by itself — a human or
    // the next recalculation run resolves it, but silence here would hide
    // that a publish happened with no anchor recorded for it.
    logger.error("pricing.sync_committed_after_concurrent_change", {
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
      priceCalculationId: intent.priceCalculationId,
    });
  } else {
    await writeSyncAuditEvent({
      intentId: intent.id,
      masterVariantId: intent.masterVariantId,
      priceCalculationId: intent.priceCalculationId,
      outcome: "synced",
      previousBankPaymentPriceMinorUnits: previousBank.minorUnits,
      previousBankPaymentPriceCurrency: previousBank.currency,
      publishedRegularCardPriceMinorUnits: derived.regularCardPriceMinorUnits.toString(),
      publishedRegularCardPriceCurrency: calc.currency,
      regularCardPriceRuleId: calc.pricingProfile.regularCardPriceRuleId,
      profileVersion: calc.profileVersion,
    });

    // §16 / CRITERION 58'S TRAP, closed here. This IS a write to a covered
    // model (`master_variant`, via the transaction above), so criterion 17
    // says it must be classified — but the ONLY column that write ever
    // touches is `lastSyncedPriceCalculationId`, which
    // `priceAffectingColumns.ts` deliberately excludes from the allow-list
    // (its own module comment explains why: classifying it would make every
    // successful publish trigger the next recalculation, which publishes,
    // which stamps again — catalogue-wide, forever). Passing the REAL,
    // exact changed-column set below — never a placeholder, never "every
    // column of MasterVariant" — is what keeps this call correctly inert.
    // DO NOT widen `changedColumns` to make this "more complete"; that
    // widening is the exact regression this comment (and
    // `syncStampNeverTriggersInputChange` in this file's test) exists to catch.
    try {
      await recordPricingInputChangeIfPriceAffecting({
        model: "MasterVariant",
        changedColumns: ["lastSyncedPriceCalculationId"],
        entityId: intent.masterVariantId,
        changedBy: "system:price-sync",
        changedAt: appliedAt,
        note: "sync anchor stamped after a confirmed Shopify publish",
      });
    } catch (recordError) {
      logger.error("pricing.input_change_record_failed", {
        intentId: intent.id,
        masterVariantId: intent.masterVariantId,
        error: recordError instanceof Error ? recordError.name : "UnknownError",
      });
    }
  }

  logger.info("pricing.sync_completed", {
    intentId: intent.id,
    masterVariantId: intent.masterVariantId,
    committed,
  });

  return {
    kind: "synced",
    intentId,
    regularCardPriceMinorUnits: derived.regularCardPriceMinorUnits.toString(),
    currency: calc.currency,
  };
}
