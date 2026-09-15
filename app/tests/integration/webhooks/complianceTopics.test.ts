import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { sha256Hex } from "~/domain/evidence/hash";
import { getEnv } from "~/lib/env.server";
import { action as customersDataRequestAction } from "~/routes/webhooks.customers.data_request";
import { action as customersRedactAction } from "~/routes/webhooks.customers.redact";
import { action as shopRedactAction } from "~/routes/webhooks.shop.redact";
import {
  SHOPIFY_EVENT_ID_HEADER,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_DOMAIN_HEADER,
  SHOPIFY_TOPIC_HEADER,
} from "~/shopify/webhooks/headers";

import fixture from "../../fixtures/webhooks/customers-data-request.sample.json";

const BODY = JSON.stringify(fixture);

// The two values that must never survive into the append-only audit trail.
const FIXTURE_EMAIL = fixture.customer.email;
const FIXTURE_PHONE = fixture.customer.phone;

function signedRequest(topic: string, eventId: string, secret: string): Request {
  const hmac = createHmac("sha256", secret).update(BODY, "utf8").digest("base64");
  return new Request(`https://example.com/webhooks/${topic}`, {
    method: "POST",
    headers: {
      [SHOPIFY_HMAC_HEADER]: hmac,
      [SHOPIFY_TOPIC_HEADER]: topic,
      [SHOPIFY_SHOP_DOMAIN_HEADER]: fixture.shop_domain,
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
    const auditEvent = auditEvents[0]!;
    expect(auditEvent.action).toBe(expectedAction);
    expect(auditEvent.reason).toBe("Mandatory Shopify GDPR compliance webhook");

    // Finding 1 regression: `after` must carry only the approved non-PII
    // routing identifiers plus a hash of the raw body — never the
    // customer's email/phone or the raw payload. `audit_event` is
    // append-only (no UPDATE/DELETE/TRUNCATE), so PII written here could
    // never be erased even by the customers/redact request that is asking
    // us to do exactly that.
    const after = auditEvent.after as Record<string, unknown>;
    expect(after.topic).toBe(topic);
    expect(after.shopDomain).toBe(fixture.shop_domain);
    expect(after.shopId).toBe(fixture.shop_id);
    expect(after.customerId).toBe(fixture.customer.id);
    expect(after.dataRequestId).toBe(fixture.data_request.id);
    expect(after.orderIds).toEqual(fixture.orders_requested);
    expect(after.payloadHash).toBe(`sha256:${sha256Hex(BODY)}`);

    // Prove the property, not just the shape: nothing in the whole stored
    // row — serialized in full, not just the fields asserted above —
    // contains the fixture's email or phone. This still fails if someone
    // later re-adds the raw payload under a different key or reintroduces
    // it via `before` instead of `after`.
    const serializedRow = JSON.stringify(auditEvent);
    expect(serializedRow).not.toContain(FIXTURE_EMAIL);
    expect(serializedRow).not.toContain(FIXTURE_PHONE);
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
