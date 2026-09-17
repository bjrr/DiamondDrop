import { randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";
import {
  createPriceCalculation,
  findCalculationForRun,
  findSnapshotByContentHash,
  getLatestComputedCalculation,
} from "~/db/repositories/priceCalculationRepository.server";
import { supersedeAndCreateIntent } from "~/db/repositories/priceSyncIntentRepository.server";
import { hashCanonicalJson } from "~/domain/evidence/hash";
import type { JsonValue } from "~/domain/evidence";
import { computeBuyNowBandPrice, computeBuyNowPrice } from "~/domain/pricing/engine";
import { logger } from "~/lib/logger.server";

import { decideSync } from "./decideSync";
import {
  NoOpOpenCampaignExclusionSource,
  type OpenCampaignExclusionSource,
} from "./ports";
import { resolveInputsForVariant } from "./resolveInputs.server";

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
}

export async function runPriceRecalculation(options: RunOptions = {}): Promise<RunSummary> {
  const runId = options.runId ?? randomUUID();
  const asOf = options.asOf ?? new Date();
  const openCampaigns = options.openCampaignExclusions ?? new NoOpOpenCampaignExclusionSource();

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

  logger.info("pricing.run_started", { runId, asOf: asOf.toISOString() });

  const variants = await prisma.masterVariant.findMany({
    where: { status: "active" },
    include: { masterProduct: true },
  });

  const campaignExcluded = await openCampaigns.excludedMasterVariantIds(asOf);

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

      const banded = resolved.bands.length > 0 && variant.bandId !== null;
      const band = banded ? resolved.bands.find((b) => b.label !== undefined) : undefined;

      const result = band
        ? computeBuyNowBandPrice({ ...resolved.inputs, band }).winning
        : computeBuyNowPrice(resolved.inputs);

      const costBasisSize = band ? computeBuyNowBandPrice({ ...resolved.inputs, band }).costBasisSize : null;

      // The snapshot payload is the reproducibility contract (§5.6): the
      // inputs plus the engine version are enough to recompute this price
      // with no database at all.
      const payload = {
        engineVersion: result.engineVersion,
        inputs: resolved.inputs,
        result,
      } as unknown as JsonValue;
      const contentHash = hashCanonicalJson(payload);

      const snapshot =
        (await findSnapshotByContentHash(contentHash)) ??
        (await prisma.snapshot.create({
          data: { kind: "pricing.buy_now_calculation", payload: payload as never, contentHash },
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
        landedCostMinorUnits: BigInt(
          result.breakdown.landedCostMinorUnits.split(".")[0] ?? "0"
        ),
        computedPriceMinorUnits: BigInt(result.price.amountMinorUnits),
        currency: result.currency,
        status: "computed",
      });

      const previous = await getLatestComputedCalculation(variant.id);
      const lastSynced =
        variant.lastSyncedPriceCalculationId && previous
          ? { amountMinorUnits: previous.computedPriceMinorUnits.toString(), currency: previous.currency }
          : null;

      const decision = decideSync({
        newPrice: result.price,
        lastSyncedPrice: lastSynced,
        toleranceBps: resolved.inputs.profile.autoApplyToleranceBps,
      });

      await supersedeAndCreateIntent({
        masterVariantId: variant.id,
        priceCalculationId: calculation.id,
        decision: decision.decision,
        // An unchanged price is terminal immediately: a no-change run must not
        // fill the approval queue with nothing to approve (§9.3).
        status: decision.unchanged ? "synced" : decision.decision === "auto_apply" ? "synced" : "pending_approval",
        previousPriceMinorUnits: lastSynced ? BigInt(lastSynced.amountMinorUnits) : null,
        previousPriceCurrency: lastSynced?.currency ?? null,
        deltaBps: decision.deltaBps,
        reason: decision.reason,
      });

      summary.computed += 1;
      if (decision.unchanged) summary.unchanged += 1;
      else if (decision.decision === "auto_apply") summary.autoApply += 1;
      else summary.needsApproval += 1;
    } catch (error) {
      // One variant's failure never aborts the run.
      summary.failed += 1;
      logger.error("pricing.variant_failed", {
        runId,
        masterVariantId: variant.id,
        // The error NAME only. A MissingCostInputError message can name a
        // component and its qualifiers; the message itself stays out of the
        // log to keep cost structure unlogged (criterion 30).
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

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
