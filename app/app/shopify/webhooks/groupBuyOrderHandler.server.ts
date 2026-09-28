import { z } from "zod";

import { prisma } from "~/db/client.server";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import {
  CampaignNotOpenError,
  recordUnitEvent,
  VariantNotEligibleError,
} from "~/jobs/groupbuy/unitLedger.server";
import { ensureGroupBuyCampaignSyncedToCurrentTier } from "~/jobs/groupbuy/tierPriceSync.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { createProductionPriceSyncPort } from "~/shopify/admin/productionPriceSyncPort.server";
import { logger } from "~/lib/logger.server";

import { preserveShopifyBigIntIds } from "./luxuryStealOrderHandler.server";
import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * `orders/create` — Group Buy participation. THE GAP this closes: nothing in
 * the codebase called `recordUnitEvent` before this file existed, so a
 * placed Group Buy order never counted toward campaign progress
 * (`docs/ARCHITECTURE-MVP1.md` §6.2, README "Group Buy — Locked MVP1
 * Direction"). The unit-ledger domain, the tier model and the price ladder
 * are all already built and reviewed (`app/domain/groupbuy/**`); this file
 * only feeds them from the one Shopify event that must.
 *
 * COUNTS A PENDING BANK PAYMENT ORDER IMMEDIATELY, ON PURPOSE. This handler
 * never reads `financial_status`/`payment_gateway_names` at all — README:
 * "A placed Group Buy order counts toward public campaign progress
 * immediately, including a pending Bank Payment order... Payment/refund
 * status is tracked separately." Recording is triggered by the order
 * EXISTING, not by it being paid.
 *
 * PER UNIT, NOT PER LINE. `line.quantity` is passed straight through to
 * `recordUnitEvent`'s own `quantity` — three eligible pieces on one line is
 * three qualifying units, per `foldQualifyingUnits`' own contract
 * (`app/domain/groupbuy/qualifyingUnits.ts`). This file never loops per unit;
 * the ledger already treats quantity as the unit count for one event.
 *
 * IDEMPOTENT UNDER SHOPIFY REDELIVERY BY TWO INDEPENDENT MEANS, MATCHING THE
 * REST OF THIS APP'S DISCIPLINE:
 *   1. `receiveShopifyWebhook`'s own dedup on `webhook_event.shopify_event_id`
 *      (this file never sees a delivery it already finished).
 *   2. `recordUnitEvent`'s own UNIQUE `(campaignId, externalRef)` — belt and
 *      braces even if something else ever calls it. `externalRef` here is
 *      the Shopify line item GID: stable across redeliveries of the SAME
 *      order and globally unique across every order, so it needs no
 *      additional namespacing.
 *
 * A REPLAYED DELIVERY STILL RE-VERIFIES THE SHOPIFY PRICE, though — see
 * `tierPriceSync.server.ts`'s module doc comment for why gating the price
 * sync on `recordUnitEvent`'s own `duplicate` flag would be the wrong
 * idempotency key and would leave a failed publish stuck forever.
 *
 * BIG-INT IDS, AGAIN. `variant_id`/`id`/`admin_graphql_api_id` on a Shopify
 * order line can exceed 2^53; `event.payload` has already been through one
 * lossy `JSON.parse` by the time `receiveShopifyWebhook` builds it, so this
 * handler re-derives everything from the RAW body via
 * `preserveShopifyBigIntIds` (shared with the Luxury Steal `orders/create`
 * handler — a pure, generic string rewrite, not a Luxury-Steal-specific
 * rule) before parsing it a second time, exactly as that handler does and
 * for the identical reason.
 *
 * NOT COMBINED WITH THE LUXURY STEAL HANDLER'S SCHEMA ON PURPOSE. That
 * schema has no `quantity` field (Luxury Steals only ever needs 1 vs "at
 * least 1" per line to decide whether it needs an acknowledgment) and this
 * one does not need Luxury Steal's acknowledgment-property parsing. Two
 * small, independent schemas over the same raw body are cheaper to keep
 * correct than one shared schema serving two unrelated concerns.
 */

const orderLineItemSchema = z
  .object({
    id: z.string(),
    admin_graphql_api_id: z.string().optional(),
    /** Absent/null for a custom (manual, non-catalog) line item — never Group Buy eligible, since it has no variant. */
    variant_id: z.string().nullable().optional(),
    /**
     * OPTIONAL, not required. A genuine Shopify order line always carries
     * `quantity`, but this schema must not let a malformed/legacy line (or,
     * concretely, a hand-built test fixture written for a DIFFERENT handler
     * on this same shared topic — see `luxuryStealOrderHandler.server.ts`'s
     * own raw-body builder, which never sets it) fail parsing for the WHOLE
     * payload. `receiveShopifyWebhook` runs both `orders/create` handlers
     * against the identical raw body in one delivery
     * (`webhooks.carat.orders-create.tsx`); a thrown `ZodError` here would
     * mark the entire delivery failed and block the Luxury Steal handler's
     * evidence-writing too, over a field this handler's own line-eligibility
     * check (see `handleGroupBuyOrderCreateWebhook`) already treats as "skip
     * this line" when absent.
     */
    quantity: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const orderPayloadSchema = z
  .object({
    id: z.string().optional(),
    admin_graphql_api_id: z.string().optional(),
    /** When the order happened at Shopify — used as the ledger event's `occurredAt`, never "now". */
    created_at: z.string().optional(),
    line_items: z.array(orderLineItemSchema).optional(),
  })
  .passthrough();

export type GroupBuyOrderPayload = z.infer<typeof orderPayloadSchema>;
export type GroupBuyOrderLineItem = z.infer<typeof orderLineItemSchema>;

/** PURE — no I/O. Same big-int-preserving re-parse `luxuryStealOrderHandler.server.ts` uses, against this handler's own (narrower) schema. */
export function parseGroupBuyOrderPayload(rawBody: string): GroupBuyOrderPayload {
  const doctored = preserveShopifyBigIntIds(rawBody);
  const json: unknown = JSON.parse(doctored);
  return orderPayloadSchema.parse(json);
}

/** PURE. */
export function extractGroupBuyOrderRef(payload: GroupBuyOrderPayload): string {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload.id) return `gid://shopify/Order/${payload.id}`;
  throw new Error("orders/create payload has neither admin_graphql_api_id nor id");
}

/** PURE. */
export function extractGroupBuyLineRef(line: GroupBuyOrderLineItem): string {
  if (line.admin_graphql_api_id) return line.admin_graphql_api_id;
  return `gid://shopify/LineItem/${line.id}`;
}

/** PURE. `null` for a custom/manual line item with no `variant_id` — cannot be Group Buy eligible. */
export function extractGroupBuyLineVariantGid(line: GroupBuyOrderLineItem): string | null {
  if (!line.variant_id) return null;
  return normalizeShopifyVariantGid(line.variant_id);
}

export interface HandleGroupBuyOrderCreateWebhookDeps {
  /** Injected in tests. Production default lazily creates the real Admin API-backed port — see `createProductionPriceSyncPort`'s own doc comment for why that creation is deferred rather than imported eagerly. */
  resolveSyncPort?: () => Promise<ShopifyPriceSyncPort>;
}

/**
 * The handler `webhooks.carat.orders-create.tsx` wires to `receiveShopifyWebhook`
 * alongside the Luxury Steal handler. For every line with a resolvable variant
 * that belongs to at least one OPEN Group Buy campaign, records one qualifying-unit
 * event per campaign, then ensures every campaign touched by this order is
 * published on Shopify at its current tier price.
 *
 * THROWS (rather than swallows) when a tier's price sync fails for any
 * variant, so the whole webhook delivery is marked failed and Shopify
 * redelivers it — see `tierPriceSync.server.ts` for why that redelivery,
 * not a background retry job, is what makes an Admin API outage
 * self-healing here. Unit recording for THIS delivery has already committed
 * to Postgres by the time that throw happens (Postgres first, Shopify
 * after — the same ordering `luxuryStealOrderHandler.server.ts` uses), so a
 * publish failure never loses or duplicates a qualifying unit.
 */
export async function handleGroupBuyOrderCreateWebhook(
  event: ReceivedWebhookEvent,
  deps: HandleGroupBuyOrderCreateWebhookDeps = {}
): Promise<void> {
  const resolveSyncPort = deps.resolveSyncPort ?? createProductionPriceSyncPort;

  const payload = parseGroupBuyOrderPayload(event.rawBody);
  const orderRef = extractGroupBuyOrderRef(payload);
  const occurredAt = payload.created_at ? new Date(payload.created_at) : new Date();

  const touchedCampaignIds = new Set<string>();

  for (const line of payload.line_items ?? []) {
    const lineVariantGid = extractGroupBuyLineVariantGid(line);
    if (!lineVariantGid) continue; // custom/manual line item — no variant, cannot be Group Buy eligible
    // `quantity` is optional in the schema (see its own doc comment) —
    // absent or non-positive both mean "nothing purchased on this line".
    if (!line.quantity || line.quantity <= 0) continue;

    const lineRef = extractGroupBuyLineRef(line);

    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: lineVariantGid },
      select: { id: true },
    });
    if (!variant) {
      // A variant genuinely outside our catalogue — nothing to check it
      // against, and not necessarily a bug (same reasoning the Luxury Steal
      // handler and `inventoryPurchasabilityHandler.server.ts` already use).
      logger.warn("groupbuy_order.unresolved_variant", { orderRef, lineRef, variantGid: lineVariantGid });
      continue;
    }

    // Only OPEN campaigns. A variant that once belonged to a now-closed
    // campaign, or that was never added to any campaign, is simply not
    // Group Buy eligible for this order.
    const eligibleCampaigns = await prisma.groupBuyCampaignVariant.findMany({
      where: { masterVariantId: variant.id, campaign: { status: "open" } },
      select: { campaignId: true },
    });

    for (const { campaignId } of eligibleCampaigns) {
      try {
        await recordUnitEvent({
          campaignId,
          masterVariantId: variant.id,
          kind: "purchased",
          quantity: line.quantity,
          orderRef,
          lineRef,
          externalRef: lineRef,
          occurredAt,
          recordedBy: "system:shopify-webhook:orders/create",
        });
        touchedCampaignIds.add(campaignId);
      } catch (error) {
        if (error instanceof CampaignNotOpenError) {
          // Closed between our eligibility read above and this write — the
          // ledger correctly refuses new units for a campaign no longer
          // running. Not a bug, and not something a retry can fix.
          logger.warn("groupbuy_order.campaign_closed_before_record", { orderRef, lineRef, campaignId });
          continue;
        }
        if (error instanceof VariantNotEligibleError) {
          // Should not happen given the eligibility read above (defensive
          // only, e.g. a variant removed from the campaign in the same
          // instant) — logged and skipped for the same reason: an eligibility
          // change is not a fault this delivery can retry its way out of.
          logger.warn("groupbuy_order.variant_no_longer_eligible", { orderRef, lineRef, campaignId });
          continue;
        }
        throw error;
      }
    }
  }

  if (touchedCampaignIds.size === 0) return;

  const failures: string[] = [];
  for (const campaignId of touchedCampaignIds) {
    try {
      await ensureGroupBuyCampaignSyncedToCurrentTier(campaignId, { resolveSyncPort });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("groupbuy_order.tier_price_sync_failed", { orderRef, campaignId, error: message });
      failures.push(`campaign ${campaignId}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`groupbuy_order: tier price sync incomplete — ${failures.join("; ")}`);
  }
}
