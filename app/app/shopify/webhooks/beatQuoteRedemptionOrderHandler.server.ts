import { z } from "zod";

import { createAuditEvent } from "~/db/repositories/auditEventRepository.server";
import { prisma } from "~/db/client.server";
import {
  verifyAndCompleteBeatQuoteRedemption,
  type CompleteRedemptionResult,
} from "~/jobs/beatyourquote/redeemFallbackBenefit.server";
import { logger } from "~/lib/logger.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

import { preserveShopifyBigIntIds } from "./luxuryStealOrderHandler.server";

/**
 * `orders/paid` → order-time verification of a fallback-benefit redemption
 * (Slice 10, owner decision 2026-10-10).
 *
 * ============================================================================
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ============================================================================
 * "Order-time verification must fail closed to staff review on any mismatch,"
 * and "do not mark the benefit redeemed merely because a Draft Order was
 * created." Both come from the owner, and the reasoning is worth restating:
 * when the discount on a real paid order disagrees with the discount we
 * reserved, that is either our bug or someone's tampering. Marking the benefit
 * redeemed accepts the wrong discount AND spends the customer's one use;
 * releasing it hands back a benefit that may already have been honoured. So a
 * person decides, and the intent goes to `failed_review`.
 *
 * ============================================================================
 * THE ORDER IS IDENTIFIED BY ASKING SHOPIFY, NOT BY READING A TAG
 * ============================================================================
 * Same discipline as `customJewelryDepositPaymentHandler.server.ts`, and the
 * same reason: tags are editable by any Shopify admin user, so a tag is a
 * LOOKUP HINT and never an authorisation. The tag names a redemption intent;
 * that intent's own `draftOrderGid` is then put to Shopify, which answers
 * which order the draft order actually became. Only if that answer matches the
 * order in this delivery does anything get written.
 *
 * A tag pointing at an intent whose draft order became a DIFFERENT order is
 * precisely the shape a forged redemption would take, so it is an anomaly
 * recorded for staff — not a quiet return.
 *
 * ============================================================================
 * WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT RECOMPUTED
 * ============================================================================
 * The comparison is against the FROZEN reservation. A cart can change between
 * reservation and payment; what was promised cannot. Recomputing the discount
 * from the order's own lines would make the order its own authority, which is
 * exactly the property an attacker needs.
 *
 * Excluded merchandise IS re-derived from our database, because that is not a
 * recomputation of the promise — it is checking whether the thing actually
 * bought was eligible. A Luxury Steal or open-campaign Group Buy variant on a
 * discounted order means the terms were not honoured, however it happened.
 */

/**
 * The order tag that names the redemption. A hint for the lookup only — see the
 * header. Prefixed in the same style as `carat-project-` so an admin reading
 * the Shopify order list can tell what these orders are.
 */
export const BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX = "carat-bq-redeem-";

const orderPaidPayloadSchema = z.object({
  admin_graphql_api_id: z.string().min(1),
  tags: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  /** Shopify's own total of every discount on the order, as a decimal string. */
  current_total_discounts: z.string().nullable().optional(),
  total_discounts: z.string().nullable().optional(),
  /**
   * Non-empty means a code was applied at checkout. We created this order with
   * `allowDiscountCodesInCheckout:false`, so anything here is a mismatch.
   */
  discount_codes: z
    .array(z.object({ code: z.string().optional(), type: z.string().optional() }).passthrough())
    .nullable()
    .optional(),
  /**
   * When the money actually moved. The benefit's expiry is judged against this
   * rather than against this delivery's arrival — see `orderPaidAt` on
   * `VerifyAndCompleteInput`.
   */
  processed_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  customer: z
    .object({ admin_graphql_api_id: z.string().nullable().optional() })
    .nullable()
    .optional(),
  line_items: z
    .array(
      z
        .object({
          admin_graphql_api_id: z.string().nullable().optional(),
          variant_id: z.union([z.string(), z.number()]).nullable().optional(),
        })
        .passthrough()
    )
    .nullable()
    .optional(),
});

const DRAFT_ORDER_RESULTING_ORDER_QUERY = `#graphql
  query CaratRedemptionDraftOrderResultingOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      order { id }
    }
  }`;

export interface BeatQuoteRedemptionOrderDeps {
  /**
   * A FACTORY, not a client. Built only once this handler knows the order
   * actually carries a redemption tag — an eagerly-built Admin client made
   * every Buy Now and Group Buy order pay for a session lookup it never
   * needed, and a live delivery for an unknown shop returned 500.
   */
  readonly adminGraphql: () => Promise<AdminGraphqlClient>;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** The single redemption intent id named by the tags, or null. */
function intentIdFromTags(tags: readonly string[]): string | null {
  const prefix = BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX;
  const matches = tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length).trim());
  // MORE THAN ONE IS REFUSED, not resolved by picking the first. Two redemption
  // tags on one order is a state nothing in this app creates, so guessing which
  // benefit to spend would be inventing an answer.
  if (matches.length !== 1) return null;
  return matches[0]!.length > 0 ? matches[0]! : null;
}

/**
 * A decimal money string to integer minor units, without floating point.
 * Mirrors the identical helper in the deposit handler.
 */
function decimalStringToMinorUnits(raw: string): bigint | null {
  const cleaned = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** `gid://shopify/ProductVariant/<id>` from the webhook's numeric variant id. */
function variantGidFrom(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value.length === 0) return null;
  return value.startsWith("gid://") ? value : `gid://shopify/ProductVariant/${value}`;
}

/**
 * Whether any purchased line is merchandise the benefit excludes, re-derived
 * from our own database rather than from the order.
 *
 * FAILS CLOSED ON AN UNRECOGNISED VARIANT. A line we cannot classify is not
 * evidence that it is eligible — and a redemption order should only ever
 * contain variants this app priced.
 *
 * MUST BE REVISITED WHEN CUSTOM JEWELRY REDEMPTION IS WIRED. Today the only
 * thing that creates a redemption order is `apps.carat.beat-quote-redeem.tsx`,
 * which builds variant lines exclusively, so "no identifiable variants" really
 * does mean something is wrong. A Custom Jewelry redemption would carry a
 * CUSTOM line with no `variant_id` at all — Shopify's own shape for a line with
 * no catalogue entry — and this function would reject a perfectly legitimate
 * order. The fix is not to loosen the check: it is to classify by the intent's
 * own `surface`, which already distinguishes the two. Left as it stands rather
 * than pre-built, because a branch for a flow that does not exist yet is a
 * branch nothing tests.
 */
async function containsExcludedMerchandise(
  variantGids: readonly string[]
): Promise<{ excluded: boolean; detail: string | null }> {
  if (variantGids.length === 0) {
    return { excluded: true, detail: "the order carried no identifiable product variants" };
  }
  const variants = await prisma.masterVariant.findMany({
    where: { shopifyVariantGid: { in: [...variantGids] } },
    select: {
      shopifyVariantGid: true,
      isLuxurySteal: true,
      groupBuyCampaignVariants: {
        where: { campaign: { status: "open" } },
        select: { id: true },
        take: 1,
      },
    },
  });
  const byGid = new Map(variants.map((v) => [v.shopifyVariantGid as string, v]));

  const problems: string[] = [];
  for (const gid of variantGids) {
    const variant = byGid.get(gid);
    if (!variant) {
      problems.push(`${gid} is not a variant this app prices`);
      continue;
    }
    if (variant.isLuxurySteal) problems.push(`${gid} is a Luxury Steal (Final Sale, excluded)`);
    if (variant.groupBuyCampaignVariants.length > 0) {
      problems.push(`${gid} belongs to an open Group Buy campaign (excluded)`);
    }
  }
  return problems.length > 0
    ? { excluded: true, detail: problems.join("; ") }
    : { excluded: false, detail: null };
}

export async function handleBeatQuoteRedemptionOrderPaidWebhook(
  event: ReceivedWebhookEvent,
  deps: BeatQuoteRedemptionOrderDeps
): Promise<void> {
  // `preserveShopifyBigIntIds` returns a STRING, not an object. Handing it
  // straight to a Zod schema is how every deposit payment was silently ignored
  // in production for a day — the parse failed and the handler returned early.
  const doctored = JSON.parse(preserveShopifyBigIntIds(event.rawBody)) as unknown;
  const parsed = orderPaidPayloadSchema.safeParse(doctored);
  if (!parsed.success) {
    logger.error("beat_quote_redemption_order.payload_unparseable", {
      shopifyEventId: event.shopifyEventId,
      issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")),
    });
    // THROWS, so Shopify redelivers. A payload we cannot read is not a payload
    // we can conclude anything from, and silently returning would discard a
    // real redemption.
    throw new Error("orders/paid payload did not match the expected shape");
  }

  const payload = parsed.data;
  const orderGid = payload.admin_graphql_api_id;
  const tags = parseTags(payload.tags);

  // NOT OUR ORDER. The overwhelmingly common case — every Buy Now, Group Buy
  // and deposit order lands here too — so it returns before any database or
  // Shopify work.
  if (!tags.some((tag) => tag.startsWith(BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX))) return;

  const intentId = intentIdFromTags(tags);
  if (!intentId) {
    // A redemption-tagged order whose tag we cannot resolve to one intent.
    // Recorded rather than thrown: redelivery will not make the tags better.
    await recordAnomaly(orderGid, "order carries a redemption tag that does not name exactly one intent");
    return;
  }

  const intent = await prisma.beatQuoteRedemptionIntent.findUnique({
    where: { id: intentId },
    select: { id: true, draftOrderGid: true, status: true },
  });
  if (!intent) {
    await recordAnomaly(orderGid, `order is tagged for redemption intent ${intentId}, which does not exist`);
    return;
  }
  if (!intent.draftOrderGid) {
    await recordAnomaly(
      orderGid,
      `redemption intent ${intentId} has no draft order recorded, so this order cannot be matched to it`
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // SHOPIFY DECIDES WHETHER THIS ORDER IS THE ONE. See the header.
  // ---------------------------------------------------------------------------
  const adminGraphql = await deps.adminGraphql();
  const response = await adminGraphql.graphql(DRAFT_ORDER_RESULTING_ORDER_QUERY, {
    variables: { id: intent.draftOrderGid },
  });
  const body = (await response.json()) as {
    data?: { draftOrder?: { id: string; order?: { id: string } | null } | null };
    errors?: unknown;
  };
  if (body.errors) {
    // THROWS: an Admin API failure is transient and redelivery is the right
    // response. Recording an anomaly would convert a retryable blip into a
    // permanent unverified redemption.
    throw new Error(
      `could not resolve the resulting order for draft order ${intent.draftOrderGid}: ${JSON.stringify(body.errors)}`
    );
  }
  const resultingOrderGid = body.data?.draftOrder?.order?.id ?? null;
  if (resultingOrderGid !== orderGid) {
    logger.error("beat_quote_redemption_order.order_mismatch", {
      orderGid,
      intentId,
      draftOrderGid: intent.draftOrderGid,
      resultingOrderGid,
    });
    await recordAnomaly(
      orderGid,
      `tags point at redemption intent ${intentId}, but its draft order ${intent.draftOrderGid} ` +
        `became order ${resultingOrderGid ?? "(none)"} — refusing to redeem a benefit against an order Shopify does not agree is its own`
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // WHAT THE ORDER ACTUALLY CARRIES
  // ---------------------------------------------------------------------------
  // `current_total_discounts` reflects edits and refunds; `total_discounts` is
  // the original. The CURRENT figure is the one that matters: a redemption
  // whose discount was edited after the fact did not honour the reservation.
  const discountsRaw = payload.current_total_discounts ?? payload.total_discounts ?? null;
  const observedDiscountMinorUnits = discountsRaw ? decimalStringToMinorUnits(discountsRaw) : null;
  if (observedDiscountMinorUnits === null) {
    await recordAnomaly(
      orderGid,
      `order for redemption intent ${intentId} carried no readable discount total (${discountsRaw ?? "absent"})`
    );
    return;
  }

  // WHEN THE CUSTOMER PAID, not when this delivery arrived. Unreadable is an
  // anomaly rather than a fallback to `now`: substituting the current time
  // would silently reintroduce the exact bug `orderPaidAt` exists to prevent,
  // and a paid order with no readable timestamp is strange enough to look at.
  // Same treatment, same field, as the deposit handler.
  const paidAtRaw = payload.processed_at ?? payload.created_at ?? null;
  const orderPaidAt = paidAtRaw ? new Date(paidAtRaw) : null;
  if (!orderPaidAt || Number.isNaN(orderPaidAt.getTime())) {
    logger.error("beat_quote_redemption_order.unreadable_paid_at", { orderGid, intentId });
    await recordAnomaly(
      orderGid,
      `order for redemption intent ${intentId} carried no readable processed_at/created_at timestamp, ` +
        `so the benefit's expiry cannot be judged against when it was paid`
    );
    return;
  }

  const variantGids = (payload.line_items ?? [])
    .map((line) => variantGidFrom(line.variant_id))
    .filter((gid): gid is string => gid !== null);
  const excluded = await containsExcludedMerchandise(variantGids);

  // A DISCOUNT CODE ON THIS ORDER IS A MISMATCH BY CONSTRUCTION. The draft
  // order was created with `allowDiscountCodesInCheckout:false` and that was
  // read back, so an applied code means either the flag did not hold or the
  // order was edited afterwards. Either way it is not the non-stackable
  // benefit the amendment describes.
  const otherPromotionOnOrder = (payload.discount_codes ?? []).length > 0;

  const result: CompleteRedemptionResult = await verifyAndCompleteBeatQuoteRedemption({
    intentId,
    orderGid,
    orderCustomerRef: payload.customer?.admin_graphql_api_id ?? null,
    observedDiscountMinorUnits,
    observedCurrency: payload.currency?.trim().toUpperCase() ?? "",
    otherPromotionOnOrder,
    containsExcludedMerchandise: excluded.excluded,
    orderPaidAt,
    now: new Date(),
  });

  if (result.outcome === "failed_review") {
    // The intent is already in `failed_review`; the audit event is so staff
    // find it from the order as well as from the queue. `excluded.detail`
    // carries WHICH line was the problem, which the domain function does not
    // know.
    await recordAnomaly(
      orderGid,
      `redemption ${intentId} failed order-time verification: ${result.reason}` +
        (excluded.detail ? ` (${excluded.detail})` : "")
    );
    logger.error("beat_quote_redemption_order.failed_review", { orderGid, intentId, reason: result.reason });
    return;
  }

  if (result.outcome === "intent_not_found") {
    // Raced with a delete that cannot happen — the table is append-only and the
    // intent was read moments ago.
    await recordAnomaly(orderGid, `redemption intent ${intentId} vanished between lookup and completion`);
    return;
  }

  // `completed` or `already_completed`. The second is the normal answer to a
  // redelivery and is not noteworthy.
  logger.info("beat_quote_redemption_order.verified", { orderGid, intentId, outcome: result.outcome });
}

/**
 * An anomaly a human needs to look at, written where staff can find it.
 *
 * Never throws into the caller: failing to record the note must not turn a
 * non-retryable anomaly into a retried delivery, which would bury the anomaly
 * under redelivery noise.
 */
async function recordAnomaly(orderGid: string, detail: string): Promise<void> {
  try {
    await createAuditEvent({
      entityType: "beat_quote_redemption",
      // Keyed on the ORDER, not the intent: when the anomaly is that we cannot
      // trust which intent this order belongs to, the order is the only
      // identifier that is certainly correct.
      entityId: orderGid,
      action: "anomaly",
      actorType: "system",
      actorRef: "webhook:orders-paid",
      reason: detail,
    });
  } catch (error) {
    logger.error("beat_quote_redemption_order.audit_write_failed", {
      orderGid,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}
