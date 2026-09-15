import {
  claimWebhookEventForProcessing,
  getWebhookEventByShopifyEventId,
  markWebhookEventFailed,
  markWebhookEventProcessed,
} from "~/db/repositories/webhookEventRepository.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

import {
  SHOPIFY_EVENT_ID_HEADER,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  SHOPIFY_TOPIC_HEADER,
} from "./headers";
import { verifyShopifyWebhookHmac } from "./verify";

export interface ReceivedWebhookEvent {
  shopifyEventId: string;
  topic: string;
  shopDomain: string | null;
  rawBody: string;
  payload: unknown;
}

export type WebhookHandler = (event: ReceivedWebhookEvent) => Promise<void>;

/**
 * Shared webhook receive plumbing (spec §0.6). No business-logic handler
 * is defined here — later slices attach their own via `handleNewEvent`.
 * This function only:
 *   1. Verifies HMAC over the raw body BEFORE any parsing (acceptance
 *      criteria 11, 12).
 *   2. Deduplicates via the webhook_event UNIQUE constraint, not a
 *      read-then-write check (acceptance criteria 13, 14).
 *   3. Persists the event, then invokes the handler, then records
 *      processed-at/error so a failure is retryable and visible.
 *
 * Dedup keys on *successful processing*, not row existence (corrected
 * 2026-09-14): only an event already marked processed short-circuits to
 * 200 without doing further work. A replayed delivery whose prior attempt
 * failed is reprocessed instead of being discarded as a duplicate — see
 * `claimWebhookEventForProcessing`.
 */
export async function receiveShopifyWebhook(
  request: Request,
  handleNewEvent: WebhookHandler
): Promise<Response> {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get(SHOPIFY_HMAC_HEADER);
  const topic = request.headers.get(SHOPIFY_TOPIC_HEADER) ?? "unknown";
  const shopDomain = request.headers.get(SHOPIFY_SHOP_DOMAIN_HEADER);
  const shopifyEventId = request.headers.get(SHOPIFY_EVENT_ID_HEADER);

  const { SHOPIFY_API_SECRET } = getEnv();
  const verified = verifyShopifyWebhookHmac(rawBody, hmacHeader, SHOPIFY_API_SECRET);

  if (!verified) {
    logger.warn("webhook.hmac_rejected", { topic, shopDomain });
    return new Response(null, { status: 401 });
  }

  if (!shopifyEventId) {
    logger.warn("webhook.missing_event_id", { topic, shopDomain });
    return new Response(null, { status: 400 });
  }

  const claim = await claimWebhookEventForProcessing({ shopifyEventId, topic, shopDomain, rawBody });

  if (claim.kind === "already_processed") {
    logger.info("webhook.duplicate", { topic, shopifyEventId });
    return new Response(null, { status: 200 });
  }

  if (claim.kind === "in_progress") {
    // Another delivery claimed this recently and is probably still working
    // on it. Do not reprocess — double-executing a handler that may move
    // money or qualify a Group Buy unit is worse than a delayed retry.
    //
    // But respond 503, NOT 200: a 2xx promises Shopify the delivery
    // succeeded and permanently ends redelivery. If the other attempt dies
    // without recording anything, a 200 here would bury the event forever.
    // A 5xx keeps it in Shopify's retry schedule, where the retry either
    // finds it already processed (200, no work) or finds the claim stale
    // and reclaims it. An unresolved event then stays visible in Shopify's
    // failed-delivery reporting instead of vanishing silently.
    logger.warn("webhook.in_progress_retry_requested", { topic, shopifyEventId });
    return new Response(null, { status: 503 });
  }

  if (claim.kind === "claimed_retry") {
    logger.info("webhook.reprocessing_after_prior_failure", { topic, shopifyEventId });
  }

  if (claim.kind === "claimed_stale") {
    // The attempt that previously held this claim never recorded a result
    // and the claim has aged past the staleness threshold — treat it as a
    // crashed attempt and reprocess. Safe because CLAUDE.md requires event
    // processing to be idempotent and money operations are separately
    // guarded by executeIdempotent.
    logger.warn("webhook.reclaimed_stale_claim", { topic, shopifyEventId });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await markWebhookEventFailed(shopifyEventId, "raw body was not valid JSON");
    logger.error("webhook.invalid_json", { topic, shopifyEventId });
    return new Response(null, { status: 400 });
  }

  try {
    await handleNewEvent({ shopifyEventId, topic, shopDomain, rawBody, payload });
    await markWebhookEventProcessed(shopifyEventId);
    return new Response(null, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markWebhookEventFailed(shopifyEventId, message);
    logger.error("webhook.processing_failed", { topic, shopifyEventId, error: message });
    return new Response(null, { status: 500 });
  }
}

export { getWebhookEventByShopifyEventId };
