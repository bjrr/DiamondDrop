import { Prisma } from "@prisma/client";

import { decideOverrideExpiry } from "~/domain/pricing/overrideExpiry";

import { prisma } from "../client.server";

/**
 * Override expiry — the repository side (owner §2.4; spec criteria 15/16).
 *
 * Pairs with the PURE decision in `~/domain/pricing/overrideExpiry`: this
 * module resolves the real rows, calls the decision function with explicit
 * inputs, and — when it decides to expire — APPENDS a `price_override` row
 * of kind `expired`, chained via `supersedesId`, exactly as
 * `revokePriceOverride` appends a `revoke` row (`app/app/jobs/pricing/
 * priceOverride.server.ts`, owned by another agent and deliberately not
 * imported here — see the note on `resolveActiveOverrideForExpiry` below).
 * It never mutates or deletes the row it retires; the table stays
 * append-only (migration 20260913000100 and its extensions).
 *
 * A DOCUMENTED SEAM, not wired into the recalculation job. Slice 1's
 * `app/app/jobs/pricing/ports.ts` establishes the pattern this follows: a
 * self-contained, independently-testable unit that a job file calls, rather
 * than this module reaching into the job to trigger itself. Whoever wires
 * the recalculation loop (T2/T4) calls `expireOverrideIfMaterial` once per
 * variant after computing that variant's new calculation, passing the new
 * calculation's id.
 */

/**
 * The override currently in force for a variant, if any.
 *
 * DELIBERATELY NOT IMPORTED from `app/app/jobs/pricing/priceOverride.server.ts`
 * (`resolveActiveOverride`), even though the two are semantically identical:
 * that file lives in a layer this repository must not depend on (job code
 * orchestrates on top of repositories, never the reverse), and it is being
 * actively edited by another agent this task is scoped around not touching.
 * The query itself is a two-line, fully-covered-by-tests primitive — the
 * duplication is cheap and the layering it preserves is not.
 */
async function resolveActiveOverrideForExpiry(masterVariantId: string) {
  const head = await prisma.priceOverride.findFirst({
    where: { masterVariantId, supersededBy: null },
    orderBy: { createdAt: "desc" },
  });

  if (!head || head.kind !== "set") return null;
  return head;
}

export interface ExpireOverrideIfMaterialInput {
  masterVariantId: string;
  /** The calculation the recalculation just produced for this variant. */
  newPriceCalculationId: string;
  /**
   * Attribution for the appended `expired` row. No human causes an
   * automatic expiry, so this identifies the PROCESS that did — mirroring
   * `PriceRecalculationRun.triggeredBy` being null (not invented) for a
   * scheduled run, except here the column is NOT NULL
   * (`price_override_actor_not_blank`), so a process identity is required
   * rather than omitted.
   */
  expiredBy?: string;
}

export type ExpireOverrideResult =
  | { expired: false; reason: string }
  | { expired: true; expiredOverrideId: string; retiredOverrideId: string; reason: string };

const DEFAULT_EXPIRED_BY = "system:price-recalculation";

/**
 * Judges the override in force for a variant against a newly computed
 * calculation, and appends an `expired` row when the recalculation was
 * material. A no-op — not an error — when there is nothing in force, when
 * the override cannot be judged (see below), or when the change is
 * immaterial (including EVERY case where `neverExpire` is set).
 *
 * IDEMPOTENT under concurrent callers. Two processes racing to expire the
 * same override both pass the decision, but only one INSERT can win the
 * partial unique index on `supersedesId` (migration 20260917161500) — the
 * loser's P2002 is caught and re-read as "someone else already expired it",
 * never surfaced as a crash. Proven by a concurrency test rather than
 * asserted from the constraint alone.
 */
export async function expireOverrideIfMaterial(
  input: ExpireOverrideIfMaterialInput
): Promise<ExpireOverrideResult> {
  const active = await resolveActiveOverrideForExpiry(input.masterVariantId);
  if (!active) {
    return { expired: false, reason: "no override is currently in force for this variant" };
  }

  if (!active.priceCalculationId) {
    // Defensive: applyPriceOverride always names the calculation it
    // evaluated against, but the column is nullable at the schema level.
    // An override with no departed-from calculation has no basis for a
    // materiality judgement and is left in force rather than guessed at.
    return {
      expired: false,
      reason: "override carries no departed-from calculation — cannot judge materiality, left in force",
    };
  }

  const [departedFrom, recalculated] = await Promise.all([
    prisma.priceCalculation.findUniqueOrThrow({ where: { id: active.priceCalculationId } }),
    prisma.priceCalculation.findUniqueOrThrow({ where: { id: input.newPriceCalculationId } }),
  ]);

  const decision = decideOverrideExpiry({
    neverExpire: active.neverExpire,
    departedFromBankPaymentPriceMinorUnits: departedFrom.bankPaymentPriceMinorUnits,
    departedFromCurrency: departedFrom.currency,
    recalculatedBankPaymentPriceMinorUnits: recalculated.bankPaymentPriceMinorUnits,
    recalculatedCurrency: recalculated.currency,
  });

  if (!decision.expires) {
    return { expired: false, reason: decision.reason };
  }

  try {
    const expiredRow = await prisma.priceOverride.create({
      data: {
        masterVariantId: input.masterVariantId,
        kind: "expired",
        supersedesId: active.id,
        // Points at the NEW calculation that caused the expiry — not,
        // unlike `revokePriceOverride`, a copy of the retired row's own
        // reference. A revoke has no causal calculation to name; an expiry
        // genuinely does, and naming it is what makes the delta in the
        // decision's `reason` reconstructible from the row alone.
        priceCalculationId: input.newPriceCalculationId,
        // No price: an expiry, like a revoke, restores the calculated price
        // and carries none of its own. The CHECK constraint
        // (price_override_kind_bank_payment_price_coherent) refuses an
        // `expired` row that carries one.
        overrideBankPaymentPriceMinorUnits: null,
        currency: recalculated.currency,
        breachedFloors: [],
        warningShown: null,
        reason: decision.reason,
        overriddenBy: input.expiredBy?.trim() || DEFAULT_EXPIRED_BY,
      },
    });

    return {
      expired: true,
      expiredOverrideId: expiredRow.id,
      retiredOverrideId: active.id,
      reason: decision.reason,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Someone else's expiry (or a `set`/`revoke`) landed first and already
      // supersedes `active.id` — the partial unique index on `supersedesId`
      // did its job. Re-read rather than surface a crash for what is, from
      // the caller's point of view, a successful outcome: the override in
      // force is no longer stale.
      return {
        expired: false,
        reason: "a concurrent write already superseded this override — nothing left to expire",
      };
    }
    throw error;
  }
}
