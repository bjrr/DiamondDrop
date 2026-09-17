import { createAuditEvent } from "./auditEventRepository.server";

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
 * Approval and rejection both REQUIRE an actor (§9.5, criterion 28). There is
 * no code path here that records a decision without one — an unattributable
 * approval of a price change is not an approval.
 */
export async function recordIntentDecision(input: {
  intentId: string;
  status: "approved" | "rejected";
  actor: string;
  reason?: string;
}) {
  if (!input.actor || input.actor.trim() === "") {
    throw new Error("An actor is required to approve or reject a price sync intent.");
  }

  const updated = await prisma.priceSyncIntent.update({
    where: { id: input.intentId },
    data: {
      status: input.status,
      decidedBy: input.actor,
      decidedAt: new Date(),
      reason: input.reason ?? null,
    },
  });

  await createAuditEvent({
    actorType: "staff",
    actorRef: input.actor,
    action: `price_sync_intent.${input.status}`,
    entityType: "price_sync_intent",
    entityId: input.intentId,
    reason: input.reason ?? `Intent ${input.status} by ${input.actor}`,
  });

  return updated;
}
