import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import type { GroupBuyParticipantEmailLookupPort } from "~/jobs/groupbuy/milestoneNotificationSweep.server";

/**
 * Resolves the contact email for a Card-basis Group Buy participant.
 *
 * ============================================================================
 * WHY THIS EXISTS AT ALL
 * ============================================================================
 * A Bank Payment participant's address is stored locally —
 * `GroupBuyBankPaymentOrder.customerEmail`, captured at checkout. A Card
 * participant's is not: `GroupBuyUnitEvent` records `orderRef` and `lineRef`
 * and deliberately carries NO customer identity, because the unit ledger is a
 * counting structure and storing a second copy of customer PII in it would be
 * both a privacy cost and a source of drift.
 *
 * So Shopify's own order record is the only authoritative source for a Card
 * participant's email — the same "Shopify stays authoritative" principle
 * `rmaOrderLookupAdapter.server.ts` and
 * `groupBuySettlementOrderLookupAdapter.server.ts` already apply, and the
 * reason this is a lookup rather than a new column.
 *
 * A PURE READ. No mutation, no money. Uses the already-granted `read_orders`
 * scope; it requests NOTHING beyond the order's own email, so it does not
 * widen the app's access to customer records.
 *
 * `order.email` is read rather than `customer.email`: the order address is the
 * one the customer actually transacted under, and a guest checkout has no
 * `customer` at all. A null here is a real outcome (guest order with no email
 * on file), not an error — the sweep records it as unresolved and carries on
 * rather than failing the whole campaign's notification.
 *
 * CONFIDENCE GRADING. This query has not been independently live-introspected
 * against the real store in this pass. `order { id email }` is long-stable and
 * `rmaOrderLookupAdapter.server.ts` already reads exactly this field the same
 * way, so the risk is low, but it carries the same caveat that adapter does.
 */

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

const ORDER_EMAIL_LOOKUP_QUERY = `#graphql
  query CaratGroupBuyParticipantEmail($id: ID!) {
    order(id: $id) {
      id
      email
    }
  }`;

export class ShopifyGroupBuyParticipantEmailAdapter implements GroupBuyParticipantEmailLookupPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async resolveOrderEmail(orderGid: string): Promise<string | null> {
    const response = await this.client.graphql(ORDER_EMAIL_LOOKUP_QUERY, { variables: { id: orderGid } });
    const body = (await response.json()) as GraphqlEnvelope;
    if (body.errors?.length) {
      throw new AdminApiError(
        "groupBuyParticipantEmailLookup",
        body.errors.map((e) => e.message)
      );
    }
    if (!body.data) {
      throw new AdminApiError("groupBuyParticipantEmailLookup", ["response contained no data"]);
    }

    const order = body.data.order as { id: string; email: string | null } | null;
    // A deleted or inaccessible order is unresolved, not fatal.
    if (!order) return null;
    const email = order.email?.trim();
    return email ? email : null;
  }
}

/** Returns pre-seeded addresses and records calls. Tests only. */
export class RecordingGroupBuyParticipantEmailPort implements GroupBuyParticipantEmailLookupPort {
  readonly calls: string[] = [];
  private readonly results = new Map<string, string | null>();
  private readonly failures = new Map<string, Error>();

  /**
   * Seeding a result CLEARS any seeded failure for the same order, because
   * "this order resolves to X now" is the only thing a caller can mean. The
   * first version kept both and checked failures first, so a test that
   * seeded a failure, then recovered the order, silently kept throwing — and
   * the resulting red looked like the sweep failing to retry rather than the
   * fake refusing to heal.
   */
  seed(orderGid: string, email: string | null): void {
    this.failures.delete(orderGid);
    this.results.set(orderGid, email);
  }

  seedFailure(orderGid: string, error: Error): void {
    this.results.delete(orderGid);
    this.failures.set(orderGid, error);
  }

  async resolveOrderEmail(orderGid: string): Promise<string | null> {
    this.calls.push(orderGid);
    const failure = this.failures.get(orderGid);
    if (failure) throw failure;
    return this.results.get(orderGid) ?? null;
  }
}
