import { Prisma } from "@prisma/client";

import { buildBulkAssignmentTargets } from "~/domain/luxurysteals/assignment";
import { decideOrderCheckOutcome, type LuxuryStealOrderCheckOutcome } from "~/domain/luxurysteals/orderCheck";

import { prisma } from "../client.server";

/**
 * Luxury Steal assignment (M11) and order-boundary evidence (M12) — the
 * database-facing half (D27, criteria 125-128, 137-140, 146-150,
 * docs/specs/SLICE-3-LUXURY-STEALS.md, task 3-1). Pure decision logic lives
 * in `~/domain/luxurysteals/assignment` and `~/domain/luxurysteals/orderCheck`
 * and is unit-tested there with no database; this file is the thin,
 * integration-tested layer that turns those decisions into committed rows.
 *
 * VARIANT-LEVEL IS THE ONLY WRITE PATH (D27). Every function below reads or
 * writes `MasterVariant.isLuxurySteal` directly. `bulkAssignLuxuryStealForProduct`
 * is the product-level admin convenience §5 describes — internally it still
 * writes N independent variant rows through the same column, never a
 * separate product-level flag.
 */

// ---------------------------------------------------------------------------
// Assignment (M11)
// ---------------------------------------------------------------------------

/** Sets or clears Luxury Steal status for exactly one variant (criterion 125/128 — the controlled admin path). Throws Prisma's standard "record not found" error if the variant id does not exist. */
export async function setLuxuryStealAssignment(
  masterVariantId: string,
  isLuxurySteal: boolean
): Promise<{ masterVariantId: string; isLuxurySteal: boolean }> {
  const updated = await prisma.masterVariant.update({
    where: { id: masterVariantId },
    data: { isLuxurySteal },
    select: { id: true, isLuxurySteal: true },
  });
  return { masterVariantId: updated.id, isLuxurySteal: updated.isLuxurySteal };
}

/** Convenience wrapper naming the common case explicitly — see `setLuxuryStealAssignment`. */
export async function assignLuxurySteal(masterVariantId: string) {
  return setLuxuryStealAssignment(masterVariantId, true);
}

/** Convenience wrapper naming the common case explicitly — see `setLuxuryStealAssignment`. Removing status goes through this same controlled path (criterion 128); the acknowledgment evidence on any order already placed is untouched and keeps recording the terms that applied at purchase. */
export async function unassignLuxurySteal(masterVariantId: string) {
  return setLuxuryStealAssignment(masterVariantId, false);
}

export interface BulkAssignLuxuryStealResult {
  readonly masterProductId: string;
  readonly isLuxurySteal: boolean;
  /** Every variant id actually written — nothing more, nothing less (criterion 147's "writes every variant and nothing else"). */
  readonly updatedMasterVariantIds: readonly string[];
}

/**
 * The admin "apply to all variants" convenience action (§5). Reads the
 * product's current variant ids, then writes the SAME column
 * (`MasterVariant.isLuxurySteal`) on every one of them — a convenience over
 * the per-variant write path above, never a second storage location.
 *
 * Scoped to exactly this product's variants: the `updateMany` WHERE clause
 * filters on the resolved id list, not on `masterProductId` directly, so the
 * set of rows touched is exactly the set this function read and validated —
 * no other product's variants can be affected even if the id list were
 * somehow stale by the time the write runs.
 */
export async function bulkAssignLuxuryStealForProduct(
  masterProductId: string,
  isLuxurySteal: boolean
): Promise<BulkAssignLuxuryStealResult> {
  const variants = await prisma.masterVariant.findMany({
    where: { masterProductId },
    select: { id: true },
  });
  const targetIds = buildBulkAssignmentTargets(
    masterProductId,
    variants.map((variant) => variant.id)
  );

  await prisma.masterVariant.updateMany({
    where: { id: { in: targetIds } },
    data: { isLuxurySteal },
  });

  return { masterProductId, isLuxurySteal, updatedMasterVariantIds: targetIds };
}

/**
 * Criterion 150 / 127: THE order-time (and storefront-gate) truth query.
 * Reads Postgres directly — never a metafield, never a client-supplied flag.
 * Returns `false` for a variant id that does not exist: there is no
 * assignment row to enforce, which is the same practical answer as "not a
 * Luxury Steal" (a deleted/unknown variant cannot be added to a cart in the
 * first place).
 */
export async function isMasterVariantLuxurySteal(masterVariantId: string): Promise<boolean> {
  const variant = await prisma.masterVariant.findUnique({
    where: { id: masterVariantId },
    select: { isLuxurySteal: true },
  });
  return variant?.isLuxurySteal ?? false;
}

export interface LuxuryStealVariantAssignment {
  readonly masterVariantId: string;
  readonly shopifyVariantGid: string | null;
  readonly isLuxurySteal: boolean;
}

/**
 * Every variant of a product with its CURRENT assignment state — for task
 * 3-2's metafield sync to consume. Deliberately returns every variant, not
 * only the assigned ones: the sync needs to know which variants must have
 * their `carat.luxury_steal` metafield CLEARED just as much as which must
 * have it set (criterion 128 — removing status re-syncs too; criterion 149
 * — the cache must preserve per-variant state, including "not assigned").
 */
export async function listLuxuryStealAssignmentsForProduct(
  masterProductId: string
): Promise<LuxuryStealVariantAssignment[]> {
  const variants = await prisma.masterVariant.findMany({
    where: { masterProductId },
    select: { id: true, shopifyVariantGid: true, isLuxurySteal: true },
    orderBy: { createdAt: "asc" },
  });
  return variants.map((variant) => ({
    masterVariantId: variant.id,
    shopifyVariantGid: variant.shopifyVariantGid,
    isLuxurySteal: variant.isLuxurySteal,
  }));
}

// ---------------------------------------------------------------------------
// Order-boundary evidence (M12)
// ---------------------------------------------------------------------------

export interface RecordLuxuryStealOrderCheckInput {
  readonly orderRef: string;
  readonly lineRef: string;
  readonly variantRef: string;
  /** The acknowledgment task 3-4's matching query found, or `null` — see `~/domain/luxurysteals/orderCheck` for why the outcome is derived from this rather than supplied separately. */
  readonly matchedAcknowledgmentId: string | null;
  readonly checkedAt?: Date;
}

export interface RecordLuxuryStealOrderCheckResult {
  readonly id: string;
  readonly outcome: LuxuryStealOrderCheckOutcome;
  /** False when a row for this `(orderRef, lineRef)` already existed — a redelivered `orders/create` (criterion 139), not a new check. */
  readonly created: boolean;
}

/**
 * Records one line's order-time check outcome — matched or unmatched, always
 * (criterion 140). IDEMPOTENT under redelivery (criterion 139): relies on
 * the `@@unique([orderRef, lineRef])` constraint to let exactly one INSERT
 * win, exactly like `recordCalculationFailure`'s race-safety idiom in
 * `priceCalculationFailureRepository.server.ts` — a concurrent duplicate
 * delivery is read back and returned as `created: false` rather than
 * surfaced as an error, and never produces a second row.
 */
export async function recordLuxuryStealOrderCheck(
  input: RecordLuxuryStealOrderCheckInput
): Promise<RecordLuxuryStealOrderCheckResult> {
  const outcome = decideOrderCheckOutcome({ matchedAcknowledgmentId: input.matchedAcknowledgmentId });

  try {
    const created = await prisma.luxuryStealOrderCheck.create({
      data: {
        orderRef: input.orderRef,
        lineRef: input.lineRef,
        variantRef: input.variantRef,
        matchedAcknowledgmentId: input.matchedAcknowledgmentId,
        outcome,
        checkedAt: input.checkedAt ?? new Date(),
      },
    });
    return { id: created.id, outcome: created.outcome, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.luxuryStealOrderCheck.findUniqueOrThrow({
        where: { orderRef_lineRef: { orderRef: input.orderRef, lineRef: input.lineRef } },
      });
      return { id: existing.id, outcome: existing.outcome, created: false };
    }
    throw error;
  }
}

export interface LuxuryStealOrderCheckRecord {
  readonly id: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly variantRef: string;
  readonly matchedAcknowledgmentId: string | null;
  readonly outcome: LuxuryStealOrderCheckOutcome;
  readonly checkedAt: Date;
}

function toRecord(row: {
  id: string;
  orderRef: string;
  lineRef: string;
  variantRef: string;
  matchedAcknowledgmentId: string | null;
  outcome: LuxuryStealOrderCheckOutcome;
  checkedAt: Date;
}): LuxuryStealOrderCheckRecord {
  return {
    id: row.id,
    orderRef: row.orderRef,
    lineRef: row.lineRef,
    variantRef: row.variantRef,
    matchedAcknowledgmentId: row.matchedAcknowledgmentId,
    outcome: row.outcome,
    checkedAt: row.checkedAt,
  };
}

/** The recorded check for one specific line, or `null` if that line has never been checked. */
export async function getLuxuryStealOrderCheck(
  orderRef: string,
  lineRef: string
): Promise<LuxuryStealOrderCheckRecord | null> {
  const row = await prisma.luxuryStealOrderCheck.findUnique({
    where: { orderRef_lineRef: { orderRef, lineRef } },
  });
  return row ? toRecord(row) : null;
}

/** Every recorded check for an order, oldest first — task 3-4's "did every Luxury Steal line match" read, and the audit read for staff review of a held order. */
export async function listLuxuryStealOrderChecksForOrder(
  orderRef: string
): Promise<LuxuryStealOrderCheckRecord[]> {
  const rows = await prisma.luxuryStealOrderCheck.findMany({
    where: { orderRef },
    orderBy: { checkedAt: "asc" },
  });
  return rows.map(toRecord);
}
