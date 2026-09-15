import type { ActionFunctionArgs } from "react-router";

import { recordComplianceWebhook } from "~/shopify/webhooks/complianceHandlers.server";
import { receiveShopifyWebhook } from "~/shopify/webhooks/receive.server";

// Mandatory Shopify compliance topic: customers/data_request.
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, (event) =>
    recordComplianceWebhook("compliance.customers_data_request", event)
  );
}
