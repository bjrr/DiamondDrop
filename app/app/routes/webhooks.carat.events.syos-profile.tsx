import type { ActionFunctionArgs } from "react-router";

import { handleSyosProfileEvent } from "~/shopify/webhooks/syosEventHandlers.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * POST /webhooks/carat/events/syos-profile
 *
 * Shopify Events, `Metaobject` topic, 2026-10, scoped to
 * `$app:syos_center_size_profile`.
 *
 * THE DELIVERY THAT PREVENTS A FALSE MATCH. A merchant can edit
 * "Pear 10 x 7 mm" from 10.0 to 10.5 without touching any product: the option
 * value still points at the same metaobject, so no Product event fires and
 * nothing in the product graph changed. Without this route the derived index
 * would keep classifying customers' stones against dimensions that no longer
 * exist -- a wrong compatibility answer, not a stale label.
 *
 * Requires `read_metaobjects`. No default export, for the same CSRF reason as
 * the product route.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleSyosProfileEvent);
}
