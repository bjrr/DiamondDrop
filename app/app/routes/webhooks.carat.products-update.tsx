import type { ActionFunctionArgs } from "react-router";

import { handleInventoryPurchasabilityWebhook } from "~/shopify/webhooks/inventoryPurchasabilityHandler.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * R15 (owner ruling, 2026-09-20, owner exit proof P2) — `products/update`,
 * one of three topics whose delivery invalidates a product's "as low as"
 * cache. See `inventoryPurchasabilityHandler.server.ts` for what this does
 * and, just as importantly, does not do with the delivered payload.
 *
 * A resource route with NO default export (criterion 57) — see
 * `internal.jobs.price-recalculation.tsx`'s own comment on why: a default
 * export subjects the route to `throwIfPotentialCSRFAttack`, which rejects
 * an Origin-less delivery like this one before any of our code runs.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, (event) => handleInventoryPurchasabilityWebhook("product", event));
}
