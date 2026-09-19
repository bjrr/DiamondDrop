import type { Prisma } from "@prisma/client";

import { prisma } from "../client.server";

/**
 * L6 — the historical pricing record (spec §4.0).
 *
 * `price_calculation` is append-only at the database level. There is no
 * update and no delete method here on purpose: a correction is a new
 * calculation, never an edit, so a stored row always describes what was
 * actually computed.
 *
 * A calculation is never read back as an INPUT to a new calculation. A
 * recalculation resolves its inputs afresh from L1/L2 (§4.5) — it does not
 * fall back to the last price.
 */

export interface CreatePriceCalculationInput {
  runId: string;
  masterVariantId: string;
  pricingProfileId: string;
  profileVersion: number;
  engineVersion: string;
  roundingRuleId: string;
  priceEndingRuleId: string;
  asOf: Date;
  snapshotId: string;
  costBasisSize?: string | null;
  landedCostMinorUnits: bigint;
  bankPaymentPriceMinorUnits: bigint;
  currency: string;
  status: "computed" | "failed";
  failureReason?: string | null;
}

export async function createPriceCalculation(input: CreatePriceCalculationInput) {
  return prisma.priceCalculation.create({
    data: {
      runId: input.runId,
      masterVariantId: input.masterVariantId,
      pricingProfileId: input.pricingProfileId,
      profileVersion: input.profileVersion,
      engineVersion: input.engineVersion,
      roundingRuleId: input.roundingRuleId,
      priceEndingRuleId: input.priceEndingRuleId,
      asOf: input.asOf,
      snapshotId: input.snapshotId,
      costBasisSize: input.costBasisSize ?? null,
      landedCostMinorUnits: input.landedCostMinorUnits,
      bankPaymentPriceMinorUnits: input.bankPaymentPriceMinorUnits,
      currency: input.currency,
      status: input.status,
      failureReason: input.failureReason ?? null,
    },
  });
}

export async function getPriceCalculationById(id: string) {
  return prisma.priceCalculation.findUnique({ where: { id }, include: { snapshot: true } });
}

/**
 * The newest computed calculation for a variant. Slice 2's sync uses this as
 * the compare-and-set anchor (§9.4): it applies only if the intent's
 * calculation is still the newest, so a stale intent cannot overwrite a newer
 * price.
 */
export async function getLatestComputedCalculation(masterVariantId: string) {
  return prisma.priceCalculation.findFirst({
    where: { masterVariantId, status: "computed" },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * The price that is actually live on Shopify for this variant, resolved
 * through the compare-and-set anchor.
 *
 * This is what `decideSync` must compare against — NOT "the latest computed
 * calculation". An earlier version used the latter and called it *after*
 * writing the current run's row, so it read back the row it had just written:
 * every price then looked unchanged and was terminally marked `synced`,
 * however far it had actually moved. Resolving through the anchor makes that
 * mistake impossible, because the anchor names a specific calculation that
 * was synced rather than whatever happens to be newest.
 *
 * Returns null when the variant has never been synced, which is the correct
 * input for "first-ever price" (§9.3).
 */
export async function getLastSyncedCalculation(masterVariantId: string) {
  const variant = await prisma.masterVariant.findUnique({
    where: { id: masterVariantId },
    select: { lastSyncedPriceCalculationId: true },
  });
  if (!variant?.lastSyncedPriceCalculationId) return null;

  return prisma.priceCalculation.findUnique({
    where: { id: variant.lastSyncedPriceCalculationId },
  });
}

/** Whether this run already produced a row for this variant (§9.4 idempotency). */
export async function findCalculationForRun(runId: string, masterVariantId: string) {
  return prisma.priceCalculation.findUnique({
    where: { runId_masterVariantId: { runId, masterVariantId } },
  });
}

export async function createEvidenceSnapshot(kind: string, payload: Prisma.InputJsonValue, contentHash: string) {
  return prisma.snapshot.create({ data: { kind, payload, contentHash } });
}

/** Reuses an identical snapshot by content hash rather than storing a duplicate (§9.2 step 4). */
export async function findSnapshotByContentHash(contentHash: string) {
  return prisma.snapshot.findFirst({ where: { contentHash } });
}
