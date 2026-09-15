import type { ActionFunctionArgs } from "@remix-run/node";

import { recordComplianceWebhook } from "~/shopify/webhooks/complianceHandlers.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

// Mandatory Shopify compliance topic: shop/redact.
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, (event) => recordComplianceWebhook("compliance.shop_redact", event));
}
