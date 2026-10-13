import type { PriceSyncIntentStatus } from "@prisma/client";

import { prisma } from "~/db/client.server";

/**
 * THE ONE PLACE a price_sync_intent changes status.
 *
 * Slice 1 review found two divergent implementations of "approve": the
 * repository's `recordIntentDecision` and an inline transaction in
 * price-review.mjs. Only the CLI carried the D14 placeholder guard, and the
 * repository one — exported, importable, zero callers — would happily approve
 * a price computed from invented margins. Whoever built the slice 2 admin UI
 * would have called it and silently lost the guard.
 *
 * So: one module, one guard, an explicit transition table. A third writer
 * added later inherits both by construction rather than by remembering.
 */

export class InvalidIntentTransitionError extends Error {
  constructor(
    readonly from: PriceSyncIntentStatus,
    readonly to: PriceSyncIntentStatus
  ) {
    super(`Cannot move a price sync intent from ${from} to ${to}.`);
    this.name = "InvalidIntentTransitionError";
  }
}

export class PlaceholderProfileApprovalError extends Error {
  constructor(
    readonly intentId: string,
    readonly profileCode: string,
    readonly profileVersion: number
  ) {
    super(
      `Intent ${intentId} was computed from a PLACEHOLDER pricing profile ` +
        `(${profileCode} v${profileVersion}). Owner decision D14 — target margin, ` +
        "minimum margin, minimum dollar profit and auto-apply tolerance — is unresolved. " +
        "Seed a real profile before approving any price."
    );
    this.name = "PlaceholderProfileApprovalError";
  }
}

export class MissingActorError extends Error {
  constructor(readonly action: string) {
    super(`An actor is required to ${action} a price sync intent; there is no anonymous approval.`);
    this.name = "MissingActorError";
  }
}

/**
 * Allowed transitions, stated rather than implied.
 *
 * `syncing`, `synced` and `failed` are reachable only from `approved`, and
 * only slice 2 will drive them — slice 1 never calls the Shopify port, so it
 * never moves an intent past `approved`. The single exception is the
 * unchanged-price case, which the job creates directly in `synced` because
 * there is genuinely nothing to sync.
 */
const ALLOWED: Readonly<Record<PriceSyncIntentStatus, readonly PriceSyncIntentStatus[]>> = {
  pending_approval: ["approved", "rejected", "superseded"],
  approved: ["syncing", "synced", "failed", "superseded"],
  syncing: ["synced", "failed"],
  synced: [],
  rejected: [],
  failed: ["approved", "superseded"],
  superseded: [],
};

export function assertTransitionAllowed(
  from: PriceSyncIntentStatus,
  to: PriceSyncIntentStatus
): void {
  if (!ALLOWED[from].includes(to)) {
    throw new InvalidIntentTransitionError(from, to);
  }
}

export interface DecisionInput {
  intentId: string;
  status: "approved" | "rejected";
  actor: string;
  reason?: string;
}

/**
 * Approve or reject an intent, with an actor, an audit event and the D14
 * guard — all of which are non-optional.
 *
 * The guard applies to APPROVAL only. Rejecting a placeholder-derived price is
 * always safe: clearing a bad intent out of the queue is the point.
 */
export async function decideIntent(input: DecisionInput) {
  if (!input.actor || input.actor.trim() === "") {
    throw new MissingActorError(input.status === "approved" ? "approve" : "reject");
  }

  const intent = await prisma.priceSyncIntent.findUnique({
    where: { id: input.intentId },
    include: { priceCalculation: { include: { pricingProfile: true } } },
  });
  if (!intent) throw new Error(`No price sync intent with id ${input.intentId}.`);

  assertTransitionAllowed(intent.status, input.status);

  if (input.status === "approved" && intent.priceCalculation.pricingProfile.isPlaceholder) {
    throw new PlaceholderProfileApprovalError(
      input.intentId,
      intent.priceCalculation.pricingProfile.code,
      intent.priceCalculation.pricingProfile.version
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.priceSyncIntent.update({
      where: { id: input.intentId },
      data: {
        status: input.status,
        decidedBy: input.actor,
        decidedAt: new Date(),
        // Appended, never overwritten. An earlier version wrote `reason: null`
        // when approving without one, destroying the record of WHY review was
        // requested in the first place.
        reason: input.reason
          ? intent.reason
            ? `${intent.reason} | ${input.status} by ${input.actor}: ${input.reason}`
            : `${input.status} by ${input.actor}: ${input.reason}`
          : intent.reason,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorType: "staff",
        actorRef: input.actor,
        action: `price_sync_intent.${input.status}`,
        entityType: "price_sync_intent",
        entityId: input.intentId,
        reason: input.reason ?? `Intent ${input.status} by ${input.actor}`,
      },
    });

    return updated;
  });
}
