import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * Order-by-human-number lookup for D33 (docs/ARCHITECTURE-MVP1.md, the
 * warranty claim order-lookup flow). Distinct from
 * `warrantyClaimOrderLookupAdapter.server.ts`, which resolves a Shopify GID
 * the CALLER already has — this file exists because a real customer never
 * has a GID, only the order number Shopify shows them (e.g. "#1001").
 *
 * CONFIDENCE GRADING (same convention as the twin file's own header,
 * `luxuryStealOrderReviewAdapter.server.ts`'s introspection note). The
 * `orders(first:, query:)` search-filter shape and the `name:` search
 * keyword are long-documented, stable Admin API surface, but — like
 * `warrantyClaimOrderLookupAdapter.server.ts` — NOT independently
 * live-introspected against a real store in this pass (no store credentials
 * available). Flagged for the architect/QA to live-verify against
 * caratforus-dev before this is wired to a live storefront form, same as
 * that twin file's own flag.
 *
 * SCOPE DISCIPLINE — READ BEFORE CHANGING THE QUERIES BELOW. This
 * deliberately does NOT query `customer(id:).orders(...)` (a "list every
 * order for this customer" shape), because that root-level `customer` field
 * access is believed to require the `read_customers` scope, which this app
 * does not hold and CLAUDE.md/D33's assigning message both forbid silently
 * requesting. Instead, the logged-in flow (see
 * `apps.carat.warranty-order-lookup.tsx`) works the same way the guest flow
 * does — look the order up by the NUMBER the customer supplies, then check
 * `order.customer.id` against the caller's own signed identity — which only
 * touches the `Order` object already covered by the `read_orders` scope
 * this app holds (the same field the sibling adapter already reads under
 * that scope). If a future slice genuinely needs "list all of this
 * customer's orders" (e.g. an order picker with no typed-in number), that is
 * a new scope request for the owner, not something to route around here.
 *
 * MINIMAL FIELD SET, DELIBERATELY. No fulfillment/payment/financial status,
 * no pricing or cost data (CLAUDE.md rule 10) — only what identifies the
 * order/line items for a claim: id, name, email (compared server-side only,
 * never returned to a guest caller), customer id (compared server-side
 * only), and per-line id/title/quantity.
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
  /** Re-resolves a previously-seen order by GID — used after a guest verification token is redeemed, so line items are always read fresh rather than trusted from what was true when the lookup was first requested. */
  findOrderByGid(orderGid: string): Promise<WarrantyOrderLookupSummary | null>;
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

const ORDER_BY_GID_QUERY = `#graphql
  query CaratWarrantyOrderLookupByGid($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
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

  async findOrderByGid(orderGid: string): Promise<WarrantyOrderLookupSummary | null> {
    const data = await execute(this.client, "warrantyOrderLookupByGid", ORDER_BY_GID_QUERY, { id: orderGid });
    const order = data.order as RawOrderNode | null;
    return order ? toSummary(order) : null;
  }
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingWarrantyOrderLookupPort implements WarrantyOrderLookupPort {
  readonly byNameCalls: string[] = [];
  readonly byGidCalls: string[] = [];
  /** Keyed by order NAME (e.g. "#1001"). */
  readonly byName = new Map<string, WarrantyOrderLookupSummary>();
  /** Keyed by order GID — seeded automatically alongside `seedByName`, but can be seeded/overridden independently to simulate the order having changed between request and redemption. */
  readonly byGid = new Map<string, WarrantyOrderLookupSummary>();

  seedByName(orderName: string, summary: Omit<WarrantyOrderLookupSummary, "orderName">): void {
    const full: WarrantyOrderLookupSummary = { ...summary, orderName };
    this.byName.set(orderName, full);
    this.byGid.set(full.orderGid, full);
  }

  async findOrderByName(orderName: string): Promise<WarrantyOrderLookupSummary | null> {
    this.byNameCalls.push(orderName);
    return this.byName.get(orderName) ?? null;
  }

  async findOrderByGid(orderGid: string): Promise<WarrantyOrderLookupSummary | null> {
    this.byGidCalls.push(orderGid);
    return this.byGid.get(orderGid) ?? null;
  }
}
