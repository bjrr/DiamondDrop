import type { ActionFunctionArgs } from "react-router";

import { handleLuxuryStealOrderCreateWebhook } from "~/shopify/webhooks/luxuryStealOrderHandler.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * Slice 3 task 3-4 (D6, criteria 137-140, docs/specs/SLICE-3-LUXURY-STEALS.md
 * §4.4) — `orders/create`, the only enforcement that actually binds a Luxury
 * Steal's Final Sale acknowledgment to the order that shipped it. See
 * `luxuryStealOrderHandler.server.ts` for what this does — and, just as
 * importantly, does not do — with the delivered payload.
 *
 * A resource route with NO default export (criterion 57) — see
 * `internal.jobs.price-recalculation.tsx`'s own comment on why.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleLuxuryStealOrderCreateWebhook);
}
