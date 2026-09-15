import { z } from "zod";

import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { sha256Hex } from "~/domain/evidence/hash";
import type { JsonValue } from "~/domain/evidence";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * Records receipt of one of the three mandatory Shopify GDPR compliance
 * webhooks (customers/data_request, customers/redact, shop/redact) as an
 * audit event (spec §0.6). This is a verified, recorded STUB only — no
 * actual data export or erasure fulfillment happens here, since no
 * customer/order data tables exist in Slice 0. The audit trail created
 * here is what a later slice's real fulfillment work references and is
 * evaluated against.
 *
 * Shopify's three compliance payloads carry raw customer PII — email,
 * phone, name — inside `customer`. `audit_event.after` must never hold
 * that PII:
 * the table is append-only (UPDATE/DELETE/TRUNCATE are blocked by database
 * triggers), so writing PII there would permanently imprint exactly the
 * data a `customers/redact` request is asking us to erase (fixed
 * 2026-09-14, verified finding). Only non-PII routing identifiers plus a
 * hash of the raw body are recorded; the raw body itself already lives in
 * the mutable `webhook_event.rawBody` column, which is not this handler's
 * concern.
 */
const identifierSchema = z.union([z.string(), z.number()]);

const compliancePayloadSchema = z
  .object({
    shop_id: identifierSchema,
    customer: z.object({ id: identifierSchema }).partial(),
    orders_requested: z.array(identifierSchema),
    orders_to_redact: z.array(identifierSchema),
    data_request: z.object({ id: identifierSchema }).partial(),
  })
  .partial()
  .passthrough();

interface ComplianceIdentifiers {
  shopId?: string | number;
  customerId?: string | number;
  orderIds?: (string | number)[];
  dataRequestId?: string | number;
}

/**
 * Extracts only non-PII identifiers from the parsed payload. The three
 * compliance topics have different shapes and any given field may be
 * absent — a field is omitted entirely rather than written as `null`
 * (spec: "omit rather than write null-ish junk"), and an unrecognized
 * shape never throws: HMAC verification already proved this came from
 * Shopify, so an unfamiliar shape means an evolving/unmodeled payload, not
 * an attack, and must not block recording that the webhook was received.
 */
function extractComplianceIdentifiers(payload: unknown): ComplianceIdentifiers {
  const result = compliancePayloadSchema.safeParse(payload);
  if (!result.success) {
    return {};
  }

  const parsed = result.data;
  const identifiers: ComplianceIdentifiers = {};

  if (parsed.shop_id !== undefined) {
    identifiers.shopId = parsed.shop_id;
  }
  if (parsed.customer?.id !== undefined) {
    identifiers.customerId = parsed.customer.id;
  }
  const orderIds = parsed.orders_requested ?? parsed.orders_to_redact;
  if (orderIds !== undefined) {
    identifiers.orderIds = orderIds;
  }
  if (parsed.data_request?.id !== undefined) {
    identifiers.dataRequestId = parsed.data_request.id;
  }

  return identifiers;
}

export async function recordComplianceWebhook(action: string, event: ReceivedWebhookEvent): Promise<void> {
  const identifiers = extractComplianceIdentifiers(event.payload);
  // Hash the raw bytes Shopify actually sent, not the re-serialized parsed
  // payload, so the hash is evidence of what was received rather than of
  // this handler's own (re)serialization.
  const payloadHash = `sha256:${sha256Hex(event.rawBody)}`;

  const after: Record<string, JsonValue> = {
    topic: event.topic,
    payloadHash,
  };
  if (event.shopDomain !== null) {
    after.shopDomain = event.shopDomain;
  }
  if (identifiers.shopId !== undefined) {
    after.shopId = identifiers.shopId;
  }
  if (identifiers.customerId !== undefined) {
    after.customerId = identifiers.customerId;
  }
  if (identifiers.orderIds !== undefined) {
    after.orderIds = identifiers.orderIds;
  }
  if (identifiers.dataRequestId !== undefined) {
    after.dataRequestId = identifiers.dataRequestId;
  }

  await createAuditEvent({
    actorType: "system",
    actorRef: "shopify-webhook",
    action,
    entityType: "shopify_compliance_request",
    entityId: event.shopifyEventId,
    after,
    reason: "Mandatory Shopify GDPR compliance webhook",
  });
}
