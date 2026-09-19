import { randomUUID } from "node:crypto";

import type { PriceRecalculationTrigger } from "@prisma/client";

import { prisma } from "~/db/client.server";
import {
  createPriceCalculation,
  findCalculationForRun,
  findSnapshotByContentHash,
  getLastSyncedCalculation,
} from "~/db/repositories/priceCalculationRepository.server";
import { supersedeAndCreateIntent } from "~/db/repositories/priceSyncIntentRepository.server";
import { resolveActivePricingProfile } from "~/db/repositories/pricingProfileRepository.server";
import { hashCanonicalJson } from "~/domain/evidence/hash";
import type { JsonValue } from "~/domain/evidence";
import { Money } from "~/domain/money/money";
import { computeBuyNowBandPrice, computeBuyNowPrice } from "~/domain/pricing/engine";
import { PRICING_ENGINE_VERSION } from "~/domain/pricing/version";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

import { decideSync } from "./decideSync";
import {
  BandResolutionError,
  NoOpOpenCampaignExclusionSource,
  type OpenCampaignExclusionSource,
  type ShopifyPriceSyncPort,
  UnimplementedPriceSyncPort,
} from "./ports";
import { resolveInputsForVariant } from "./resolveInputs.server";
import { syncApprovedPriceSyncIntent } from "./syncApprovedIntent.server";

/**
 * The recalculation run (spec §9.2).
 *
 * TWO RULES SHAPE THIS FUNCTION:
 *
 * 1. A failure in one variant fails ONLY that variant. A missing cost input on
 *    one product must not abort a run covering the whole catalogue.
 * 2. NO cost, margin, supplier, breakdown or price value appears in any log
 *    line (R14, criterion 30). The run summary logs counts and references
 *    only. The logger's key-name redaction is defence in depth, not licence.
 */

export interface RunSummary {
  runId: string;
  asOf: string;
  computed: number;
  skipped: number;
  failed: number;
  autoApply: number;
  needsApproval: number;
  unchanged: number;
}

export interface RunOptions {
  runId?: string;
  asOf?: Date;
  openCampaignExclusions?: OpenCampaignExclusionSource;
  /**
   * D15. What caused this run. Defaults to `scheduled` because that is the
   * overwhelmingly common case (the daily platform scheduler), and because a
   * run whose origin is unknown is better recorded as the routine one than as
   * a human action nobody took.
   */
  trigger?: PriceRecalculationTrigger;
  /** Required for a staff-triggered run; meaningless for a scheduled one. */
  triggeredBy?: string;
  /** Free-text justification for an off-schedule run. */
  reason?: string;
  /**
   * Slice 2 T1 (spec §4.1 criteria 8-9). Where an auto-apply decision is
   * actually published, immediately, from within this run.
   *
   * Defaults to `UnimplementedPriceSyncPort`, exactly as slice 1 left it —
   * NOT to the real adapter. This file lives under app/jobs/pricing/, which
   * criterion 29's fence (layering.test.ts) forbids from importing `@shopify/*`
   * even transitively-by-default; constructing the real Shopify-backed port
   * is therefore the CALLER's job (see app/routes/internal.jobs.price-recalculation.tsx),
   * not this module's. If auto-publish is ever enabled without a real port
   * wired in, a variant that would have auto-applied fails loudly for that
   * variant alone (caught the same as any other per-variant error) rather
   * than silently claiming a publish that never happened.
   */
  syncPort?: ShopifyPriceSyncPort;
  /**
   * Defaults to reading `PRICE_AUTO_PUBLISH_ENABLED` from the environment
   * (criterion 8: unset or anything other than the literal string "true"
   * means OFF). Overridable so a test can exercise the auto-publish branch
   * without mutating process.env.
   */
  autoPublishEnabled?: boolean;
}

/**
 * D15. A staff-triggered run must name the person who asked for it. Without
 * this, "who forced a repricing the day before the dispute?" has no answer —
 * and a nullable column alone would let the answer be quietly omitted.
 */
/**
 * Prisma's unique-violation code. Matched structurally rather than by message
 * so a Prisma upgrade that rewords the error does not silently turn a handled
 * re-run into a crash.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export class MissingTriggerActorError extends Error {
  constructor(readonly trigger: PriceRecalculationTrigger) {
    super(
      `A ${trigger} price recalculation must name the staff member who triggered it (triggeredBy).`
    );
    this.name = "MissingTriggerActorError";
  }
}

export async function runPriceRecalculation(options: RunOptions = {}): Promise<RunSummary> {
  const runId = options.runId ?? randomUUID();
  const asOf = options.asOf ?? new Date();
  const openCampaigns = options.openCampaignExclusions ?? new NoOpOpenCampaignExclusionSource();
  const trigger = options.trigger ?? "scheduled";
  const syncPort = options.syncPort ?? new UnimplementedPriceSyncPort();
  // Criterion 8: default OFF. Only the literal string "true" turns it on — see
  // the PRICE_AUTO_PUBLISH_ENABLED comment in app/lib/env.server.ts.
  const autoPublishEnabled = options.autoPublishEnabled ?? getEnv().PRICE_AUTO_PUBLISH_ENABLED === "true";

  // Checked BEFORE any work, so an unattributable run never reaches the point
  // of writing prices.
  if (trigger !== "scheduled" && !options.triggeredBy) {
    throw new MissingTriggerActorError(trigger);
  }

  const summary: RunSummary = {
    runId,
    asOf: asOf.toISOString(),
    computed: 0,
    skipped: 0,
    failed: 0,
    autoApply: 0,
    needsApproval: 0,
    unchanged: 0,
  };

  // D15 run-level audit row, written BEFORE the work so that a run which
  // crashes still leaves evidence it happened. finished_at stays NULL in that
  // case, which is how an interrupted run is told apart from a clean one.
  //
  // Created idempotently. Re-running with the same runId is a deliberate no-op
  // (criterion 23), so a duplicate id here means "this run already started",
  // not an error — and must not abort a re-run before it can reconcile.
  try {
    await prisma.priceRecalculationRun.create({
      data: {
        id: runId,
        trigger,
        triggeredBy: options.triggeredBy ?? null,
        reason: options.reason ?? null,
        asOf,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  logger.info("pricing.run_started", {
    runId,
    asOf: asOf.toISOString(),
    trigger,
    triggeredBy: options.triggeredBy ?? null,
  });

  const variants = await prisma.masterVariant.findMany({
    where: { status: "active" },
    include: { masterProduct: true },
  });

  const campaignExcluded = await openCampaigns.excludedMasterVariantIds(asOf);

  // Resolved once per run. A failed price_calculation still needs its required
  // FKs, and if the profile itself cannot resolve there is no run to have.
  const runProfile = await resolveActivePricingProfile("buy_now", asOf);

  // Created lazily, and only if something actually fails, so a clean run adds
  // no rows. Shared by every failure in the run: the payload carries no inputs
  // because there were none to record.
  let failureSnapshotId: string | null = null;
  const getFailureSnapshotId = async (): Promise<string> => {
    if (failureSnapshotId) return failureSnapshotId;
    const hash = hashCanonicalJson({ kind: "pricing.failure", runId } as JsonValue);
    const existing = await findSnapshotByContentHash(hash);
    const snap =
      existing ??
      (await prisma.snapshot.create({
        data: { kind: "pricing.failure", payload: { runId } as never, contentHash: hash },
      }));
    failureSnapshotId = snap.id;
    return snap.id;
  };

  for (const variant of variants) {
    // Skipped variants are RECORDED with a reason, never silently dropped
    // (R17) — a product missing from a pricing run must be explicable.
    if (variant.masterProduct.isLuxurySteal) {
      summary.skipped += 1;
      logger.info("pricing.variant_skipped", {
        runId,
        masterVariantId: variant.id,
        reason: "luxury_steal",
      });
      continue;
    }
    if (campaignExcluded.has(variant.id)) {
      summary.skipped += 1;
      logger.info("pricing.variant_skipped", {
        runId,
        masterVariantId: variant.id,
        reason: "open_group_buy_campaign",
      });
      continue;
    }

    try {
      // §9.4: re-running the same run id is a no-op, enforced by the unique
      // (runId, masterVariantId) constraint. Checked first so a retried run
      // does not redo work before hitting the constraint.
      const existing = await findCalculationForRun(runId, variant.id);
      if (existing) {
        summary.computed += 1;
        continue;
      }

      const resolved = await resolveInputsForVariant(variant.id, asOf);

      // Select the variant's OWN band by id. An earlier version matched on
      // `b.label !== undefined`, which is true for every band, so every
      // variant was priced off the first band by sortOrder — and because
      // weight grows with size, every band past the first was systematically
      // under-priced. Matching by id is the only correct correlation.
      //
      // A variant carrying a bandId that does not resolve to one of its
      // product's bands is a data-integrity error, not a "use whatever is
      // first" case: failing this variant is strictly safer than pricing it
      // off a band it does not belong to.
      const band =
        variant.bandId === null
          ? undefined
          : (resolved.bands.find((b) => b.id === variant.bandId) ??
             (() => {
               throw new BandResolutionError(variant.id, variant.bandId);
             })());

      // Computed once: computeBuyNowBandPrice is pure, but calling it twice
      // for the same inputs is waste, and two call sites could drift.
      const bandResult = band ? computeBuyNowBandPrice({ ...resolved.inputs, band }) : null;
      const result = bandResult ? bandResult.winning : computeBuyNowPrice(resolved.inputs);
      const costBasisSize = bandResult ? bandResult.costBasisSize : null;

      // The snapshot payload is the reproducibility contract (§5.6): the
      // inputs plus the engine version are enough to recompute this price
      // with no database at all.
      // Normalise through JSON before hashing and storing. The inputs carry
      // optional fields (an absent variant floor, a component with no rate),
      // which are `undefined` in memory — and the canonicalizer rejects
      // `undefined` outright rather than guessing whether it means "absent"
      // or "null". That refusal is correct: this payload is the reproducibility
      // contract (§5.6), so what is hashed must be exactly what survives a JSON
      // round-trip into jsonb and back out again.
      const payload = JSON.parse(
        JSON.stringify({
          engineVersion: result.engineVersion,
          inputs: resolved.inputs,
          result,
        })
      ) as JsonValue;
      const contentHash = hashCanonicalJson(payload);

      const snapshot =
        (await findSnapshotByContentHash(contentHash)) ??
        (await prisma.snapshot.create({
          data: { kind: "pricing.buy_now_calculation.v1", payload: payload as never, contentHash },
        }));

      const calculation = await createPriceCalculation({
        runId,
        masterVariantId: variant.id,
        pricingProfileId: resolved.pricingProfileId,
        profileVersion: resolved.inputs.profile.version,
        engineVersion: result.engineVersion,
        roundingRuleId: result.roundingRuleId,
        priceEndingRuleId: result.priceEndingRuleId,
        asOf,
        snapshotId: snapshot.id,
        costBasisSize,
        // Audit projection only — never re-entered into a calculation (§4.1
        // rule 3). Routed through the named rounding registry anyway: this was
        // the one place in the slice that rounded a money value by string
        // surgery, outside the registry §5.4 exists to centralise.
        landedCostMinorUnits: Money.fromDecimalMinorUnits(
          result.breakdown.landedCostMinorUnits,
          result.currency,
          result.roundingRuleId
        ).amountMinorUnits,
        bankPaymentPriceMinorUnits: BigInt(result.bankPaymentPrice.amountMinorUnits),
        currency: result.currency,
        status: "computed",
      });

      // Resolved through the compare-and-set anchor, which names the specific
      // calculation that was synced — never "the latest computed", which after
      // the write above is this run's own row. Reading that made every price
      // look unchanged and be marked terminally `synced` no matter how far it
      // had moved.
      const lastSyncedCalculation = await getLastSyncedCalculation(variant.id);
      const lastSynced = lastSyncedCalculation
        ? {
            amountMinorUnits: lastSyncedCalculation.bankPaymentPriceMinorUnits.toString(),
            currency: lastSyncedCalculation.currency,
          }
        : null;

      const decision = decideSync({
        // BANK AGAINST BANK. The published figure is the card price, but the
        // comparison that decides auto-apply is made on the bank price, because
        // that is what is stored and what moves when costs move. Comparing a new bank
        // price against a previously published card price would read as a ~5%
        // drop on every variant, every run.
        newBankPaymentPrice: result.bankPaymentPrice,
        lastSyncedBankPaymentPrice: lastSynced,
        // NULL tolerance means D14 is unresolved: automatic publication is
        // disabled and every change needs a human. Passing null rather than a
        // default is deliberate — a defaulted tolerance would silently publish.
        toleranceBps: resolved.inputs.profile.autoApplyToleranceBps,
      });

      // D14 GUARD — enforced here in the job, not only in the review CLI.
      //
      // While the active profile is a placeholder its margins are invented, so
      // no price derived from them may clear review by ANY route. The CLI
      // refuses to approve such a price, but an auto-apply decision never
      // passes through the CLI at all — so without this check a
      // within-tolerance change computed from a 99.99% placeholder margin
      // would bypass the only guard that exists.
      const requiresHuman = resolved.isPlaceholderProfile || decision.decision === "needs_approval";

      // Three deliberately distinct states:
      //   unchanged           -> synced    genuinely nothing to do; §9.3
      //                                    requires a no-change run not to
      //                                    fill the approval queue
      //   auto_apply, changed -> approved  cleared for sync — and, since
      //                                    slice 2, actually synced below IF
      //                                    auto-publish is enabled (criterion
      //                                    8). With it disabled this stops
      //                                    here exactly as slice 1 left it.
      //   needs_approval      -> pending_approval
      const intentStatus = requiresHuman ? "pending_approval" : decision.unchanged ? "synced" : "approved";

      const newIntent = await supersedeAndCreateIntent({
        masterVariantId: variant.id,
        priceCalculationId: calculation.id,
        decision: decision.decision,
        status: intentStatus,
        previousBankPaymentPriceMinorUnits: lastSynced ? BigInt(lastSynced.amountMinorUnits) : null,
        previousBankPaymentPriceCurrency: lastSynced?.currency ?? null,
        deltaBps: decision.deltaBps,
        deltaMinorUnits: decision.deltaMinorUnits,
        reason: decision.reason,
      });

      // AUTO-PUBLISH (criteria 8-9). Deliberately its OWN try/catch, separate
      // from the one enclosing this whole variant: a sync failure here means
      // the CALCULATION succeeded and the intent is correctly `approved` (or
      // left `syncing` mid-attempt) — it must not be counted as a failed
      // calculation, and must not attempt to write a second `price_calculation`
      // row for this (runId, variant) pair, which would collide with the
      // unique constraint on the row already written above.
      //
      // Failure handling beyond this log line (alerts, retry, 48h suspension)
      // is T4's (spec §4.4, test plan cases 7-12) — this is only the wiring
      // that makes an auto-apply decision actually reach the port at all,
      // which before this slice it never did (F-27).
      if (autoPublishEnabled && intentStatus === "approved") {
        try {
          await syncApprovedPriceSyncIntent(newIntent.id, { port: syncPort });
        } catch (syncError) {
          logger.error("pricing.auto_publish_failed", {
            runId,
            masterVariantId: variant.id,
            intentId: newIntent.id,
            error: syncError instanceof Error ? syncError.name : "UnknownError",
          });
        }
      }

      summary.computed += 1;
      if (requiresHuman) summary.needsApproval += 1;
      else if (decision.unchanged) summary.unchanged += 1;
      else summary.autoApply += 1;
    } catch (error) {
      // One variant's failure never aborts the run.
      summary.failed += 1;
      const errorName = error instanceof Error ? error.name : "UnknownError";

      logger.error("pricing.variant_failed", {
        runId,
        masterVariantId: variant.id,
        // The error NAME only. A MissingCostInputError message can name a
        // component and its qualifiers; the message itself stays out of the
        // log to keep cost structure unlogged (criterion 30).
        error: errorName,
      });

      // Write the DURABLE failure record §4.5 and criterion 15 require.
      //
      // Without this a failing variant leaves only a counter and one log line:
      // nothing queryable, nothing an operator or a later admin UI can list,
      // and no way to tell "this variant has been failing every run for a
      // week" from "this variant was skipped". The reason is stored here
      // rather than logged, because the row is access-controlled and the log
      // is not.
      try {
        await createPriceCalculation({
          runId,
          masterVariantId: variant.id,
          pricingProfileId: runProfile.id,
          profileVersion: runProfile.version,
          engineVersion: PRICING_ENGINE_VERSION,
          // The profile's own rules, even on a FAILED row. It carries no price,
          // so these are metadata rather than arithmetic — but a failure record
          // naming rules the run was not using would mislead exactly the person
          // reading it to work out why the run failed.
          roundingRuleId: runProfile.roundingRuleId,
          priceEndingRuleId: runProfile.priceEndingRuleId,
          asOf,
          snapshotId: await getFailureSnapshotId(),
          landedCostMinorUnits: 0n,
          bankPaymentPriceMinorUnits: 0n,
          currency: runProfile.minDollarProfit.toJSON().currency,
          status: "failed",
          failureReason: `${errorName}: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch (recordError) {
        // Recording the failure must never itself abort the run.
        logger.error("pricing.failure_record_failed", {
          runId,
          masterVariantId: variant.id,
          error: recordError instanceof Error ? recordError.name : "UnknownError",
        });
      }
    }
  }

  // Completes the D15 audit row. The database trigger permits this exactly
  // once and only on a row whose finished_at is still NULL, so a run cannot be
  // retroactively retold with different counts.
  //
  // updateMany with a finishedAt IS NULL guard rather than update-by-id: a
  // re-run of an already-completed runId must leave the original completion
  // record alone. The guard means no row matches, so the append-only trigger
  // never fires — the alternative would be a re-run crashing on its own
  // idempotency.
  await prisma.priceRecalculationRun.updateMany({
    where: { id: runId, finishedAt: null },
    data: {
      finishedAt: new Date(),
      computed: summary.computed,
      skipped: summary.skipped,
      failed: summary.failed,
      autoApply: summary.autoApply,
      needsApproval: summary.needsApproval,
      unchanged: summary.unchanged,
    },
  });

  logger.info("pricing.run_finished", {
    runId,
    computed: summary.computed,
    skipped: summary.skipped,
    failed: summary.failed,
    autoApply: summary.autoApply,
    needsApproval: summary.needsApproval,
    unchanged: summary.unchanged,
  });

  return summary;
}
