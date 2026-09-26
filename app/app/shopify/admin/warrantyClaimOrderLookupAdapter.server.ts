import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * Order/line existence check for warranty claim intake (Slice 5 task 5-3,
 * criterion 155: "A claim referencing an order or line that cannot be
 * resolved is refused rather than stored against a guess").
 *
 * CONFIDENCE GRADING — read before trusting this file (same convention
 * `luxuryStealOrderReviewAdapter.server.ts`'s module comment uses).
 * LIVE-INTROSPECTED, 2026-09-26 (D33 follow-up). `tests/live/
 * slice5.orderLookupSchemaIntrospection.ts` ran `__type` introspection
 * against caratforus-dev (Admin API 2026-07) and confirmed `Query.order`'s
 * `id` argument, and every field this file selects — `Order.id/name/email/
 * customer/lineItems`, `Customer.id`, `LineItem.id` — all exist with the
 * expected named type. Unlike the sibling `warrantyOrderLookupAdapter.server.ts`,
 * this file never uses the `orders(query:)` search filter (it looks up a GID
 * the caller already has via `order(id:)` directly), so there is no separate
 * "does the search filter actually match" behavioural question left open the
 * way there is for that sibling — this shape is now fully live-verified, not
 * merely schema-checked.
 *
 * DELIBERATELY MINIMAL — answers exactly one question: does an order with
 * this id exist, and does it have a line item with this id. Nothing else:
 * no fulfillment/payment status, no pricing or cost data (CLAUDE.md rule
 * 10), and — most importantly — NO CUSTOMER-OWNERSHIP VERIFICATION beyond
 * returning `customerGid`/`orderEmail` for the CALLER to compare against
 * what the claimant supplied. Deciding whether the order genuinely belongs
 * to the person filing the claim is `apps.carat.warranty-claim.tsx`'s job
 * (a light same-logged-in-customer check) and, more substantively, staff
 * review during `under_review` (`WARRANTY-CLAIMS.md` §3 — CaratForUs
 * reviews every claim before authorizing anything) — never fully automated
 * here.
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

const ORDER_LINE_LOOKUP_QUERY = `#graphql
  query CaratWarrantyClaimOrderLookup($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer { id }
      lineItems(first: 250) {
        nodes { id }
      }
    }
  }`;

export interface WarrantyClaimOrderLookupResult {
  readonly orderGid: string;
  readonly orderName: string;
  readonly customerGid: string | null;
  readonly orderEmail: string | null;
  readonly lineItemGid: string;
}

export interface WarrantyClaimOrderLookupPort {
  /**
   * Resolves an order + one of its line items. Returns `null` if the order
   * does not exist, OR exists but carries no line item with this id —
   * criterion 155's exact refusal condition, collapsed to one signal so the
   * route cannot accidentally treat "order missing" and "line missing" as
   * different outcomes.
   */
  resolveOrderLine(input: { orderGid: string; lineItemGid: string }): Promise<WarrantyClaimOrderLookupResult | null>;
}

export class ShopifyWarrantyClaimOrderLookupAdapter implements WarrantyClaimOrderLookupPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async resolveOrderLine(input: {
    orderGid: string;
    lineItemGid: string;
  }): Promise<WarrantyClaimOrderLookupResult | null> {
    const data = await execute(this.client, "warrantyClaimOrderLookup", ORDER_LINE_LOOKUP_QUERY, {
      id: input.orderGid,
    });
    const order = data.order as
      | {
          id: string;
          name: string;
          email: string | null;
          customer: { id: string } | null;
          lineItems?: { nodes?: { id: string }[] };
        }
      | null;
    if (!order) return null;

    const lineItemIds = order.lineItems?.nodes?.map((node) => node.id) ?? [];
    if (!lineItemIds.includes(input.lineItemGid)) return null;

    return {
      orderGid: order.id,
      orderName: order.name,
      customerGid: order.customer?.id ?? null,
      orderEmail: order.email,
      lineItemGid: input.lineItemGid,
    };
  }
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingWarrantyClaimOrderLookupPort implements WarrantyClaimOrderLookupPort {
  readonly calls: { orderGid: string; lineItemGid: string }[] = [];
  /** Key `${orderGid}::${lineItemGid}` -> result. An unseeded combination resolves to `null` (unresolved), matching a real "not found" order/line. */
  readonly results = new Map<string, WarrantyClaimOrderLookupResult>();

  seed(orderGid: string, lineItemGid: string, result: Omit<WarrantyClaimOrderLookupResult, "orderGid" | "lineItemGid">): void {
    this.results.set(`${orderGid}::${lineItemGid}`, { ...result, orderGid, lineItemGid });
  }

  async resolveOrderLine(input: {
    orderGid: string;
    lineItemGid: string;
  }): Promise<WarrantyClaimOrderLookupResult | null> {
    this.calls.push(input);
    return this.results.get(`${input.orderGid}::${input.lineItemGid}`) ?? null;
  }
}
