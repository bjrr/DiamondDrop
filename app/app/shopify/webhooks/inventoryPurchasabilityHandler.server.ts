import { z } from "zod";

import { prisma } from "~/db/client.server";
import { logger } from "~/lib/logger.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { recomputeAndPublishAsLowAs } from "~/shopify/metafields/asLowAsAggregator.server";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * R15 (owner ruling, 2026-09-20, owner exit proof P2) — the event-driven
 * recompute trigger for the "as low as" aggregate.
 *
 * THE PAYLOAD IS AN INVALIDATION SIGNAL, NEVER A DATA SOURCE. R15's own
 * wording, and criterion 43's principle applied to an INBOUND event this
 * time: a webhook payload may tell us WHAT TO LOOK AT, never WHAT A THING
 * COSTS or WHETHER IT IS IN STOCK. Every field this module reads from a
 * payload below is an IDENTIFIER used to find which product to re-check —
 * never a price, quantity or availability value taken at face value.
 * Purchasability and the resulting "as low as" figure are ALWAYS re-resolved
 * from Shopify's and our own current state afterward, via
 * `computeAsLowAsForProduct` (which itself makes a fresh `availableForSale`
 * Admin API call — see `variantAvailability.server.ts`).
 *
 * THIS IS WHAT MAKES THE HANDLER IDEMPOTENT BY CONSTRUCTION, NOT BY
 * BOOKKEEPING. A duplicate delivery (already deduplicated one layer up by
 * `receiveShopifyWebhook`/`claimWebhookEventForProcessing`, but also safe
 * even if that ever changed), an out-of-order delivery, or a delivery for a
 * state that has since changed again all resolve to the SAME action: look up
 * the product's CURRENT state and recompute. There is no stale-payload
 * ordering problem to solve, because the payload is never trusted for
 * anything but routing.
 *
 * EXACT PAYLOAD SHAPE — HONESTLY STATED, NOT ASSUMED. `products/update`'s
 * payload shape is Shopify's well-documented product resource (top-level
 * `id`/`admin_graphql_api_id`). `variants/out_of_stock` and
 * `variants/in_stock` are newer, thinly-documented topics, and THIS SLICE
 * WAS NOT ABLE TO VERIFY THEIR EXACT PAYLOAD SHAPE AGAINST A REAL DELIVERED
 * WEBHOOK — no publicly reachable endpoint was available in this working
 * session to receive one (see the 2B-6 handoff for what WAS verified live:
 * both topics exist as real `WebhookSubscriptionTopic` enum values, and
 * `webhookSubscriptionCreate` accepts both under the app's current
 * `write_products` scope with zero userErrors). Extraction below is
 * therefore DELIBERATELY DEFENSIVE: it tries every plausible identifier
 * field, in a fixed priority order, and — if none resolves to a product we
 * know — logs loudly and returns WITHOUT THROWING, rather than either
 * guessing or endlessly retrying a delivery that can never resolve. A
 * genuinely missed event is still caught by the daily recalculation run
 * (R15: reconciliation for missed deliveries, never the freshness
 * mechanism), so failing this one delivery softly is the correct trade-off,
 * not a hidden bug — but it is exactly the seam to check first against a
 * real captured payload if these routes ever look like they are not firing.
 */

const identifierSchema = z.union([z.string(), z.number()]);

const webhookIdentifierPayloadSchema = z
  .object({
    id: identifierSchema,
    admin_graphql_api_id: z.string(),
    product_id: identifierSchema,
    variant_id: identifierSchema,
  })
  .partial()
  .passthrough();

/** Which shape of payload a route is wired to receive — set by the CALLER from the route it lives in, never inferred from payload content. */
export type InventoryWebhookKind = "product" | "variant";

export interface ExtractedShopifyIdentifiers {
  readonly productGid?: string;
  readonly variantGid?: string;
}

function isGidOfType(value: string, type: string): boolean {
  return value.startsWith(`gid://shopify/${type}/`);
}

function toProductGid(legacyId: string | number): string {
  return `gid://shopify/Product/${legacyId}`;
}

function toVariantGid(legacyId: string | number): string {
  return `gid://shopify/ProductVariant/${legacyId}`;
}

/**
 * PURE — no I/O, unit-testable with no database or network. Extracts
 * whatever Shopify identifiers a payload names for the given webhook KIND.
 * Returns `{}` (nothing resolvable) rather than throwing on an unfamiliar
 * shape — HMAC verification already proved this came from Shopify one layer
 * up, so an unrecognised shape means an evolving/unmodeled payload, not an
 * attack, and must not crash the handler.
 */
export function extractShopifyIdentifiers(
  kind: InventoryWebhookKind,
  payload: unknown
): ExtractedShopifyIdentifiers {
  const result = webhookIdentifierPayloadSchema.safeParse(payload);
  if (!result.success) return {};
  const p = result.data;

  if (kind === "product") {
    // products/update: the payload IS the product resource. Prefer the GID
    // form (unambiguous); fall back to constructing one from the legacy id.
    if (p.admin_graphql_api_id && isGidOfType(p.admin_graphql_api_id, "Product")) {
      return { productGid: p.admin_graphql_api_id };
    }
    if (p.id !== undefined) return { productGid: toProductGid(p.id) };
    return {};
  }

  // kind === "variant" (variants/out_of_stock, variants/in_stock).
  if (p.admin_graphql_api_id && isGidOfType(p.admin_graphql_api_id, "ProductVariant")) {
    return { variantGid: p.admin_graphql_api_id };
  }
  // A parent product_id, if the payload carries one, resolves in ONE query
  // rather than two (skips the variant->product join below).
  if (p.product_id !== undefined) return { productGid: toProductGid(p.product_id) };
  if (p.variant_id !== undefined) return { variantGid: toVariantGid(p.variant_id) };
  // Last resort: for a variant-shaped topic, a bare top-level `id` is most
  // plausibly the variant's own id (REST webhook payloads commonly put the
  // primary resource's id at top level).
  if (p.id !== undefined) return { variantGid: toVariantGid(p.id) };
  return {};
}

async function resolveMasterProduct(
  identifiers: ExtractedShopifyIdentifiers
): Promise<{ masterProductId: string; shopifyProductGid: string } | null> {
  if (identifiers.productGid) {
    const product = await prisma.masterProduct.findUnique({
      where: { shopifyProductGid: identifiers.productGid },
      select: { id: true, shopifyProductGid: true },
    });
    if (product?.shopifyProductGid) {
      return { masterProductId: product.id, shopifyProductGid: product.shopifyProductGid };
    }
    return null;
  }
  if (identifiers.variantGid) {
    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: identifiers.variantGid },
      select: { masterProduct: { select: { id: true, shopifyProductGid: true } } },
    });
    if (variant?.masterProduct.shopifyProductGid) {
      return {
        masterProductId: variant.masterProduct.id,
        shopifyProductGid: variant.masterProduct.shopifyProductGid,
      };
    }
    return null;
  }
  return null;
}

/**
 * The handler all three R15 webhook routes call. Same function regardless
 * of which topic fired — every one of them means the same thing here:
 * "some product's purchasability may have changed; recompute it."
 *
 * Resolves its Admin API client from `event.shopDomain` (the webhook's own
 * `X-Shopify-Shop-Domain`, not a re-read of a configured env value) — this
 * is an async, session-less delivery, so there is no request-scoped admin
 * session to reuse, mirroring how `productionPriceSyncPort.server.ts`
 * resolves one for the background recalculation job. INJECTABLE
 * (`deps.resolveAdminClient`) for exactly that reason: an integration test
 * can fake the boundary — the same seam the aggregator already uses — rather
 * than needing a real stored offline session or hitting the network.
 *
 * DOES NOT SWALLOW a genuine recompute failure — an Admin API error here
 * propagates, `receiveShopifyWebhook` marks the delivery failed and returns
 * 5xx, and Shopify retries. Unlike the "identifiers didn't resolve" case
 * above, a failure INSIDE the recompute (once we know which product to look
 * at) is exactly the kind of transient error retry exists for.
 */
export interface HandleInventoryPurchasabilityWebhookDeps {
  resolveAdminClient?: (shopDomain: string) => Promise<AdminGraphqlClient>;
}

async function defaultResolveAdminClient(shopDomain: string): Promise<AdminGraphqlClient> {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
}

export async function handleInventoryPurchasabilityWebhook(
  kind: InventoryWebhookKind,
  event: ReceivedWebhookEvent,
  deps: HandleInventoryPurchasabilityWebhookDeps = {}
): Promise<void> {
  const identifiers = extractShopifyIdentifiers(kind, event.payload);
  const resolved = await resolveMasterProduct(identifiers);

  if (!resolved) {
    // Not necessarily a bug — Shopify fires these topics for products/
    // variants outside our catalogue too (e.g. a theme's own sample data).
    // Logged loudly so a genuinely wrong extraction is discoverable against
    // a real payload, but never thrown: throwing would mark this delivery
    // failed and have Shopify retry indefinitely for something that will
    // never resolve.
    logger.warn("webhook.inventory_recompute_unresolved", {
      topic: event.topic,
      shopifyEventId: event.shopifyEventId,
      kind,
    });
    return;
  }

  if (!event.shopDomain) {
    logger.error("webhook.inventory_recompute_missing_shop_domain", {
      topic: event.topic,
      shopifyEventId: event.shopifyEventId,
    });
    return;
  }

  const resolveAdminClient = deps.resolveAdminClient ?? defaultResolveAdminClient;
  const client = await resolveAdminClient(event.shopDomain);

  await recomputeAndPublishAsLowAs(resolved.masterProductId, resolved.shopifyProductGid, { client });
}
