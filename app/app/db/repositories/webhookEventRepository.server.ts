import { Prisma } from "@prisma/client";

import { prisma } from "../client.server";

export interface NewWebhookEventInput {
  shopifyEventId: string;
  topic: string;
  shopDomain: string | null;
  rawBody: string;
}

/**
 * Outcome of attempting to claim a delivery for processing (spec §0.6,
 * corrected 2026-09-14):
 *   - "new": this is the first time this event id has ever been recorded;
 *     the caller now exclusively owns processing it.
 *   - "claimed_retry": a row already existed but its prior attempt
 *     definitively *failed* (error was recorded and it was never marked
 *     processed) — this caller has exclusively re-claimed it for
 *     reprocessing. A replayed delivery whose prior attempt failed must not
 *     be silently swallowed as a duplicate, or the event is lost forever.
 *   - "already_processed": a row already exists and was already marked
 *     processed successfully — a genuine no-op duplicate. Only this case
 *     may short-circuit to 200 without doing further work.
 *   - "claimed_stale": a row already existed, was never marked processed and
 *     never marked failed, but its last claim is older than the staleness
 *     threshold — i.e. the attempt that owned it almost certainly crashed
 *     before it could record anything. This caller has exclusively
 *     re-claimed it. Without this case a crash leaves the row stuck
 *     forever and the event is lost silently.
 *   - "in_progress": a row already exists, is unprocessed, has no recorded
 *     error, and was claimed recently enough that another delivery is
 *     probably still working on it. We deliberately do not reprocess here —
 *     double-executing a handler that may move money or qualify a Group Buy
 *     unit is worse than a delayed retry. The caller must still respond 5xx
 *     so Shopify retries: responding 200 would promise Shopify the delivery
 *     succeeded and permanently end redelivery, turning a transient overlap
 *     into a silent loss.
 */
export type WebhookEventClaim =
  | { kind: "new" }
  | { kind: "claimed_retry" }
  | { kind: "claimed_stale" }
  | { kind: "already_processed" }
  | { kind: "in_progress" };

/**
 * How long a claim may sit unprocessed and error-free before it is treated
 * as a crashed attempt. Deliberately generous: any webhook handler still
 * running after this is pathological. Reclaiming is safe because CLAUDE.md
 * requires event processing to be idempotent and every money-moving
 * operation is separately guarded by `executeIdempotent`.
 */
export const DEFAULT_STALE_CLAIM_MS = 15 * 60 * 1000;

/**
 * webhook_event is mutable (not append-only) — processedAt/error are
 * updated after receipt. Both the initial insert and the retry-claim below
 * are decided by a database constraint / conditional write, not a
 * read-then-write check, so concurrent deliveries of the same event can
 * never both win a claim (spec §0.6, acceptance criterion 14).
 */
export async function claimWebhookEventForProcessing(
  input: NewWebhookEventInput,
  staleClaimMs: number = DEFAULT_STALE_CLAIM_MS
): Promise<WebhookEventClaim> {
  const now = new Date();

  try {
    await prisma.webhookEvent.create({
      data: {
        shopifyEventId: input.shopifyEventId,
        topic: input.topic,
        shopDomain: input.shopDomain,
        rawBody: input.rawBody,
        claimedAt: now,
      },
    });
    return { kind: "new" };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
  }

  // A row already exists. Try to atomically reclaim it for reprocessing —
  // this only succeeds if a *prior* attempt definitively failed (error is
  // set, processedAt is still null). The WHERE clause is what wins the
  // race: if two retries of the same failed event arrive concurrently, the
  // first UPDATE clears `error`, so the second UPDATE's WHERE clause no
  // longer matches and it affects zero rows.
  const claimedRetry = await prisma.webhookEvent.updateMany({
    where: { shopifyEventId: input.shopifyEventId, processedAt: null, error: { not: null } },
    data: { error: null, claimedAt: now },
  });
  if (claimedRetry.count === 1) {
    return { kind: "claimed_retry" };
  }

  // No recorded failure. Before concluding another delivery is actively
  // working on it, check whether the last claim is old enough that the
  // attempt owning it must have crashed. Same atomic conditional-update
  // pattern: the first reclaim moves claimedAt forward, so a concurrent
  // reclaim's `claimedAt < cutoff` predicate no longer matches.
  const cutoff = new Date(now.getTime() - staleClaimMs);
  const claimedStale = await prisma.webhookEvent.updateMany({
    where: {
      shopifyEventId: input.shopifyEventId,
      processedAt: null,
      error: null,
      claimedAt: { lt: cutoff },
    },
    data: { claimedAt: now },
  });
  if (claimedStale.count === 1) {
    return { kind: "claimed_stale" };
  }

  const existing = await prisma.webhookEvent.findUnique({ where: { shopifyEventId: input.shopifyEventId } });
  if (existing?.processedAt) {
    return { kind: "already_processed" };
  }
  return { kind: "in_progress" };
}

export async function markWebhookEventProcessed(shopifyEventId: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { shopifyEventId },
    data: { processedAt: new Date(), error: null },
  });
}

export async function markWebhookEventFailed(shopifyEventId: string, error: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { shopifyEventId },
    data: { error },
  });
}

export async function getWebhookEventByShopifyEventId(shopifyEventId: string) {
  return prisma.webhookEvent.findUnique({ where: { shopifyEventId } });
}
