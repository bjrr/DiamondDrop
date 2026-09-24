import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * `LuxuryStealOrderReviewAdapter` — the ONLY module in this app that talks to
 * the Shopify Admin API's order-tagging and merchant-managed fulfilment-hold
 * surface (Slice 3 D28, owner-approved 2026-09-24,
 * docs/specs/SLICE-3-LUXURY-STEALS.md §D28, criteria 137-140). Mirrors
 * `draftOrderAdapter.server.ts`'s shape deliberately — same
 * `AdminGraphqlClient` injection, same `AdminApiError`, same five-step check
 * discipline (top-level `errors` first, payload present, `userErrors` empty,
 * identity check, then the mutation-specific echo/state check) — a reviewer
 * who has read one should be able to read this one.
 *
 * ============================================================================
 * WHAT IS VERIFIED VERSUS RECALLED
 * ============================================================================
 *
 * LIVE-VERIFIED BY INTROSPECTION against `caratforus-dev`, 2026-09-24 (by the
 * architect — this adapter itself is still not deployed or live-called; the
 * SCHEMA SHAPES below are confirmed, the WRITE PATH is not):
 *   - `fulfillmentOrderHold(id: ID!, fulfillmentHold: FulfillmentOrderHoldInput!)`.
 *   - `FulfillmentOrderHoldInput`: `reason`, `reasonNotes`, `notifyMerchant`,
 *     `externalId`, `handle`, `fulfillmentOrderLineItems` — `handle: String`
 *     is REAL (see "THE HANDLE" below). An earlier revision of this file
 *     deliberately OMITTED `handle`, reasoning that an unrecognised field on
 *     a typed GraphQL input is a whole-mutation coercion error and guessing
 *     a field name was not worth that risk. That reasoning was sound on the
 *     information available then; the resolution was not to guess harder
 *     but to introspect, which has now been done.
 *   - `FulfillmentHoldReason`: AWAITING_PAYMENT, HIGH_RISK_OF_FRAUD,
 *     INCORRECT_ADDRESS, INVENTORY_OUT_OF_STOCK, UNKNOWN_DELIVERY_DATE,
 *     ONLINE_STORE_POST_PURCHASE_CROSS_SELL, AWAITING_RETURN_ITEMS, OTHER.
 *     None is policy-shaped for "acknowledgment unverified"; `OTHER` plus
 *     `reasonNotes` is correct, not a compromise.
 *   - `FulfillmentOrderHoldPayload`: `fulfillmentHold`, `fulfillmentOrder`,
 *     `remainingFulfillmentOrder`, `userErrors`.
 *   - `FulfillmentOrderHoldUserError`: `code`, `field`, `message` — `code` is
 *     a TYPED ENUM, not free text (see "THE DUPLICATE-HANDLE CODE" below).
 *   - `FulfillmentOrderHoldUserErrorCode`: FULFILLMENT_ORDER_NOT_FOUND,
 *     TAKEN, GREATER_THAN_ZERO, FULFILLMENT_ORDER_HOLD_LIMIT_REACHED,
 *     DUPLICATE_FULFILLMENT_HOLD_HANDLE, INVALID_LINE_ITEM_QUANTITY,
 *     FULFILLMENT_ORDER_NOT_SPLITTABLE, DUPLICATED_FULFILLMENT_ORDER_LINE_ITEMS.
 *
 * STILL RECALLED, NOT ITSELF RE-VERIFIED IN THIS PASS (the introspection
 * covered the hold mutation specifically — these three carry the SAME
 * confidence grading as before):
 *   - `FulfillmentOrder.status` / `FulfillmentOrderStatus.ON_HOLD` — HIGH
 *     confidence, corroborated by the bundled REST resource's own
 *     `status: string | null` field (`node_modules/@shopify/shopify-api/
 *     rest/admin/2026-07/fulfillment_order.ts`).
 *   - `Order.fulfillmentOrders(first:)` connection — MODERATE confidence.
 *   - `tagsAdd(id: ID!, tags: [String!]!)` — HIGH confidence: a generic,
 *     long-stable mutation used across many taggable resources.
 *
 * Anyone changing the shapes in this file should introspect again rather
 * than trusting this comment — it is a record of what was true when it was
 * written, not a substitute for checking.
 *
 * THE HANDLE. Deterministic and namespaced, computed by
 * `buildLuxuryStealHoldHandle` from ONLY the fulfilment order gid — no
 * timestamp, no random component, nothing carried between deliveries. That
 * is the whole requirement: a REDELIVERY of the same `orders/create`
 * re-derives the same fulfilment order id from Shopify and therefore
 * computes the IDENTICAL handle, with no state of our own to consult first.
 * Namespaced (`carat:luxury-steal-unverified:` prefix) so it can never
 * collide with a hold any OTHER app or the merchant places under a different
 * scheme.
 *
 * THE DUPLICATE-HANDLE CODE IS THE PRIMARY "ALREADY HELD BY US" SIGNAL, not
 * a `status` re-check. `DUPLICATE_FULFILLMENT_HOLD_HANDLE` is a TYPED ENUM
 * value Shopify itself returns when our exact handle already names an
 * existing hold on this fulfilment order — no pattern-matching on message
 * text, no second round trip, and STRICTLY more precise than a bare
 * `status === ON_HOLD` check: `ON_HOLD` only proves the fulfilment order is
 * held by *someone* (a merchant may have placed their own, unrelated hold);
 * `DUPLICATE_FULFILLMENT_HOLD_HANDLE` proves it is held *by us, under this
 * exact handle*. The `status` re-check below is kept as an explicit
 * SECONDARY fallback for any OTHER userError — it still asks "is this
 * fulfilment order protected at all," because that broader safety property
 * (nothing can progress past packing) holds regardless of whose hold
 * achieves it, and it is also what recognises a hold placed by an EARLIER
 * version of this code that sent no handle at all.
 *
 * TWO OTHER CODES ARE REAL AND ARE NEVER SWALLOWED AS GENERIC:
 * `FULFILLMENT_ORDER_HOLD_LIMIT_REACHED` (too many holds already exist on
 * this fulfilment order for us to add another) and `TAKEN` (semantics not
 * independently confirmed here — it may be a generic "identifier already in
 * use" code Shopify reuses across mutations, distinct in meaning from
 * `DUPLICATE_FULFILLMENT_HOLD_HANDLE`'s hold-specific case; worth watching
 * during the live gate to see which actually fires and when). Both still
 * fall through to the `status` fallback (a hold blocked for either reason
 * may still leave the fulfilment order genuinely protected by something
 * else), but `HoldFulfillmentOrderResult.userErrorCodes` always carries
 * every distinct code Shopify returned, so neither is ever silently
 * indistinguishable from an unrecognised failure in the audit trail the
 * handler writes.
 * ============================================================================
 */

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

async function execute(
  client: AdminGraphqlClient,
  operation: string,
  document: string,
  variables?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await client.graphql(document, variables ? { variables } : undefined);
  const body = (await response.json()) as GraphqlEnvelope;

  if (body.errors?.length) {
    throw new AdminApiError(operation, body.errors.map((e) => e.message));
  }
  if (!body.data) {
    throw new AdminApiError(operation, ["response contained no data"]);
  }
  return body.data;
}

const TAGS_ADD_MUTATION = `#graphql
  mutation CaratOrderTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

const LIST_ORDER_FULFILLMENT_ORDERS_QUERY = `#graphql
  query CaratOrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 25) {
        nodes { id status }
      }
    }
  }`;

const FULFILLMENT_ORDER_HOLD_MUTATION = `#graphql
  mutation CaratFulfillmentOrderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      fulfillmentOrder { id status }
      userErrors { field message code }
    }
  }`;

const FULFILLMENT_ORDER_STATUS_QUERY = `#graphql
  query CaratFulfillmentOrderStatus($id: ID!) {
    fulfillmentOrder(id: $id) {
      id
      status
    }
  }`;

/** Namespaced so this app's deterministic hold handle can never collide with a hold any OTHER app or the merchant places under its own scheme. */
const LUXURY_STEAL_HOLD_HANDLE_NAMESPACE = "carat:luxury-steal-unverified";

/**
 * PURE. Deterministic per fulfilment order — the SAME handle every time,
 * including on a redelivery, which is exactly what lets Shopify's own
 * `DUPLICATE_FULFILLMENT_HOLD_HANDLE` code work as this app's idempotency
 * signal (live-verified 2026-09-24 — see module doc comment).
 */
export function buildLuxuryStealHoldHandle(fulfillmentOrderGid: string): string {
  return `${LUXURY_STEAL_HOLD_HANDLE_NAMESPACE}:${fulfillmentOrderGid}`;
}

export interface FulfillmentOrderSummary {
  readonly id: string;
  readonly status: string;
}

export interface HoldFulfillmentOrderResult {
  readonly status: string;
  /**
   * How this outcome was determined:
   *  - `"applied"` — a fresh hold; no `userErrors` at all.
   *  - `"duplicate_handle"` — Shopify's typed `DUPLICATE_FULFILLMENT_HOLD_HANDLE`
   *    code: this exact app already holds this fulfilment order under this
   *    exact handle. The PRIMARY recognition path.
   *  - `"status_fallback"` — some OTHER `userError`, but a follow-up status
   *    query found `ON_HOLD` anyway (e.g. a merchant's own hold, a hold
   *    placed under an earlier handle-less version of this code, or an
   *    unrecognised code). SECONDARY and less precise: the fulfilment order
   *    is protected, but not provably by OUR handle — see `userErrorCodes`.
   *
   *    KNOWN LIMITATION, not a defect to fix now (architect review,
   *    2026-09-24): this outcome records that the fulfilment order is
   *    protected, not that WE are the reason it is protected. If it is
   *    `ON_HOLD` only because of someone else's hold (a merchant, or another
   *    app) and that OTHER hold is later released, the fulfilment order
   *    becomes shippable again while this app's own records still show it
   *    held — nothing here re-checks or re-asserts a hold once
   *    `status_fallback` has been recorded. The safety property this adapter
   *    actually verifies is "can this order ship right now," not "does our
   *    hold specifically exist," and the two can drift apart after the fact.
   */
  readonly recognizedVia: "applied" | "duplicate_handle" | "status_fallback";
  /**
   * Every DISTINCT `userError.code` Shopify returned, in the order first
   * seen. Empty for `"applied"`. Always populated (never silently dropped)
   * for the other two outcomes — this is what keeps a recognised-but-real
   * code like `FULFILLMENT_ORDER_HOLD_LIMIT_REACHED` or `TAKEN` visible in
   * the handler's audit trail even when the overall outcome still counts as
   * a success via the status fallback.
   */
  readonly userErrorCodes: readonly string[];
}

/**
 * Port-shaped interface (mirrors `DraftOrderPort`) so
 * `luxuryStealOrderHandler.server.ts` can be unit-tested with no network and
 * no database.
 */
export interface LuxuryStealOrderReviewPort {
  /** `tagsAdd`. Naturally idempotent — adding a tag the order already has is a no-op, not an error. Empty `tags` is a no-op (no call made). */
  addOrderTags(input: { orderGid: string; tags: readonly string[] }): Promise<void>;

  /** Every fulfilment order currently on the order, with its current status. Returns `[]` for an order with none (e.g. not yet propagated) rather than throwing — the caller decides what an empty result means. */
  listFulfillmentOrders(orderGid: string): Promise<FulfillmentOrderSummary[]>;

  /**
   * Places a hold with reason `OTHER`, `reasonNotes`, and this app's own
   * deterministic `handle` (`buildLuxuryStealHoldHandle`) — `reasonNotes` is
   * this app's ONLY way to explain a hold to staff, since D28 explicitly
   * forbids writing to `Order.note` (a shared field that could clobber a
   * pre-existing customer/merchant note across a webhook retry). Never
   * throws for "already held by us" — see `HoldFulfillmentOrderResult` and
   * this module's own doc comment for the recognition order (duplicate
   * -handle code first, status re-check second).
   */
  holdFulfillmentOrder(input: {
    fulfillmentOrderGid: string;
    reasonNotes: string;
  }): Promise<HoldFulfillmentOrderResult>;
}

export class ShopifyLuxuryStealOrderReviewAdapter implements LuxuryStealOrderReviewPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async addOrderTags(input: { orderGid: string; tags: readonly string[] }): Promise<void> {
    if (input.tags.length === 0) return;

    const data = await execute(this.client, "tagsAdd", TAGS_ADD_MUTATION, {
      id: input.orderGid,
      tags: [...input.tags],
    });

    const payload = data.tagsAdd as
      | { node?: { id: string } | null; userErrors?: { field?: string[] | null; message: string }[] }
      | undefined;
    if (!payload) {
      throw new AdminApiError("tagsAdd", ["response had no tagsAdd payload"]);
    }

    const userErrors = payload.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new AdminApiError(
        "tagsAdd",
        userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
      );
    }
    if (!payload.node) {
      throw new AdminApiError("tagsAdd", ["response carried no userErrors but also no node"]);
    }
    if (payload.node.id !== input.orderGid) {
      throw new AdminApiError("tagsAdd", [
        `expected order ${input.orderGid} but the response named ${payload.node.id}`,
      ]);
    }
  }

  async listFulfillmentOrders(orderGid: string): Promise<FulfillmentOrderSummary[]> {
    const data = await execute(this.client, "listFulfillmentOrders", LIST_ORDER_FULFILLMENT_ORDERS_QUERY, {
      id: orderGid,
    });

    const order = data.order as { fulfillmentOrders?: { nodes?: FulfillmentOrderSummary[] } } | null;
    return order?.fulfillmentOrders?.nodes ?? [];
  }

  private async requestFulfillmentOrderStatus(fulfillmentOrderGid: string): Promise<string | null> {
    const data = await execute(this.client, "fulfillmentOrderStatus", FULFILLMENT_ORDER_STATUS_QUERY, {
      id: fulfillmentOrderGid,
    });
    const fulfillmentOrder = data.fulfillmentOrder as { id: string; status: string } | null;
    return fulfillmentOrder?.status ?? null;
  }

  async holdFulfillmentOrder(input: {
    fulfillmentOrderGid: string;
    reasonNotes: string;
  }): Promise<HoldFulfillmentOrderResult> {
    const handle = buildLuxuryStealHoldHandle(input.fulfillmentOrderGid);

    const data = await execute(this.client, "fulfillmentOrderHold", FULFILLMENT_ORDER_HOLD_MUTATION, {
      id: input.fulfillmentOrderGid,
      fulfillmentHold: {
        // OTHER is correct rather than a compromise: introspection of the
        // live 2026-07 FulfillmentHoldReason enum shows no policy-shaped
        // value, and every other member would be a factually false claim
        // about why the order is held — see module doc comment.
        reason: "OTHER",
        reasonNotes: input.reasonNotes,
        handle,
      },
    });

    const payload = data.fulfillmentOrderHold as
      | {
          fulfillmentOrder?: { id: string; status: string } | null;
          userErrors?: { field?: string[] | null; message: string; code?: string | null }[];
        }
      | undefined;
    if (!payload) {
      throw new AdminApiError("fulfillmentOrderHold", ["response had no fulfillmentOrderHold payload"]);
    }

    const userErrors = payload.userErrors ?? [];
    if (userErrors.length === 0) {
      if (!payload.fulfillmentOrder) {
        throw new AdminApiError("fulfillmentOrderHold", [
          "response carried no userErrors but also no fulfillmentOrder",
        ]);
      }
      return { status: payload.fulfillmentOrder.status, recognizedVia: "applied", userErrorCodes: [] };
    }

    // Distinct codes, in first-seen order, never silently dropped — see
    // `HoldFulfillmentOrderResult.userErrorCodes`'s own doc comment.
    const codes: string[] = [];
    for (const error of userErrors) {
      if (error.code && !codes.includes(error.code)) codes.push(error.code);
    }

    // PRIMARY recognition path (live-verified 2026-09-24). Because we send a
    // stable handle above, a redelivered webhook that re-attempts this hold
    // gets exactly this typed code back from Shopify — no free-text pattern
    // matching, no second round trip. See module doc comment for why this is
    // strictly more precise than the status fallback below.
    if (codes.includes("DUPLICATE_FULFILLMENT_HOLD_HANDLE")) {
      return { status: "ON_HOLD", recognizedVia: "duplicate_handle", userErrorCodes: codes };
    }

    // SECONDARY fallback for any OTHER userError (including the recognised
    // -but-distinct FULFILLMENT_ORDER_HOLD_LIMIT_REACHED / TAKEN codes, a
    // hold placed under an earlier handle-less version of this code, and
    // anything unrecognised): is this fulfilment order protected at ALL,
    // regardless of whether we can attribute it to our own handle.
    const currentStatus = await this.requestFulfillmentOrderStatus(input.fulfillmentOrderGid);
    if (currentStatus === "ON_HOLD") {
      return { status: currentStatus, recognizedVia: "status_fallback", userErrorCodes: codes };
    }

    throw new AdminApiError("fulfillmentOrderHold", [
      ...userErrors.map(
        (e) => `${(e.field ?? []).join(".") || "(general)"}${e.code ? ` [${e.code}]` : ""}: ${e.message}`
      ),
      `re-check found status ${currentStatus === null ? "(fulfillment order not found)" : `"${currentStatus}"`}, not ON_HOLD — the hold did not take effect`,
    ]);
  }
}
