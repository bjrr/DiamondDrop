import { Money } from "~/domain/money/money";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * Order/line resolution for Buy Now RMA intake (Slice 4 task, docs/specs/
 * SLICE-4-BUY-NOW-RMA.md criteria 180-181, 189-191). Mirrors
 * `warrantyClaimOrderLookupAdapter.server.ts` closely — see that module's
 * own header for the shared reasoning this one does not repeat — but adds
 * ONE thing the warranty lookup never needed: the line's own
 * merchandise-only amount, because criterion 189-191's remedy computation
 * requires an authoritative `eligibleMerchandiseAmountMinorUnits` that this
 * codebase computes, never one a customer-facing request could supply
 * itself (CLAUDE.md's "server decides" discipline).
 *
 * CONFIDENCE GRADING — same convention as
 * `warrantyClaimOrderLookupAdapter.server.ts`'s own header. The query below
 * has NOT been independently live-introspected against a real store in this
 * pass (no store credentials were available). Flag for the same
 * architect/QA introspection pass before this route serves live storefront
 * traffic.
 *
 * MERCHANDISE-ONLY, BY CONSTRUCTION. `discountedTotalSet` on a Shopify
 * `LineItem` is the line's total after line-level discounts and BEFORE tax
 * — the same "excludes tax, shipping, duties" definition D29 established
 * for shipment merchandise value (`app/domain/shipping/merchandiseValue.ts`),
 * applied here to the returned line. This adapter never reads
 * `totalDiscountSet`, `taxLines`, or anything shipping-adjacent — there is
 * nothing in this file to compute a tax figure from, which is exactly D7's
 * boundary (see `app/domain/rma/remedy.ts`'s header).
 *
 * NO CUSTOMER-OWNERSHIP VERIFICATION beyond returning `customerGid`/
 * `orderEmail` for the caller to compare — same boundary as the warranty
 * adapter; deeper verification belongs to the calling route and, more
 * substantively, staff review before approval.
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
  query CaratRmaOrderLookup($id: ID!) {
    order(id: $id) {
      id
      name
      email
      customer { id }
      lineItems(first: 250) {
        nodes {
          id
          discountedTotalSet {
            shopMoney { amount currencyCode }
          }
        }
      }
    }
  }`;

export interface RmaOrderLookupResult {
  readonly orderGid: string;
  readonly orderName: string;
  readonly customerGid: string | null;
  readonly orderEmail: string | null;
  readonly lineItemGid: string;
  /** Criterion 189-191 — merchandise-only, excludes tax (see this module's header). Never customer-supplied. */
  readonly eligibleMerchandiseAmountMinorUnits: bigint;
  readonly eligibleMerchandiseAmountCurrency: string;
}

export interface RmaOrderLookupPort {
  /**
   * Resolves an order + one of its line items, along with that line's
   * merchandise-only (post-discount, pre-tax) amount. Returns `null` if the
   * order does not exist, OR exists but carries no line item with this id —
   * criterion 181's exact refusal condition, collapsed to one signal so the
   * route cannot accidentally treat "order missing" and "line missing" as
   * different outcomes (mirrors `WarrantyClaimOrderLookupPort`).
   */
  resolveOrderLine(input: { orderGid: string; lineItemGid: string }): Promise<RmaOrderLookupResult | null>;
}

export class ShopifyRmaOrderLookupAdapter implements RmaOrderLookupPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async resolveOrderLine(input: { orderGid: string; lineItemGid: string }): Promise<RmaOrderLookupResult | null> {
    const data = await execute(this.client, "rmaOrderLookup", ORDER_LINE_LOOKUP_QUERY, { id: input.orderGid });
    const order = data.order as
      | {
          id: string;
          name: string;
          email: string | null;
          customer: { id: string } | null;
          lineItems?: {
            nodes?: {
              id: string;
              discountedTotalSet?: { shopMoney?: { amount: string; currencyCode: string } };
            }[];
          };
        }
      | null;
    if (!order) return null;

    const lineItem = order.lineItems?.nodes?.find((node) => node.id === input.lineItemGid);
    if (!lineItem) return null;

    const shopMoney = lineItem.discountedTotalSet?.shopMoney;
    if (!shopMoney) {
      // A line item Shopify cannot represent cleanly — same D7 fail-closed
      // instinct as the remedy layer's staff_review_required state, but at
      // the resolution boundary: refuse rather than guess a merchandise
      // amount of zero or omit currency.
      throw new AdminApiError("rmaOrderLookup", [
        `line item ${input.lineItemGid} has no discountedTotalSet.shopMoney`,
      ]);
    }

    const eligibleMerchandiseAmount = Money.fromDecimalMajorUnits(
      shopMoney.amount,
      shopMoney.currencyCode,
      DEFAULT_ROUNDING_RULE_ID
    );

    return {
      orderGid: order.id,
      orderName: order.name,
      customerGid: order.customer?.id ?? null,
      orderEmail: order.email,
      lineItemGid: input.lineItemGid,
      eligibleMerchandiseAmountMinorUnits: eligibleMerchandiseAmount.amountMinorUnits,
      eligibleMerchandiseAmountCurrency: eligibleMerchandiseAmount.currency,
    };
  }
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingRmaOrderLookupPort implements RmaOrderLookupPort {
  readonly calls: { orderGid: string; lineItemGid: string }[] = [];
  /** Key `${orderGid}::${lineItemGid}` -> result. An unseeded combination resolves to `null` (unresolved), matching a real "not found" order/line. */
  readonly results = new Map<string, RmaOrderLookupResult>();

  seed(orderGid: string, lineItemGid: string, result: Omit<RmaOrderLookupResult, "orderGid" | "lineItemGid">): void {
    this.results.set(`${orderGid}::${lineItemGid}`, { ...result, orderGid, lineItemGid });
  }

  async resolveOrderLine(input: { orderGid: string; lineItemGid: string }): Promise<RmaOrderLookupResult | null> {
    this.calls.push(input);
    return this.results.get(`${input.orderGid}::${input.lineItemGid}`) ?? null;
  }
}
