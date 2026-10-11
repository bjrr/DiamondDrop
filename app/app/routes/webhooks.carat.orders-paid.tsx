import type { ActionFunctionArgs } from "react-router";

import { logger } from "~/lib/logger.server";
import { handleBeatQuoteRedemptionOrderPaidWebhook } from "~/shopify/webhooks/beatQuoteRedemptionOrderHandler.server";
import { handleCustomJewelryDepositOrderPaidWebhook } from "~/shopify/webhooks/customJewelryDepositPaymentHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";
import { unauthenticated } from "~/shopify.server";

/**
 * `orders/paid` — Slice 9's Design Deposit collection.
 *
 * A SEPARATE TOPIC FROM `orders/create`, DELIBERATELY. A deposit invoice is
 * paid through Shopify's own checkout, so the order exists before the money
 * does; `orders/create` would fire while it was still unpaid and tell us
 * nothing we could act on. `orders/paid` fires when the money is actually
 * there, which is the only moment that justifies advancing a project to
 * `deposit_charged`.
 *
 * TWO HANDLERS NOW, so this file adopts the shape its own earlier comment said
 * to adopt when a second consumer appeared: each handler runs independently,
 * both failures are collected, and the delivery fails if either did. That is
 * right precisely because the handlers are independently idempotent — Slice
 * 9's deposit advance and Slice 10's redemption verification share nothing but
 * the topic, and a deposit failure must not stop a redemption from being
 * verified (or vice versa) on the same delivery.
 *
 * Shopify redelivers the WHOLE delivery, not the failed half, which is why
 * independent idempotency is the precondition rather than a nicety: the
 * succeeded handler will run again and must do nothing the second time.
 *
 * A resource route with NO default export — `allowedActionOrigins` is `[]` in
 * production builds, and `csrfResourceRouteFence.test.ts` enforces it for
 * every `webhooks.` route.
 *
 * AUTHENTICITY IS NOT THIS FILE'S JOB. `receiveShopifyWebhook` verifies the
 * HMAC and records the event for idempotency before the handler is ever
 * called.
 *
 * WHY THIS NEEDS AN ADMIN CLIENT. The handler does not trust the order's tags
 * to decide which invoice was paid — tags are editable by any Shopify admin
 * user. It asks Shopify which order the invoice's draft order actually became.
 * `unauthenticated.admin` is the right source here precisely because a webhook
 * has no user session; the shop domain comes from the verified delivery.
 */
async function handleOrdersPaid(event: ReceivedWebhookEvent): Promise<void> {
  // A FACTORY, NOT A CLIENT, shared by both handlers. Each calls it only once
  // it knows the order is actually its business — a Design Deposit with an
  // invoice to verify, or an order carrying a redemption tag. Building the
  // client here instead made every Buy Now and Group Buy order depend on a
  // session lookup it never needed; a live test delivery for an unknown shop
  // returned 500 and asked Shopify to redeliver an order the handler would
  // have ignored.
  //
  // The shop is checked INSIDE the factory for the same reason: a delivery
  // with no shop domain is only a problem if we actually needed an Admin
  // client, and failing on it up front would again punish orders that are
  // none of our business.
  const adminGraphql = async () => {
    if (!event.shopDomain) {
      throw new Error("orders/paid delivery carried no shop domain — cannot resolve an Admin client to verify against");
    }
    const { admin } = await unauthenticated.admin(event.shopDomain);
    return admin;
  };

  const failures: { handler: string; error: unknown }[] = [];

  // SEQUENTIAL, NOT `Promise.all`. Both handlers write, and running them
  // concurrently against one delivery buys nothing — a webhook has no latency
  // budget worth that — while making a deadlock between two transactions
  // possible on an order that is somehow both.
  for (const [handler, run] of [
    ["custom_jewelry_deposit", () => handleCustomJewelryDepositOrderPaidWebhook(event, { adminGraphql })],
    ["beat_quote_redemption", () => handleBeatQuoteRedemptionOrderPaidWebhook(event, { adminGraphql })],
  ] as const) {
    try {
      await run();
    } catch (error) {
      failures.push({ handler, error });
    }
  }

  if (failures.length > 0) {
    // Every failure is named, not only the first: a redelivery triggered by one
    // handler must not hide that the other failed too.
    for (const { handler, error } of failures) {
      logger.error("orders_paid.handler_failed", {
        handler,
        shopifyEventId: event.shopifyEventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw new AggregateError(
      failures.map(({ error }) => (error instanceof Error ? error : new Error(String(error)))),
      `orders/paid: ${failures.map((f) => f.handler).join(", ")} failed`
    );
  }
}

export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleOrdersPaid);
}
