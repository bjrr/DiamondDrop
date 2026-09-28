import { Money } from "~/domain/money/money";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import type { GroupBuySettlementOrderLookupPort } from "~/jobs/groupbuy/campaignSettlement.server";

/**
 * Read-only order/line-price resolution for Group Buy settlement's Card-basis
 * lines (`app/jobs/groupbuy/campaignSettlement.server.ts`'s own header
 * explains WHY this exists: a Bank Payment line's price is already stored;
 * a Card line's is not, so Shopify's own order record is the only
 * authoritative source — D7-style "Shopify stays authoritative", the same
 * principle `rmaOrderLookupAdapter.server.ts` and
 * `warrantyClaimOrderLookupAdapter.server.ts` already apply).
 *
 * A PURE READ. This file issues no mutation and moves no money — it only
 * asks Shopify what a line's discounted per-unit price was. Mirrors
 * `rmaOrderLookupAdapter.server.ts`'s exact shape and its own "not
 * independently live-introspected" caveat below, which is the appropriate
 * confidence bar for a read (contrast the higher bar
 * `rmaRemedyExecutionAdapter.server.ts` sets for itself because THAT file
 * moves money).
 *
 * CONFIDENCE GRADING. The query below has NOT been independently
 * live-introspected against a real store in this pass (no store credentials
 * were available in this session). Flag for an architect/QA introspection
 * pass before this resolves a real settlement's Card-basis lines — the same
 * caveat `rmaOrderLookupAdapter.server.ts` carries for the identical reason.
 *
 * PER-UNIT, NOT PER-LINE TOTAL. `discountedUnitPriceSet` (post line-level
 * discount, pre-tax — same "excludes tax" boundary D29/D7 already establish)
 * is read directly rather than dividing a line total by quantity, which
 * would reintroduce a rounding question this codebase's money rules exist to
 * avoid.
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

const ORDER_LINE_PRICE_LOOKUP_QUERY = `#graphql
  query CaratGroupBuySettlementOrderLookup($id: ID!) {
    order(id: $id) {
      id
      customer { id }
      lineItems(first: 250) {
        nodes {
          id
          discountedUnitPriceSet {
            shopMoney { amount currencyCode }
          }
        }
      }
    }
  }`;

export class ShopifyGroupBuySettlementOrderLookupAdapter implements GroupBuySettlementOrderLookupPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async resolveLinePaidPrice(input: {
    orderGid: string;
    lineItemGid: string;
  }): Promise<{ paidPerUnitMinorUnits: bigint; currency: string; customerGid: string | null } | null> {
    const data = await execute(this.client, "groupBuySettlementOrderLookup", ORDER_LINE_PRICE_LOOKUP_QUERY, {
      id: input.orderGid,
    });
    const order = data.order as
      | {
          id: string;
          customer: { id: string } | null;
          lineItems?: {
            nodes?: { id: string; discountedUnitPriceSet?: { shopMoney?: { amount: string; currencyCode: string } } }[];
          };
        }
      | null;
    if (!order) return null;

    const lineItem = order.lineItems?.nodes?.find((node) => node.id === input.lineItemGid);
    if (!lineItem) return null;

    const shopMoney = lineItem.discountedUnitPriceSet?.shopMoney;
    if (!shopMoney) {
      // Cannot represent cleanly — refuse rather than guess a price of zero.
      throw new AdminApiError("groupBuySettlementOrderLookup", [
        `line item ${input.lineItemGid} has no discountedUnitPriceSet.shopMoney`,
      ]);
    }

    const paidPerUnit = Money.fromDecimalMajorUnits(shopMoney.amount, shopMoney.currencyCode, DEFAULT_ROUNDING_RULE_ID);

    return {
      paidPerUnitMinorUnits: paidPerUnit.amountMinorUnits,
      currency: paidPerUnit.currency,
      customerGid: order.customer?.id ?? null,
    };
  }
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingGroupBuySettlementOrderLookupPort implements GroupBuySettlementOrderLookupPort {
  readonly calls: { orderGid: string; lineItemGid: string }[] = [];
  readonly results = new Map<string, { paidPerUnitMinorUnits: bigint; currency: string; customerGid: string | null }>();

  seed(
    orderGid: string,
    lineItemGid: string,
    result: { paidPerUnitMinorUnits: bigint; currency: string; customerGid?: string | null }
  ): void {
    this.results.set(`${orderGid}::${lineItemGid}`, { customerGid: null, ...result });
  }

  async resolveLinePaidPrice(input: {
    orderGid: string;
    lineItemGid: string;
  }): Promise<{ paidPerUnitMinorUnits: bigint; currency: string; customerGid: string | null } | null> {
    this.calls.push(input);
    return this.results.get(`${input.orderGid}::${input.lineItemGid}`) ?? null;
  }
}
