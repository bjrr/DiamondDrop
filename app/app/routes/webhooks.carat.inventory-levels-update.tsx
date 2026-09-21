import type { ActionFunctionArgs } from "react-router";

import { handleInventoryPurchasabilityWebhook } from "~/shopify/webhooks/inventoryPurchasabilityHandler.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * R17 (owner ruling, 2026-09-20, owner exit proof P2) — `inventory_levels/update`,
 * verified LIVE to actually fire for a real out-of-stock/in-stock transition
 * (unlike `variants/out_of_stock`/`variants/in_stock`, which R15 originally
 * chose and which did not deliver under identical live conditions). See
 * `inventoryPurchasabilityHandler.server.ts` for what this does — and, just
 * as importantly, does not do — with the delivered payload, including why
 * `inventory_item_id` is read from the raw body rather than the parsed one.
 *
 * A resource route with NO default export (criterion 57) — see
 * `internal.jobs.price-recalculation.tsx`'s own comment on why.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, (event) => handleInventoryPurchasabilityWebhook("inventory_item", event));
}
