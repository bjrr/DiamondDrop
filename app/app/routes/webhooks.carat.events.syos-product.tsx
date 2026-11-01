import type { ActionFunctionArgs } from "react-router";

import { handleSyosProductEvent } from "~/shopify/webhooks/syosEventHandlers.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * POST /webhooks/carat/events/syos-product
 *
 * Shopify Events, `Product` topic, 2026-10. Delivered when a SYOS product
 * metafield, a variant metafield in the `carat` namespace, the product status,
 * its variants or its options change.
 *
 * A RESOURCE ROUTE WITH NO DEFAULT EXPORT, deliberately, exactly like
 * `webhooks.carat.products-update.tsx`. A default export subjects the route to
 * `throwIfPotentialCSRFAttack`, which rejects an Origin-less delivery like this
 * one before any of our code runs. The `csrfResourceRouteFence` test enforces
 * the absence.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleSyosProductEvent);
}
