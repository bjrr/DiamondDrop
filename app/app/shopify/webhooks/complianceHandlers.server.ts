import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import type { JsonValue } from "~/domain/evidence";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * Records receipt of one of the three mandatory Shopify GDPR compliance
 * webhooks (customers/data_request, customers/redact, shop/redact) as an
 * audit event (spec §0.6). This is a verified, recorded STUB only — no
 * actual data export/erasure fulfillment logic exists yet, since no
 * customer/order data tables exist in Slice 0. The audit trail created
 * here is what a later slice's real fulfillment work references and is
 * evaluated against.
 */
export async function recordComplianceWebhook(action: string, event: ReceivedWebhookEvent): Promise<void> {
  await createAuditEvent({
    actorType: "system",
    actorRef: "shopify-webhook",
    action,
    entityType: "shopify_compliance_request",
    entityId: event.shopifyEventId,
    after: {
      topic: event.topic,
      shopDomain: event.shopDomain,
      payload: event.payload as JsonValue,
    },
    reason: "Mandatory Shopify GDPR compliance webhook",
  });
}
