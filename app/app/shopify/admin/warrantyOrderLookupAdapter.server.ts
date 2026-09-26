import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * Order-by-human-number lookup for D33 (docs/ARCHITECTURE-MVP1.md, the
 * warranty claim order-lookup flow), RETIRED TO AUTHENTICATED-ONLY per
 * `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` (LOCKED OWNER REQUIREMENT,
 * 2026-09-26). Distinct from `warrantyClaimOrderLookupAdapter.server.ts`,
 * which resolves a Shopify GID the CALLER already has — this file exists
 * because a real customer never has a GID, only the order number Shopify
 * shows them (e.g. "#1001").
 *
 * CONFIDENCE GRADING (same convention as the twin file's own header,
 * `luxuryStealOrderReviewAdapter.server.ts`'s introspection note).
 * SCHEMA-LEVEL SHAPE — LIVE-INTROSPECTED, 2026-09-26. `tests/live/
 * slice5.orderLookupSchemaIntrospection.ts` ran `__type` introspection
 * against caratforus-dev (Admin API 2026-07) and confirmed `Query.order`'s
 * and `Query.orders`' argument names (`id`; `first`, `query`), and every
 * field this file selects (`Order.id/name/email/customer/lineItems`,
 * `Customer.id`, `LineItem.id/name/quantity`) — all exist with the expected
 * named type. That closes the "does this field even exist" risk that would
 * otherwise surface as a hard GraphQL error in production.
 *
 * STILL OPEN, AND SCHEMA INTROSPECTION CANNOT CLOSE IT: whether
 * `orders(query: "name:#1001")`'s `name:` filter actually MATCHES the order
 * with that exact name, rather than some other interpretation of the search
 * string — that is BEHAVIOUR, not schema. This open item predates and
 * survives the guest-flow retirement: the authenticated route below still
 * depends on `findOrderByName` exactly the same way. `findOrderByName`'s
 * not-found path (a name that certainly does not exist resolves to `null`,
 * not an error) IS live-verified — see `tests/live/slice5.warrantyOrderLookup.ts`.
 * The FOUND path is not, because caratforus-dev currently has zero orders to
 * query against; see that gate file's own header for the plan to close it
 * once real order data exists.
 *
 * SCOPE DISCIPLINE — READ BEFORE CHANGING THE QUERIES BELOW. This
 * deliberately does NOT query `customer(id:).orders(...)` (a "list every
 * order for this customer" shape), because that root-level `customer` field
 * access is believed to require the `read_customers` scope, which this app
 * does not hold and CLAUDE.md/D33's assigning message both forbid silently
 * requesting. Instead, `apps.carat.warranty-order-lookup.tsx` looks the order
 * up by the NUMBER the authenticated customer supplies, then checks
 * `order.customer.id` against the caller's own signed identity — which only
 * touches the `Order` object already covered by the `read_orders` scope this
 * app holds (the same field the sibling adapter already reads under that
 * scope). If a future slice genuinely needs "list all of this customer's
 * orders" (e.g. an order picker with no typed-in number), that is a new
 * scope request for the owner, not something to route around here.
 *
 * MINIMAL FIELD SET, DELIBERATELY. No fulfillment/payment/financial status,
 * no pricing or cost data (CLAUDE.md rule 10) — only what identifies the
 * order/line items for a claim: id, name, email, customer id (both compared
 * server-side only, never returned to the caller), and per-line
 * id/title/quantity.
 *
 * `findOrderByGid` WAS REMOVED, 2026-09-26 (architect decision on the
 * guest-flow retirement). It existed only to re-resolve an order fresh from
 * Shopify after a guest verification token was redeemed
 * (`apps.carat.warranty-order-verify.tsx`, now deleted) and had zero
 * remaining application callers. `order(id:)`'s shape is still
 * live-introspected and used — by `warrantyClaimOrderLookupAdapter.server.ts`,
 * which resolves a claim's orderRef/lineRef GIDs at submission time and is
 * unaffected by this file's retirement.
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

interface RawOrderNode {
  id: string;
  name: string;
  email: string | null;
  customer: { id: string } | null;
  lineItems?: { nodes?: { id: string; name: string; quantity: number }[] };
}

function toSummary(order: RawOrderNode): WarrantyOrderLookupSummary {
  return {
    orderGid: order.id,
    orderName: order.name,
    customerGid: order.customer?.id ?? null,
    orderEmail: order.email,
    lineItems: (order.lineItems?.nodes ?? []).map((node) => ({
      lineRef: node.id,
      title: node.name,
      quantity: node.quantity,
    })),
  };
}

export interface WarrantyOrderLookupLineItem {
  readonly lineRef: string;
  readonly title: string;
  readonly quantity: number;
}

export interface WarrantyOrderLookupSummary {
  readonly orderGid: string;
  readonly orderName: string;
  readonly customerGid: string | null;
  readonly orderEmail: string | null;
  readonly lineItems: readonly WarrantyOrderLookupLineItem[];
}

export interface WarrantyOrderLookupPort {
  /** Resolves an order by its customer-facing name (e.g. "#1001"). `null` if no such order exists. */
  findOrderByName(orderName: string): Promise<WarrantyOrderLookupSummary | null>;
}

const ORDER_FIELDS = `
  id
  name
  email
  customer { id }
  lineItems(first: 250) {
    nodes { id name quantity }
  }
`;

const ORDER_BY_NAME_QUERY = `#graphql
  query CaratWarrantyOrderLookupByName($searchQuery: String!) {
    orders(first: 1, query: $searchQuery) {
      nodes { ${ORDER_FIELDS} }
    }
  }`;

export class ShopifyWarrantyOrderLookupAdapter implements WarrantyOrderLookupPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async findOrderByName(orderName: string): Promise<WarrantyOrderLookupSummary | null> {
    const data = await execute(this.client, "warrantyOrderLookupByName", ORDER_BY_NAME_QUERY, {
      searchQuery: `name:${orderName}`,
    });
    const orders = data.orders as { nodes?: RawOrderNode[] } | undefined;
    const order = orders?.nodes?.[0];
    return order ? toSummary(order) : null;
  }
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingWarrantyOrderLookupPort implements WarrantyOrderLookupPort {
  readonly byNameCalls: string[] = [];
  /** Keyed by order NAME (e.g. "#1001"). */
  readonly byName = new Map<string, WarrantyOrderLookupSummary>();

  seedByName(orderName: string, summary: Omit<WarrantyOrderLookupSummary, "orderName">): void {
    const full: WarrantyOrderLookupSummary = { ...summary, orderName };
    this.byName.set(orderName, full);
  }

  async findOrderByName(orderName: string): Promise<WarrantyOrderLookupSummary | null> {
    this.byNameCalls.push(orderName);
    return this.byName.get(orderName) ?? null;
  }
}
