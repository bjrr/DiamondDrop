import { prisma } from "../client.server";
/**
 * L6 — the mutable review and sync state machine (spec §7.2, §9.4).
 *
 * Unlike `price_calculation`, this table is deliberately MUTABLE and carries
 * no append-only trigger: it is the workflow
 * (pending_approval -> approved -> syncing -> synced), and freezing it would
 * freeze the workflow.
 *
 * Idempotency is structural, not wrapped: a partial unique index permits at
 * most one non-terminal intent per variant, so a second run supersedes the
 * prior pending intent rather than opening a competing one. Price sync is
 * deliberately NOT routed through executeIdempotent (§9.4) — that wrapper is
 * for outbound money movement and carries defects gated at slice 4.
 */
const TERMINAL_STATUSES = ["synced", "rejected", "failed", "superseded"] as const;
export interface UpsertIntentInput {
  masterVariantId: string;
  priceCalculationId: string;
  decision: "auto_apply" | "needs_approval";
  /**
   * "synced" is ONLY for a genuine no-op — a price that did not change. A
   * CHANGED price that auto-applies becomes "approved": cleared for sync but
   * not yet synced, because slice 1 never calls ShopifyPriceSyncPort. Writing
   * "synced" for work that never happened would be a false audit record
   * claiming a price reached Shopify.
   */
  status: "pending_approval" | "approved" | "synced";
  previousPriceMinorUnits?: bigint | null;
  previousPriceCurrency?: string | null;
  deltaBps?: number | null;
  reason?: string | null;
}
/**
 * Supersedes any open intent for the variant, then creates the new one.
 *
 * Superseding is audited rather than silent: an intent a human was asked to
 * review must not vanish without a record of why.
 */
export async function supersedeAndCreateIntent(input: UpsertIntentInput) {
  return prisma.$transaction(async (tx) => {
    const open = await tx.priceSyncIntent.findFirst({
      where: { masterVariantId: input.masterVariantId, status: { notIn: [...TERMINAL_STATUSES] } },
    });
    if (open) {
      await tx.priceSyncIntent.update({
        where: { id: open.id },
        data: { status: "superseded", reason: "superseded by a newer recalculation" },
      });
      await tx.auditEvent.create({
        data: {
          actorType: "system",
          actorRef: "price-recalculation-job",
          action: "price_sync_intent.superseded",
          entityType: "price_sync_intent",
          entityId: open.id,
          reason: "A newer price calculation replaced this pending intent",
        },
      });
    }
    return tx.priceSyncIntent.create({
      data: {
        masterVariantId: input.masterVariantId,
        priceCalculationId: input.priceCalculationId,
        decision: input.decision,
        status: input.status,
        previousPriceMinorUnits: input.previousPriceMinorUnits ?? null,
        previousPriceCurrency: input.previousPriceCurrency ?? null,
        deltaBps: input.deltaBps ?? null,
        reason: input.reason ?? null,
        attemptCount: 0,
      },
    });
  });
}
export async function listPendingIntents() {
  return prisma.priceSyncIntent.findMany({
    where: { status: "pending_approval" },
    orderBy: { createdAt: "asc" },
    include: {
      priceCalculation: { include: { pricingProfile: true } },
      masterVariant: { include: { masterProduct: true } },
    },
  });
}
export async function getIntentById(id: string) {
  return prisma.priceSyncIntent.findUnique({
    where: { id },
    include: { priceCalculation: { include: { pricingProfile: true } } },
  });
}
/**
 * Approval and rejection live in ONE place:
 * `app/app/jobs/pricing/intentTransitions.server.ts`.
 *
 * This repository deliberately exposes no decision function. It previously had
 * one, and the CLI had a second, divergent implementation — only the CLI
 * carried the D14 placeholder guard, so the exported repository version would
 * approve a price computed from invented margins. Two writers, one guard.
 *
 * Import `decideIntent` instead. It enforces the actor, the allowed
 * transition, the D14 guard and the audit event together, so a future caller
 * cannot acquire some of those and miss the rest.
 */
