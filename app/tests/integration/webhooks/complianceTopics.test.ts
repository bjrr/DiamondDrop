import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { getEnv } from "~/lib/env.server";
import { action as customersDataRequestAction } from "~/routes/webhooks.customers.data_request";
import { action as customersRedactAction } from "~/routes/webhooks.customers.redact";
import { action as shopRedactAction } from "~/routes/webhooks.shop.redact";
import { SHOPIFY_EVENT_ID_HEADER, SHOPIFY_HMAC_HEADER, SHOPIFY_TOPIC_HEADER } from "~/shopify/webhooks/headers";

import fixture from "../../fixtures/webhooks/customers-data-request.sample.json";

const BODY = JSON.stringify(fixture);

function signedRequest(topic: string, eventId: string, secret: string): Request {
  const hmac = createHmac("sha256", secret).update(BODY, "utf8").digest("base64");
  return new Request(`https://example.com/webhooks/${topic}`, {
    method: "POST",
    headers: {
      [SHOPIFY_HMAC_HEADER]: hmac,
      [SHOPIFY_TOPIC_HEADER]: topic,
      [SHOPIFY_EVENT_ID_HEADER]: eventId,
    },
    body: BODY,
  });
}

// Acceptance criterion 15: the three mandatory compliance topics verify,
// record, audit, and acknowledge correctly.
describe.each([
  ["customers/data_request", customersDataRequestAction, "compliance.customers_data_request"],
  ["customers/redact", customersRedactAction, "compliance.customers_redact"],
  ["shop/redact", shopRedactAction, "compliance.shop_redact"],
] as const)("compliance webhook: %s", (topic, action, expectedAction) => {
  it("verifies, records, audits, and acknowledges with 200", async () => {
    const { SHOPIFY_API_SECRET } = getEnv();
    const eventId = randomUUID();

    const response = await action({
      request: signedRequest(topic, eventId, SHOPIFY_API_SECRET),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(200);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityType: "shopify_compliance_request", entityId: eventId },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe(expectedAction);
    expect(auditEvents[0]?.reason).toBe("Mandatory Shopify GDPR compliance webhook");
  });

  it("rejects an invalid signature with 401 and writes no audit event", async () => {
    const eventId = randomUUID();

    const response = await action({
      request: signedRequest(topic, eventId, "wrong-secret-entirely"),
      params: {},
      context: {},
    } as any);

    expect(response.status).toBe(401);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityType: "shopify_compliance_request", entityId: eventId },
    });
    expect(auditEvents).toHaveLength(0);
  });
});
