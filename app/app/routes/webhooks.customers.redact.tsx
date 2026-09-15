import type { ActionFunctionArgs } from "react-router";

import { recordComplianceWebhook } from "~/shopify/webhooks/complianceHandlers.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

// Mandatory Shopify compliance topic: customers/redact.
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, (event) =>
    recordComplianceWebhook("compliance.customers_redact", event)
  );
}
