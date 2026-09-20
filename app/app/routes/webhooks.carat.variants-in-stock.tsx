import type { ActionFunctionArgs } from "react-router";

import { handleInventoryPurchasabilityWebhook } from "~/shopify/webhooks/inventoryPurchasabilityHandler.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * R15 (owner ruling, 2026-09-20, owner exit proof P2) — `variants/in_stock`,
 * the restoring half of the out-of-stock boundary transition. See
 * `inventoryPurchasabilityHandler.server.ts` for what this does and, just
 * as importantly, does not do with the delivered payload.
 *
 * A resource route with NO default export (criterion 57) — see
 * `internal.jobs.price-recalculation.tsx`'s own comment on why.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, (event) => handleInventoryPurchasabilityWebhook("variant", event));
}
