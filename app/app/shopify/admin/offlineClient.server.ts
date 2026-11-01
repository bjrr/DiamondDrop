/**
 * An offline-session Admin API client for a given shop.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHOP COMES FROM THE DELIVERY, NOT FROM THE ENVIRONMENT
 * ---------------------------------------------------------------------------
 * `createProductionPriceSyncPort` reads `SHOPIFY_SHOP_DOMAIN` because a
 * background job has no request to learn the shop from. An event handler does:
 * the delivery carries a signed shop domain, and this app is in fact installed
 * on TWO stores (`nnb1th-cm` and `caratforus-dev`). Syncing a dev-store
 * product change against the production shop's token would read the wrong
 * catalogue and write the wrong rows, so the shop is taken from the delivery
 * that was HMAC-verified rather than from configuration.
 *
 * RETURNS NULL RATHER THAN THROWING when no offline session exists. The caller
 * decides: a webhook handler throws so Shopify retries after a reinstall, a
 * dashboard renders a message. Collapsing both into a throw here would turn a
 * recoverable state into a 500 on a page.
 *
 * The dynamic import mirrors the existing adapters: `~/shopify.server` pulls
 * in the whole app config, and importing it at module load from something a
 * route imports creates a cycle.
 */
import type { AdminGraphqlClient } from "./productClient.server";

/**
 * @param shopDomain e.g. `nnb1th-cm.myshopify.com`, from a verified delivery
 * @returns a client, or null when the app has no offline session for that shop
 */
export async function adminClientForShop(
  shopDomain: string
): Promise<AdminGraphqlClient | null> {
  const trimmed = shopDomain.trim();
  if (trimmed === "") return null;

  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(trimmed);
    return admin as unknown as AdminGraphqlClient;
  } catch {
    // `unauthenticated.admin` throws when OAuth has never completed for the
    // shop. That is a real, recoverable state rather than a bug, so it is
    // reported as "no client" and the caller chooses what it means.
    return null;
  }
}
