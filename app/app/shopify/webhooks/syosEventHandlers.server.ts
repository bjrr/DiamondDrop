/**
 * Set Your Own Stone event handlers.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5; owner direction
 * 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * THE PAYLOAD IS A TRIGGER, NOT A DATA SOURCE
 * ---------------------------------------------------------------------------
 * Both handlers take one id out of the delivery and then RE-READ everything
 * from Shopify through the shared sync service. The custom `query` on each
 * subscription returns plenty of usable-looking data, and using it would be
 * faster — and wrong. A delivery can be replayed, delayed, or arrive after a
 * later edit, so writing dimensions from a payload means writing whatever
 * Shopify's state was at an arbitrary past moment. Re-reading means the index
 * converges on Shopify's *current* state regardless of delivery order, which
 * is the only behaviour that is safe for a fit decision.
 *
 * It also means event-derived and reconciliation-derived state agree by
 * construction, because they are the same code path with different triggers.
 *
 * ---------------------------------------------------------------------------
 * NO MATCHING LOGIC HERE
 * ---------------------------------------------------------------------------
 * Not one rule about shapes, tolerances or vendor ranges. That all lives in
 * the projection layer, where it is unit tested. The owner's instruction, and
 * the reason the two sync routes cannot drift apart.
 */
import { syncProduct, syncProductsUsingProfile } from "~/jobs/setyourownstone/syncCompatibility.server";
import { logger } from "~/lib/logger.server";
import { adminClientForShop } from "~/shopify/admin/offlineClient.server";
import { SYOS_PROFILE_TYPE } from "~/shopify/metafields/syosCompatibilityDefinitions";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/** The shape Shopify Events deliver. Deliberately permissive: a missing or
 *  renamed field must produce a recorded no-op, not a thrown handler that
 *  Shopify then retries forever. */
interface EventPayload {
  topic?: string;
  action?: string;
  data?: {
    product?: { id?: string } | null;
    metaobject?: { id?: string; type?: string } | null;
  } | null;
  fields_changed?: {
    added?: string[];
    updated?: string[];
    removed?: string[];
  } | null;
}

function parse(event: ReceivedWebhookEvent): EventPayload {
  return (event.payload ?? {}) as EventPayload;
}

/** Every changed-field path in one list, for logging what actually moved. */
function changedFields(payload: EventPayload): string[] {
  const c = payload.fields_changed;
  return [...(c?.added ?? []), ...(c?.updated ?? []), ...(c?.removed ?? [])];
}

/**
 * Product topic: a mounting changed.
 *
 * Covers product status, `carat` product metafields, `carat` variant
 * metafields, variant add/remove and option changes — all of which can alter
 * what the matcher should offer.
 */
export async function handleSyosProductEvent(event: ReceivedWebhookEvent): Promise<void> {
  const payload = parse(event);
  const productGid = payload.data?.product?.id ?? null;

  if (!productGid) {
    // Nothing to act on. Logged and accepted: returning without throwing
    // means `receiveShopifyWebhook` marks the delivery processed, which is
    // correct — retrying will not conjure a product id.
    logger.warn("syos_event.product_without_id", {
      shopifyEventId: event.shopifyEventId,
      action: payload.action,
    });
    return;
  }

  if (!event.shopDomain) {
    logger.warn("syos_event.product_without_shop", { shopifyEventId: event.shopifyEventId });
    return;
  }

  const client = await adminClientForShop(event.shopDomain);
  if (!client) {
    // No stored offline session for this shop. Thrown, not swallowed: this is
    // a condition a retry can genuinely resolve (a reinstall), and silently
    // accepting it would drop a real compatibility change.
    throw new Error(`no offline Shopify session for ${event.shopDomain}`);
  }

  logger.info("syos_event.product_received", {
    shopifyEventId: event.shopifyEventId,
    productGid,
    action: payload.action,
    changed: changedFields(payload).slice(0, 10),
  });

  await syncProduct(client, productGid);
}

/**
 * Metaobject topic: a shared centre-size profile changed.
 *
 * The important one. Re-syncs every mounting configuration recorded as using
 * this profile, found through the reverse index on the compatibility rows,
 * because no product was touched and nothing in the product graph changed.
 *
 * HISTORICAL SNAPSHOTS ARE NOT IN SCOPE HERE AND CANNOT BE. Nothing in this
 * path writes `StoneSession`, and the database refuses an update to a
 * populated `matchedSnapshot` regardless — a resync "correcting" the record of
 * what a customer was shown would destroy exactly the evidence worth keeping.
 */
export async function handleSyosProfileEvent(event: ReceivedWebhookEvent): Promise<void> {
  const payload = parse(event);
  const metaobject = payload.data?.metaobject ?? null;
  const profileId = metaobject?.id ?? null;

  if (!profileId) {
    logger.warn("syos_event.profile_without_id", {
      shopifyEventId: event.shopifyEventId,
      action: payload.action,
    });
    return;
  }

  // The subscription is already type-scoped, so a different type arriving
  // means something is misconfigured upstream. Refused rather than acted on:
  // re-projecting against a metaobject that is not a size profile would write
  // nonsense dimensions.
  if (metaobject?.type && metaobject.type !== SYOS_PROFILE_TYPE) {
    logger.warn("syos_event.profile_wrong_type", {
      shopifyEventId: event.shopifyEventId,
      type: metaobject.type,
    });
    return;
  }

  if (!event.shopDomain) {
    logger.warn("syos_event.profile_without_shop", { shopifyEventId: event.shopifyEventId });
    return;
  }

  const client = await adminClientForShop(event.shopDomain);
  if (!client) {
    throw new Error(`no offline Shopify session for ${event.shopDomain}`);
  }

  logger.info("syos_event.profile_received", {
    shopifyEventId: event.shopifyEventId,
    profileId,
    action: payload.action,
    changed: changedFields(payload).slice(0, 10),
  });

  const outcomes = await syncProductsUsingProfile(client, profileId);

  if (outcomes.length === 0) {
    // A brand-new profile, or one no mounting references yet. Normal, and
    // worth logging so "the event fired but nothing changed" is explicable
    // rather than looking like a dropped delivery.
    logger.info("syos_event.profile_unreferenced", { profileId });
  }
}
