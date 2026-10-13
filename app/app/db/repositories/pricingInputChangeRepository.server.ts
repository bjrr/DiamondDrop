import type { PricingInputChange, PricingInputChangeKind, PriceSyncIntent } from "@prisma/client";

import {
  MODEL_TO_PRICING_INPUT_CHANGE_KIND,
  isPriceAffectingChange,
  type CoveredModel,
} from "~/domain/pricing/priceAffectingColumns";

import { prisma } from "../client.server";

/**
 * `pricing_input_change` — the repository side (owner §3.1; spec criteria
 * 17-19, 58; docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §6, M3/M4).
 *
 * A DOCUMENTED SEAM, not wired into anything. Mirrors
 * `priceOverrideExpiryRepository.server.ts` and
 * `priceSyncFailureRepository.server.ts`: a self-contained, independently
 * testable unit a job file calls, rather than this module reaching out to
 * trigger itself. Whoever wires the recalculation trigger (T2) calls
 * `recordPricingInputChangeIfPriceAffecting` after a covered write, passing
 * the columns that write actually touched; whoever wires bulk approval
 * calls `resolvePendingIntentsForPricingInputChange`.
 */

export class PricingInputChangeEntityRequiredError extends Error {
  constructor(kind: PricingInputChangeKind) {
    super(
      `pricing_input_change of kind "${kind}" requires an entityId naming the specific row that ` +
        `changed. Only kind "manual" may omit one.`
    );
    this.name = "PricingInputChangeEntityRequiredError";
  }
}

export interface RecordPricingInputChangeInput {
  kind: PricingInputChangeKind;
  entityId?: string | null;
  changedBy?: string | null;
  changedAt: Date;
  note?: string | null;
}

/**
 * Writes the row directly. APPEND-ONLY (migration
 * 20260919085402_pricing_input_change_and_bank_payment_line_append_only) —
 * there is no update/delete counterpart, matching every other L1-input-
 * shaped table in this schema.
 */
export async function recordPricingInputChange(
  input: RecordPricingInputChangeInput
): Promise<PricingInputChange> {
  if (input.kind !== "manual" && !input.entityId) {
    throw new PricingInputChangeEntityRequiredError(input.kind);
  }

  return prisma.pricingInputChange.create({
    data: {
      kind: input.kind,
      entityId: input.entityId ?? null,
      changedBy: input.changedBy ?? null,
      changedAt: input.changedAt,
      note: input.note ?? null,
    },
  });
}

export interface RecordIfPriceAffectingInput {
  model: CoveredModel;
  /** The columns a write to `model` actually touched. */
  changedColumns: readonly string[];
  /** The id of the specific row that changed. */
  entityId: string;
  changedBy?: string | null;
  changedAt: Date;
  note?: string | null;
}

/**
 * Composes criterion 58's classifier with the writer: records a
 * `pricing_input_change` row ONLY when `changedColumns` actually includes a
 * price-affecting column for `model` (criterion 17). Returns `null` — not
 * an error — when nothing price-affecting changed; this is the expected,
 * routine outcome for a write like `lastSyncedPriceCalculationId` alone.
 *
 * `kind` is derived from `model` via `MODEL_TO_PRICING_INPUT_CHANGE_KIND`,
 * never accepted as a separate parameter, so the two cannot be passed out
 * of agreement.
 */
export async function recordPricingInputChangeIfPriceAffecting(
  input: RecordIfPriceAffectingInput
): Promise<PricingInputChange | null> {
  if (!isPriceAffectingChange(input.model, input.changedColumns)) return null;

  return recordPricingInputChange({
    kind: MODEL_TO_PRICING_INPUT_CHANGE_KIND[input.model],
    entityId: input.entityId,
    changedBy: input.changedBy,
    changedAt: input.changedAt,
    note: input.note,
  });
}

/**
 * Criterion 11 — the bulk-approval grouping key. Every `price_sync_intent`
 * whose recalculation was caused by ONE `pricing_input_change` row,
 * resolved by following the join a Prisma relation cannot express directly:
 *
 *   pricing_input_change <-[pricingInputChangeId FK]- price_recalculation_run
 *     -[runId, a plain correlating UUID, NOT an FK -- see
 *       PriceCalculation.runId's own doc comment]-> price_calculation
 *     <-[priceCalculationId FK]- price_sync_intent
 *
 * The middle hop is not a real foreign key (an existing, pre-dating
 * convention on `PriceCalculation.runId` — flagged as F-30 for later
 * consolidation, not this task's to fix), so it is walked as three
 * separate queries rather than one Prisma `include`.
 */
export async function resolveIntentsForPricingInputChange(
  pricingInputChangeId: string
): Promise<PriceSyncIntent[]> {
  const runs = await prisma.priceRecalculationRun.findMany({
    where: { pricingInputChangeId },
    select: { id: true },
  });
  if (runs.length === 0) return [];

  const calculations = await prisma.priceCalculation.findMany({
    where: { runId: { in: runs.map((r) => r.id) } },
    select: { id: true },
  });
  if (calculations.length === 0) return [];

  return prisma.priceSyncIntent.findMany({
    where: { priceCalculationId: { in: calculations.map((c) => c.id) } },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The subset of `resolveIntentsForPricingInputChange` a bulk-APPROVE action
 * actually acts on — only a `pending_approval` intent can be approved.
 * Includes the calculation/profile and variant/product context a review
 * surface needs, mirroring `listPendingIntents` in
 * `priceSyncIntentRepository.server.ts`.
 */
export async function resolvePendingIntentsForPricingInputChange(pricingInputChangeId: string) {
  const runs = await prisma.priceRecalculationRun.findMany({
    where: { pricingInputChangeId },
    select: { id: true },
  });
  if (runs.length === 0) return [];

  const calculations = await prisma.priceCalculation.findMany({
    where: { runId: { in: runs.map((r) => r.id) } },
    select: { id: true },
  });
  if (calculations.length === 0) return [];

  return prisma.priceSyncIntent.findMany({
    where: {
      priceCalculationId: { in: calculations.map((c) => c.id) },
      status: "pending_approval",
    },
    orderBy: { createdAt: "asc" },
    include: {
      priceCalculation: { include: { pricingProfile: true } },
      masterVariant: { include: { masterProduct: true } },
    },
  });
}
