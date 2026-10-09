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
  // A FACTORY, NOT A CLIENT. The handler calls this only once it knows the
  // order is a Design Deposit with an invoice to verify — see
  // `CustomJewelryDepositPaymentDeps`. Building it here instead made every
  // Buy Now and Group Buy order depend on a session lookup it never needed; a
  // live test delivery for an unknown shop returned 500 and asked Shopify to
  // redeliver an order the handler would have ignored.
  //
  // The shop is checked INSIDE the factory for the same reason: a delivery
  // with no shop domain is only a problem if we actually needed an Admin
  // client, and failing on it up front would again punish orders that are
  // none of our business.
  await handleCustomJewelryDepositOrderPaidWebhook(event, {
    adminGraphql: async () => {
      if (!event.shopDomain) {
        throw new Error("orders/paid delivery carried no shop domain — cannot resolve an Admin client to verify against");
      }
      const { admin } = await unauthenticated.admin(event.shopDomain);
      return admin;
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleOrdersPaid);
}
