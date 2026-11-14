import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { adminClientForShop } from "~/shopify/admin/offlineClient.server";

/**
 * Registers the `customers/create` webhook that the Launching Soon signup
 * emails depend on.
 *
 * ===========================================================================
 * WHY THIS EXISTS AS A JOB RATHER THAN A CONFIG LINE
 * ===========================================================================
 * The topic belongs in `shopify.app.caratforus-development.toml` alongside
 * the other four, and it has been added there. But that file has never been
 * pushed: its own header records that `shopify app deploy` has deliberately
 * not been run, and running it now would also push the access scopes (which
 * re-prompts OAuth on a live store), the App Proxy URL and the SYOS
 * metaobject definitions. That is a large, surprising change to production
 * to register one webhook.
 *
 * The Shopify CLI cannot do it either: `shopify app execute` refuses
 * mutations against a non-development store.
 *
 * So the subscription is created through the app's OWN offline session,
 * which is also the only way to get it right. A subscription created by any
 * other app -- including an MCP connector -- is signed with THAT app's
 * secret, and `receiveShopifyWebhook` verifies against ours. It would be
 * registered, it would deliver, and every delivery would 401.
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ===========================================================================
 * Production currently has NO webhook subscriptions registered for this app
 * at all -- `orders/create`, `orders/paid`, `products/update` and
 * `inventory_levels/update` are all declared in config and none of them is
 * live. That is a real pre-launch finding and it is reported, not silently
 * fixed here: registering `orders/create` would immediately start placing
 * fulfilment holds on Luxury Steals orders and counting Group Buy units.
 * Those are money- and fulfilment-affecting behaviours and switching them on
 * is an owner decision, not a side effect of shipping a signup email.
 *
 * IDEMPOTENT. It looks for an existing subscription on this topic pointing
 * at this URL and creates one only if absent, so running it twice is a
 * no-op and re-running after a deploy is safe.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

const TOPIC = "CUSTOMERS_CREATE";

/** Must match the route that handles it. */
function callbackUrlFor(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/webhooks/carat/customers-create`;
}

const LIST_QUERY = `#graphql
  query ExistingCustomerWebhooks {
    webhookSubscriptions(first: 50, topics: [CUSTOMERS_CREATE]) {
      nodes { id topic uri }
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation RegisterCustomersCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (!isAuthorised(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  const { SHOPIFY_SHOP_DOMAIN, SHOPIFY_APP_URL } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_APP_URL) {
    return Response.json(
      { error: "missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_APP_URL" },
      { status: 500 }
    );
  }

  const admin = await adminClientForShop(SHOPIFY_SHOP_DOMAIN);
  if (!admin) {
    return Response.json({ error: "no_offline_session" }, { status: 503 });
  }

  const callbackUrl = callbackUrlFor(SHOPIFY_APP_URL);

  const listed = await admin.graphql(LIST_QUERY);
  const listedJson = (await listed.json()) as {
    data?: { webhookSubscriptions?: { nodes?: { id: string; topic: string; uri: string }[] } };
  };
  const existing = listedJson.data?.webhookSubscriptions?.nodes ?? [];
  const already = existing.find((node) => node.uri === callbackUrl);

  if (already) {
    logger.info("webhook.signup_subscription_present", { id: already.id });
    return Response.json({ created: false, alreadyPresent: true, id: already.id, uri: callbackUrl });
  }

  const created = await admin.graphql(CREATE_MUTATION, {
    variables: { topic: TOPIC, sub: { callbackUrl, format: "JSON" } },
  });
  const createdJson = (await created.json()) as {
    data?: {
      webhookSubscriptionCreate?: {
        webhookSubscription?: { id: string; topic: string; uri: string } | null;
        userErrors?: { field?: string[] | null; message: string }[];
      };
    };
  };

  const result = createdJson.data?.webhookSubscriptionCreate;
  const errors = result?.userErrors ?? [];
  if (errors.length > 0 || !result?.webhookSubscription) {
    logger.error("webhook.signup_subscription_failed", { errors: errors.length });
    return Response.json(
      { created: false, errors: errors.map((e) => e.message) },
      { status: 502 }
    );
  }

  logger.info("webhook.signup_subscription_created", { id: result.webhookSubscription.id });
  return Response.json({
    created: true,
    id: result.webhookSubscription.id,
    topic: result.webhookSubscription.topic,
    uri: result.webhookSubscription.uri,
  });
}

function isAuthorised(request: Request): boolean {
  const presented = request.headers.get(CRON_SECRET_HEADER);
  if (presented === null) return false;

  const { CRON_SECRET } = getEnv();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(CRON_SECRET, "utf8");

  // Length first: `timingSafeEqual` throws on a mismatch, and that exception
  // path would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
