import { z } from "zod";

import { prisma } from "~/db/client.server";
import { getAcknowledgmentById } from "~/db/repositories/acknowledgmentRepository.server";
import { isMasterVariantLuxurySteal, recordLuxuryStealOrderCheck } from "~/db/repositories/luxuryStealRepository.server";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import { resolveEmailPort as defaultResolveEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { logger } from "~/lib/logger.server";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * `orders/create` verification — the enforcement that actually binds (D6,
 * criteria 137-140, docs/specs/SLICE-3-LUXURY-STEALS.md §4.4, task 3-4).
 *
 * WHY THIS EXISTS AT ALL. D6 ships no Cart/Checkout Validation Function for
 * MVP1. Nothing inside Shopify's own checkout can refuse an un-acknowledged
 * Luxury Steal line, so a customer who POSTs directly to `/cart/add` reaches
 * checkout regardless of what the storefront gate (task 3-5) does. This
 * handler is therefore not a consistency check — it is the only thing that
 * can still catch a bypass, after the fact, before the order is fulfilled.
 *
 * CRITERION 150 / 127 — POSTGRES ONLY. Every Luxury Steal determination below
 * goes through `isMasterVariantLuxurySteal`, task 3-1's direct read of
 * `master_variant.is_luxury_steal`. Nothing here reads a metafield, a tag, a
 * line item property, or any other client-supplied flag to decide whether a
 * line NEEDS verification — only to decide whether one PASSES it.
 *
 * THE ACKNOWLEDGMENT PROPERTY IS A LOOKUP KEY, NOT PROOF. Task 3-5 attaches
 * the `Acknowledgment` id task 3-3's capture endpoint returned to the cart
 * line as a line item property named `_carat_ls_ack` (leading underscore —
 * Shopify hides `_`-prefixed properties from the customer-visible cart/
 * checkout/order confirmation while still persisting them on the order line).
 * That value is client-supplied and tamperable: a customer (or a bypassed
 * storefront) could copy ANY valid acknowledgment id from anywhere. So a
 * match requires two things, not one — (1) the id resolves to a real,
 * stored `Acknowledgment` row, AND (2) that row's own `variantRef` (the
 * Shopify variant gid it was captured against — see
 * `apps.carat.luxury-acknowledgment.tsx`) equals THIS line's variant. An id
 * that resolves to nothing, or resolves to a different variant's
 * acknowledgment, is `unmatched` — the tamper case task 3-4's assigning
 * message calls out as the one that matters most.
 *
 * 64-BIT IDS, AGAIN (R14/R17's hazard, at the order-line grain this time).
 * `line_items[].variant_id` and `.id` are Shopify's usual int64 identifiers.
 * `receive.server.ts` has already run `event.rawBody` through `JSON.parse`
 * once (to build `event.payload`) before this handler is ever called, which
 * proves the body is syntactically valid JSON — but that parse is exactly
 * as lossy for a >2^53 field as it always is, so `event.payload` is never
 * read here. Instead `preserveShopifyBigIntIds` rewrites the handful of
 * known id-bearing keys (`id`, `variant_id`, `product_id`, `order_id`) from
 * bare numeric JSON tokens to quoted strings BEFORE this module's own
 * `JSON.parse`, so every id downstream is a digit-for-digit-exact string
 * from the moment it exists as a JS value at all — never a `number` at any
 * point. This is the multi-field generalization of
 * `extractInventoryItemGidFromRawBody`'s single-field regex approach in
 * `inventoryPurchasabilityHandler.server.ts`; a whole `line_items` array of
 * objects cannot be pulled out of raw text with one targeted regex the way a
 * single scalar field can, so the rewrite runs across the whole body and the
 * result is parsed normally.
 *
 * WHAT THIS HANDLER NEVER DOES. It never cancels an order, never blocks
 * fulfillment through a Shopify API call (no fulfillment-hold scope is
 * requested — that is an owner decision the assigning message raised
 * separately), and never treats an unmatched line as a reason to throw. The
 * hold IS the evidence row (`luxury_steal_order_check`, outcome `unmatched`)
 * plus a best-effort admin notification — see `notifyLuxuryStealOrderHeld`'s
 * own doc comment for why this does not go through the schema-closed
 * `AdminAlertNotification` table the price-failure alerts use.
 */

const ACKNOWLEDGMENT_PROPERTY_NAME = "_carat_ls_ack";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact set of Shopify order-webhook keys known to carry an int64 identifier as a bare JSON number. Deliberately narrow — see the module doc comment. */
const ID_LIKE_KEY_PATTERN = /"(id|variant_id|product_id|order_id|line_item_id)"(\s*):(\s*)(-?\d+)(?=[,}\s])/g;

/**
 * PURE — no I/O. Rewrites bare-numeric values of known id-bearing keys to
 * quoted strings, preserving JSON validity (quoting a number is always still
 * valid JSON) and exact digit sequence (never routes through a JS number).
 * Only matches a value that is NOT already quoted, so it cannot double-quote
 * a field Shopify already sends as a string (e.g. `admin_graphql_api_id`).
 */
export function preserveShopifyBigIntIds(rawBody: string): string {
  return rawBody.replace(ID_LIKE_KEY_PATTERN, (_match, key, sp1, sp2, digits) => `"${key}"${sp1}:${sp2}"${digits}"`);
}

const orderLinePropertySchema = z
  .object({
    name: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  })
  .passthrough();

const orderLineItemSchema = z
  .object({
    id: z.string(),
    admin_graphql_api_id: z.string().optional(),
    /** Absent/null for a custom (manual, non-catalog) line item — never a Luxury Steal, since it has no variant to check. */
    variant_id: z.string().nullable().optional(),
    properties: z.array(orderLinePropertySchema).optional(),
  })
  .passthrough();

const orderPayloadSchema = z
  .object({
    id: z.string().optional(),
    admin_graphql_api_id: z.string().optional(),
    line_items: z.array(orderLineItemSchema).optional(),
  })
  .passthrough();

export type OrderPayload = z.infer<typeof orderPayloadSchema>;
export type OrderLineItem = z.infer<typeof orderLineItemSchema>;

/**
 * PURE — no I/O. Re-derives the order payload from the RAW body, never from
 * `event.payload` (see module doc comment). Throws (SyntaxError from
 * `JSON.parse`, or `ZodError` from schema validation) on a body that does not
 * match Shopify's documented `orders/create` resource shape — deliberately
 * NOT swallowed, unlike an unresolved-but-well-formed identifier elsewhere in
 * this module. A genuinely malformed delivery from Shopify itself would be
 * abnormal on this topic; the exception propagates to `receiveShopifyWebhook`,
 * which records it on the `webhook_event` row and 500s for retry — an
 * existing, already-audited failure path, rather than a second one invented
 * here.
 */
export function parseOrderPayload(rawBody: string): OrderPayload {
  const doctored = preserveShopifyBigIntIds(rawBody);
  const json: unknown = JSON.parse(doctored);
  return orderPayloadSchema.parse(json);
}

/** PURE. Prefers the GID Shopify already sends; falls back to constructing one from the (now string-exact) legacy id. */
export function extractOrderRef(payload: OrderPayload): string {
  if (payload.admin_graphql_api_id) return payload.admin_graphql_api_id;
  if (payload.id) return `gid://shopify/Order/${payload.id}`;
  throw new Error("orders/create payload has neither admin_graphql_api_id nor id");
}

/** PURE. Same preference order as `extractOrderRef`, at the line grain. */
export function extractLineRef(line: OrderLineItem): string {
  if (line.admin_graphql_api_id) return line.admin_graphql_api_id;
  return `gid://shopify/LineItem/${line.id}`;
}

/** PURE. `null` for a custom/manual line item with no `variant_id` — cannot be a Luxury Steal. */
export function extractLineVariantGid(line: OrderLineItem): string | null {
  if (!line.variant_id) return null;
  return normalizeShopifyVariantGid(line.variant_id);
}

/**
 * PURE. Finds the `_carat_ls_ack` line item property task 3-5 attaches at
 * add-to-cart time and returns its value as a trimmed string, or `null` if
 * absent/empty. Coerces a non-string property value (Shopify's cart API
 * ordinarily sends string properties, but the schema stays tolerant of a
 * number/boolean rather than throwing on an edge case) — this value is a
 * LOOKUP KEY only, never trusted further than "look this id up," so a
 * best-effort string coercion costs nothing in safety.
 */
export function extractAcknowledgmentPropertyValue(line: OrderLineItem): string | null {
  const match = line.properties?.find((property) => property.name === ACKNOWLEDGMENT_PROPERTY_NAME);
  if (!match || match.value === null || match.value === undefined) return null;
  const value = String(match.value).trim();
  return value.length > 0 ? value : null;
}

export interface LuxuryStealOrderLineResult {
  readonly lineRef: string;
  readonly masterVariantId: string;
  readonly outcome: "matched" | "unmatched";
  /** False when this (orderRef, lineRef) had already been recorded by a prior delivery — see `recordLuxuryStealOrderCheck`. */
  readonly created: boolean;
}

/**
 * Resolves the acknowledgment id a line's `_carat_ls_ack` property names (if
 * any) into a matched acknowledgment id, or `null`. Returns `null` for: no
 * property, a value that is not syntactically a UUID (never queried — the
 * column is `@db.Uuid`, and a malformed value can never be a real id), an id
 * that does not exist, and — THE TAMPER CASE — an id that exists but was
 * captured against a DIFFERENT variant than this order line's own.
 */
async function resolveMatchedAcknowledgmentId(
  line: OrderLineItem,
  lineVariantGid: string,
  context: { orderRef: string; lineRef: string }
): Promise<string | null> {
  const ackId = extractAcknowledgmentPropertyValue(line);
  if (!ackId || !UUID_PATTERN.test(ackId)) return null;

  const acknowledgment = await getAcknowledgmentById(ackId);
  if (!acknowledgment) return null;

  if (acknowledgment.variantRef !== lineVariantGid) {
    logger.warn("luxury_steal_order.acknowledgment_variant_mismatch", {
      orderRef: context.orderRef,
      lineRef: context.lineRef,
      acknowledgmentId: acknowledgment.id,
      acknowledgmentVariantRef: acknowledgment.variantRef,
      orderLineVariantGid: lineVariantGid,
    });
    return null;
  }

  return acknowledgment.id;
}

/**
 * Best-effort admin notification for a newly-discovered hold. Deliberately
 * NOT `dispatchAdminAlert`/`AdminAlertNotification` — that table's
 * `AdminAlertSourceKind` enum is schema-closed to the three price-failure
 * kinds, keyed on a single required `masterVariantId`, and shaped around a
 * recurring per-variant episode with open/suspend/resolve transitions. A
 * Luxury Steal order hold is order-grained (potentially several variants),
 * one-shot (no reopen/resolve lifecycle), and adding a 4th enum member would
 * mean a `prisma/schema.prisma` migration this task's scope does not include
 * (flagged to the architect separately).
 *
 * Reuses the SAME email boundary (`resolveEmailPort`/`EmailPort`) the
 * price-failure alerts use, so "email unconfigured"/"send failed" are logged
 * with the same honesty discipline `dispatchAdminAlert` follows — never
 * silently swallowed, never claimed as sent when it was not.
 *
 * The persistent, queryable, auditable record of the hold itself is
 * `luxury_steal_order_check` (M12) — not this email. See this module's own
 * doc comment and spec §5's own description of that table.
 */
async function notifyLuxuryStealOrderHeld(
  input: { orderRef: string; heldLines: readonly { lineRef: string; masterVariantId: string }[] },
  resolveEmailPort: () => EmailPortResolution
): Promise<void> {
  const resolution = resolveEmailPort();

  if (!resolution.configured) {
    logger.error("luxury_steal_order.alert_email_unconfigured", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      reason: resolution.reason,
    });
    return;
  }

  const lineSummary = input.heldLines
    .map((line) => `variant ${line.masterVariantId} (line ${line.lineRef})`)
    .join("; ");
  const subject = `Luxury Steal order held for review — ${input.orderRef}`;
  const text =
    `Order ${input.orderRef} has ${input.heldLines.length} Luxury Steal line item(s) with no ` +
    `matching, variant-verified Final Sale acknowledgment: ${lineSummary}. ` +
    "This order has NOT been cancelled and must NOT be fulfilled until reviewed. " +
    "Verify the customer's acknowledgment manually in Shopify admin before releasing it.";

  try {
    const sent = await resolution.port.send({ from: resolution.from, to: resolution.recipients, subject, text });
    logger.info("luxury_steal_order.alert_email_sent", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      providerMessageId: sent.providerMessageId,
    });
  } catch (error) {
    logger.error("luxury_steal_order.alert_email_failed", {
      orderRef: input.orderRef,
      heldLineCount: input.heldLines.length,
      // Name only, never the caught error's message — same discipline
      // `dispatchAdminAlert` follows (criterion 30).
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export interface HandleLuxuryStealOrderCreateWebhookDeps {
  resolveEmailPort?: () => EmailPortResolution;
}

/**
 * The handler `webhooks.carat.orders-create.tsx` wires to `receiveShopifyWebhook`.
 * For every line: resolve whether its variant is (right now, in Postgres) a
 * Luxury Steal; if so, verify its acknowledgment and record the outcome
 * either way (criterion 140). An order with any unmatched Luxury Steal line
 * is logged as held and (once, on first discovery) alerted — never silently
 * fulfilled, never auto-cancelled (criterion 138).
 *
 * IDEMPOTENT UNDER REDELIVERY (criterion 139) BY CONSTRUCTION, NOT BY A
 * SEPARATE CHECK: `recordLuxuryStealOrderCheck` is race-safe per
 * (orderRef, lineRef) and reports `created: false` for a row that already
 * existed. A pure redelivery therefore writes no new evidence and — because
 * the admin notification below is gated on at least one NEWLY created
 * unmatched row — sends no second alert. A redelivery that reprocesses after
 * a PARTIAL prior failure (some lines recorded, then a crash) still alerts
 * exactly once, at the point the hold first becomes fully known, because the
 * not-yet-recorded lines are the ones that come back `created: true`.
 *
 * A non-Luxury-Steal line, and a line whose variant this catalogue does not
 * recognise at all, produce NO evidence row and are otherwise untouched —
 * only Luxury Steal lines are ever checked (criterion 150 applied per line).
 */
export async function handleLuxuryStealOrderCreateWebhook(
  event: ReceivedWebhookEvent,
  deps: HandleLuxuryStealOrderCreateWebhookDeps = {}
): Promise<void> {
  const resolveEmailPort = deps.resolveEmailPort ?? defaultResolveEmailPort;

  const payload = parseOrderPayload(event.rawBody);
  const orderRef = extractOrderRef(payload);

  const heldLines: { lineRef: string; masterVariantId: string }[] = [];
  const newlyHeldLines: { lineRef: string; masterVariantId: string }[] = [];

  for (const line of payload.line_items ?? []) {
    const lineVariantGid = extractLineVariantGid(line);
    if (!lineVariantGid) continue; // custom/manual line item — no variant, cannot be a Luxury Steal

    const lineRef = extractLineRef(line);

    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: lineVariantGid },
      select: { id: true },
    });
    if (!variant) {
      // Not necessarily a bug — same reasoning as
      // `inventoryPurchasabilityHandler.server.ts`'s unresolved-identifier
      // case: a variant genuinely outside our catalogue produces no evidence
      // row, because there is nothing in Postgres to check it against.
      logger.warn("luxury_steal_order.unresolved_variant", { orderRef, lineRef, variantGid: lineVariantGid });
      continue;
    }

    // CRITERION 150/127 — the only question asked of Postgres, never a
    // metafield or client-supplied flag.
    const isLuxurySteal = await isMasterVariantLuxurySteal(variant.id);
    if (!isLuxurySteal) continue; // an ordinary line — no evidence row, order untouched

    const matchedAcknowledgmentId = await resolveMatchedAcknowledgmentId(line, lineVariantGid, {
      orderRef,
      lineRef,
    });

    const result = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef: variant.id,
      matchedAcknowledgmentId,
    });

    if (result.outcome === "unmatched") {
      heldLines.push({ lineRef, masterVariantId: variant.id });
      if (result.created) newlyHeldLines.push({ lineRef, masterVariantId: variant.id });
    }
  }

  if (heldLines.length > 0) {
    logger.error("luxury_steal_order.held_for_review", {
      orderRef,
      heldLineCount: heldLines.length,
      lineRefs: heldLines.map((line) => line.lineRef),
    });
  }

  if (newlyHeldLines.length > 0) {
    await notifyLuxuryStealOrderHeld({ orderRef, heldLines }, resolveEmailPort);
  }
}
