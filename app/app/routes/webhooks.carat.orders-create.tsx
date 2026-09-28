import type { ActionFunctionArgs } from "react-router";

import { handleGroupBuyOrderCreateWebhook } from "~/shopify/webhooks/groupBuyOrderHandler.server";
import { handleLuxuryStealOrderCreateWebhook } from "~/shopify/webhooks/luxuryStealOrderHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * Slice 3 task 3-4 (D6, criteria 137-140, docs/specs/SLICE-3-LUXURY-STEALS.md
 * §4.4) — `orders/create`, the only enforcement that actually binds a Luxury
 * Steal's Final Sale acknowledgment to the order that shipped it. See
 * `luxuryStealOrderHandler.server.ts` for what this does — and, just as
 * importantly, does not do — with the delivered payload.
 *
 * Group Buy participation joined here (docs/ARCHITECTURE-MVP1.md §6.2) — the
 * only other consumer of a placed order on this topic. See
 * `groupBuyOrderHandler.server.ts` for what it records and why counting a
 * pending Bank Payment order immediately is correct, not an oversight.
 *
 * BOTH HANDLERS RUN, INDEPENDENTLY, ON EVERY DELIVERY. Each is idempotent
 * under redelivery by construction (their own module comments explain how),
 * so re-running one because the OTHER failed on this delivery is safe and
 * is exactly what should happen: a Luxury Steal order should still be
 * tagged/held even if this order's Group Buy tier sync failed to reach
 * Shopify, and a Group Buy unit should still be recorded even if the Luxury
 * Steal acknowledgment check failed. Failures from both are collected and
 * reported together; if either failed, the whole delivery is marked failed
 * (5xx) so Shopify redelivers and each handler's own idempotency resolves
 * what is actually still incomplete rather than repeating what already
 * succeeded.
 *
 * A resource route with NO default export (criterion 57) — see
 * `internal.jobs.price-recalculation.tsx`'s own comment on why.
 */
async function handleOrdersCreate(event: ReceivedWebhookEvent): Promise<void> {
  const failures: string[] = [];

  try {
    await handleLuxuryStealOrderCreateWebhook(event);
  } catch (error) {
    failures.push(`luxury_steal: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await handleGroupBuyOrderCreateWebhook(event);
  } catch (error) {
    failures.push(`group_buy: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`orders/create processing incomplete: ${failures.join(" | ")}`);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleOrdersCreate);
}
