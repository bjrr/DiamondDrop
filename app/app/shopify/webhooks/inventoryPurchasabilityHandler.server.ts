import { z } from "zod";

import { prisma } from "~/db/client.server";
import { logger } from "~/lib/logger.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { recomputeAndPublishAsLowAs } from "~/shopify/metafields/asLowAsAggregator.server";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * R15, superseded in part by R17 (owner rulings, 2026-09-20, owner exit
 * proof P2) — the event-driven recompute trigger for the "as low as"
 * aggregate.
 *
 * TOPIC HISTORY, RECORDED BECAUSE IT IS LOAD-BEARING. R15 originally chose
 * `variants/out_of_stock`/`variants/in_stock` specifically to avoid
 * requesting `read_inventory`. Live verification against a real product
 * (ACTIVE, published, inventory-tracked) proved those two topics DO NOT FIRE
 * for a real transition — `products/update`, tested as the control on the
 * identical product/app/tunnel/session, delivered in ~1 second, including a
 * genuine Shopify redelivery our dedup caught. R17 replaces them with
 * `inventory_levels/update` under a newly-approved `read_inventory` scope,
 * on the strength of that observed negative, not an assumption. This module
 * now handles TWO webhook shapes: `products/update` (kind: "product") and
 * `inventory_levels/update` (kind: "inventory_item").
 *
 * THE PAYLOAD IS AN INVALIDATION SIGNAL, NEVER A DATA SOURCE. R15's own
 * wording, reaffirmed by R17, and criterion 43's principle applied to an
 * INBOUND event this time: a webhook payload may tell us WHAT TO LOOK AT,
 * never WHAT A THING COSTS or WHETHER IT IS IN STOCK. Every field this
 * module reads from a payload is an IDENTIFIER used to find which
 * product/variant to re-check — never a price, quantity or availability
 * value taken at face value. In particular, `inventory_levels/update`'s own
 * `available` field is NEVER READ AT ALL: inventory spans multiple
 * locations, so one location's level reaching zero does not mean the
 * variant is unpurchasable overall, and a stale/partial payload value must
 * never stand in for a real re-check. Purchasability and the resulting
 * "as low as" figure are ALWAYS re-resolved from Shopify's and our own
 * current state afterward, via `computeAsLowAsForProduct` (which itself
 * makes a fresh `availableForSale` Admin API call — see
 * `variantAvailability.server.ts`).
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
 * `inventory_item_id` MUST NEVER BE PARSED AS A JS NUMBER (R17). It is a
 * 64-bit Shopify id; `Number(...)` silently loses precision above
 * `2^53 - 1` and produces a DIFFERENT, still-plausible-looking id — the
 * lookup then either resolves to nothing (indistinguishable from "not our
 * catalogue") or, worse, to the WRONG variant. This is the exact failure
 * class R14 already forced a fix for once in this stage (a money-comparison
 * field silently going through a JS number) — here on the READ side of a
 * webhook instead of a metafield WRITE. The fix is the same shape: never let
 * the value pass through a JS number at all. `event.payload` has ALREADY
 * been through `JSON.parse` by the time this module sees it (in
 * `receive.server.ts`), which is itself lossy for a >2^53 field — so this
 * module reads `inventory_item_id` OUT OF THE RAW BODY TEXT directly, via a
 * targeted regex, and never off `event.payload` at all. See
 * `extractInventoryItemGidFromRawBody` below.
 *
 * `inventory_levels/update`'s payload shape (Shopify's long-documented,
 * stable REST shape — this is one of the OLDER inventory topics, not the
 * newer/thinly-documented ones R15 originally reached for) is flat:
 * `{ inventory_item_id, location_id, available, updated_at }`, with no
 * nested object and no `admin_graphql_api_id` field at all — unlike most
 * newer resource webhooks. The regex extraction below assumes exactly that
 * flat shape.
 *
 * `products/update`'s payload shape remains Shopify's well-documented
 * product resource (top-level `id`/`admin_graphql_api_id`) and is still
 * read the ordinary way (through `event.payload`) — a product's own numeric
 * id is well within the safe-integer range in every real Shopify catalogue,
 * and `admin_graphql_api_id` is already a string with no numeric parsing at
 * all, so `products/update` carries none of the 64-bit hazard
 * `inventory_item_id` does.
 *
 * AN UNRESOLVED IDENTIFIER LOGS AND RETURNS, NEVER THROWS. Not necessarily
 * a bug — Shopify fires these topics for products/variants outside our
 * catalogue too, and (before a backfill runs) for every variant whose
 * `shopify_inventory_item_gid` mapping is not yet populated. Logged loudly
 * so a genuinely wrong extraction is discoverable, but never thrown:
 * throwing would mark the delivery failed and have Shopify retry
 * indefinitely for something that can never resolve. A genuinely missed
 * event is still caught by the daily recalculation run (R15: reconciliation
 * for missed deliveries, never the freshness mechanism).
 */

const identifierSchema = z.union([z.string(), z.number()]);

const webhookIdentifierPayloadSchema = z
  .object({
    id: identifierSchema,
    admin_graphql_api_id: z.string(),
  })
  .partial()
  .passthrough();

/** Which shape of payload a route is wired to receive — set by the CALLER from the route it lives in, never inferred from payload content. */
export type InventoryWebhookKind = "product" | "inventory_item";

export interface ExtractedShopifyIdentifiers {
  readonly productGid?: string;
  readonly inventoryItemGid?: string;
}

function isGidOfType(value: string, type: string): boolean {
  return value.startsWith(`gid://shopify/${type}/`);
}

function toProductGid(legacyId: string | number): string {
  return `gid://shopify/Product/${legacyId}`;
}

/**
 * PURE — no I/O, unit-testable with no database or network. Extracts the
 * Product identifier a `products/update` payload names. Returns `{}`
 * (nothing resolvable) rather than throwing on an unfamiliar shape — HMAC
 * verification already proved this came from Shopify one layer up, so an
 * unrecognised shape means an evolving/unmodeled payload, not an attack,
 * and must not crash the handler.
 */
export function extractShopifyIdentifiers(kind: "product", payload: unknown): ExtractedShopifyIdentifiers {
  const result = webhookIdentifierPayloadSchema.safeParse(payload);
  if (!result.success) return {};
  const p = result.data;

  // products/update: the payload IS the product resource. Prefer the GID
  // form (unambiguous); fall back to constructing one from the legacy id —
  // safe here because a product's own numeric id is always well within
  // Number's safe-integer range in a real catalogue (unlike inventory_item_id).
  if (p.admin_graphql_api_id && isGidOfType(p.admin_graphql_api_id, "Product")) {
    return { productGid: p.admin_graphql_api_id };
  }
  if (p.id !== undefined) return { productGid: toProductGid(p.id) };
  return {};
}

/**
 * PURE — no I/O, unit-testable with no database or network. Extracts
 * `inventory_item_id` from the RAW webhook body TEXT (never from the
 * already-`JSON.parse`d payload) and returns it as a fully-formed
 * `gid://shopify/InventoryItem/<digits>` string. The digit sequence never
 * passes through a JS number at any point in this function — see the
 * module doc comment for why that is the entire point.
 *
 * Returns `null` when the field is absent or malformed, never throws — same
 * reasoning as `extractShopifyIdentifiers`.
 */
export function extractInventoryItemGidFromRawBody(rawBody: string): string | null {
  const match = /"inventory_item_id"\s*:\s*(\d+)/.exec(rawBody);
  const digits = match?.[1];
  if (!digits) return null;
  return `gid://shopify/InventoryItem/${digits}`;
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
  if (identifiers.inventoryItemGid) {
    // R17 mapping: master_variant.shopifyInventoryItemGid, populated by the
    // backfill (backfillInventoryItemGids.server.ts) from the Admin API's
    // InventoryItem.id. An unpopulated mapping resolves nothing here — see
    // the module doc comment's warning about that looking identical to a
    // correctly-working handler.
    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyInventoryItemGid: identifiers.inventoryItemGid },
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
 * The handler both R17 webhook routes call. Same function regardless of
 * which topic fired — every one of them means the same thing here: "some
 * product's purchasability may have changed; recompute it."
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
  const identifiers: ExtractedShopifyIdentifiers =
    kind === "product"
      ? extractShopifyIdentifiers("product", event.payload)
      : { inventoryItemGid: extractInventoryItemGidFromRawBody(event.rawBody) ?? undefined };

  const resolved = await resolveMasterProduct(identifiers);

  if (!resolved) {
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
