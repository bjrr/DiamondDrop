import type { ActionFunctionArgs } from "react-router";

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
 * ONE HANDLER TODAY, and the shape still accommodates more. `orders/create`
 * runs two handlers independently, collects both failures and fails the whole
 * delivery if either did — see its own comment for why that is right when
 * handlers are independently idempotent. That structure is not reproduced here
 * for a single handler, because a `failures` array with one possible entry is
 * ceremony. If a second consumer of this topic appears, adopt that shape
 * rather than nesting try/catch.
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
  if (!event.shopDomain) {
    // Without a shop there is no Admin client to verify against, and the
    // handler's authoritative check cannot run. Thrown rather than skipped: a
    // verified delivery should always carry one, so this is a real anomaly and
    // a redelivery may well carry it.
    throw new Error("orders/paid delivery carried no shop domain — cannot resolve an Admin client to verify against");
  }

  const { admin } = await unauthenticated.admin(event.shopDomain);
  await handleCustomJewelryDepositOrderPaidWebhook(event, { adminGraphql: admin });
}

export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleOrdersPaid);
}
