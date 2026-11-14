import type { ActionFunctionArgs } from "react-router";

import { handleFirstAccessSignupWebhook } from "~/shopify/webhooks/firstAccessSignupHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

/**
 * `customers/create` — the trigger for the Launching Soon signup emails.
 *
 * Routed through OUR OWN `receiveShopifyWebhook`, exactly like every other
 * subscription in this app: HMAC verified over the raw body before any
 * parsing, deduplicated on the delivery id, and recorded so a failure is
 * retryable and visible. The Shopify library's `authenticate.webhook` is
 * deliberately not used here either -- see
 * `app/shopify/webhooks/boundaryPreserved.test.ts`.
 *
 * NO NEW SCOPE. `read_customers` has been granted since 2026-09-29 (see the
 * app config's own note on why the warranty and RMA order lookups needed
 * it), and a webhook subscription is not itself a permission.
 *
 * WHY THIS TOPIC RATHER THAN THE SIGNUP FORM'S FETCH is set out at length in
 * `firstAccessSignupHandler.server.ts`. The short version: the form's call
 * skipped every signup without a mobile number, it cannot reach the live
 * COMING SOON theme, and a browser fetch is lost to a closed tab.
 *
 * MOST DELIVERIES ON THIS TOPIC ARE NOT SIGNUPS. Any customer created by any
 * route arrives here; the handler acts only on the `first-access` tag the
 * signup form sets, and returns quietly otherwise.
 *
 * A resource route with NO default export (criterion 57) -- the CSRF guard
 * applies only to modules that have one.
 */
async function handleCustomersCreate(event: ReceivedWebhookEvent): Promise<void> {
  await handleFirstAccessSignupWebhook(event);
}

export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, handleCustomersCreate);
}
