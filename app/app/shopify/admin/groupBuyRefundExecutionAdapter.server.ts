import type { AdminGraphqlClient } from "./productClient.server";

/**
 * `GroupBuyRefundExecutionPort` — the seam `app/jobs/groupbuy/
 * executeGroupBuyRefund.server.ts` calls to actually move money for a Group
 * Buy tier-adjustment refund. Deliberately narrow: ONE question ("refund this
 * exact amount against this order/line's original payment method"), no
 * proportion or tax computed here, same division of labour as
 * `rmaRemedyExecutionAdapter.server.ts`.
 *
 * ============================================================================
 * WHY THE PRODUCTION ADAPTER BELOW DOES NOT YET CALL SHOPIFY — flagged for
 * architect design + live schema introspection before this executes against
 * a real store. THIS IS THE ONE MONEY-CRITICAL JUDGEMENT CALL THIS TASK
 * DELIBERATELY DID NOT RESOLVE UNILATERALLY.
 * ============================================================================
 * A Group Buy tier-adjustment refund returns NO merchandise: the customer
 * keeps 100% of what they bought, and only a PRICE DIFFERENCE moves back to
 * them. `rmaRemedyExecutionAdapter.server.ts`'s `createRefund` — the obvious
 * candidate to reuse — is schema-confirmed to call `refundCreate` with
 * `refundLineItems: [{ lineItemId, quantity: lineItem.refundableQuantity }]`,
 * which is Shopify's shape for "this quantity of this line was RETURNED":
 * inventory restock behaviour and "refunded quantity" order accounting are
 * attached to it. Reusing that as-is would tell Shopify the customer
 * returned merchandise they did not return — wrong for accounting, wrong for
 * any future RMA/warranty claim on the same line (its remaining refundable
 * quantity would already read as partially consumed), and exactly the kind
 * of transaction-evidence corruption CLAUDE.md's "preserve transaction
 * evidence" rule exists to prevent.
 *
 * The correct Shopify shape for a pure price adjustment with no line-item
 * return is most likely `RefundInput.orderAdjustments` (an
 * `OrderAdjustmentInput` reason such as a promotion/compensation adjustment)
 * alongside a `transactions` entry for the money — NOT `refundLineItems`.
 * That has NOT been verified against a live store's schema in this pass (no
 * store credentials were available), and this codebase's own established bar
 * for a MONEY-MOVING mutation (see `rmaRemedyExecutionAdapter.server.ts`'s
 * own header, and `tests/live/slice4.rmaRemedyExecutionSchemaIntrospection.ts`)
 * is live introspection BEFORE the shape is trusted, not a guess reviewed
 * only by this comment. Guessing wrong here would either fail loudly
 * (survivable) or succeed while mis-recording a return that never happened
 * (not survivable — it corrupts Shopify's own order/inventory record).
 *
 * WHAT THIS FILE DELIVERS INSTEAD: the full state machine, idempotency
 * wrapper, and error classification in `executeGroupBuyRefund.server.ts` are
 * real, tested (via `RecordingGroupBuyRefundExecutionPort` below), and ready
 * to receive a verified adapter the moment the correct mutation shape is
 * confirmed. `ShopifyGroupBuyRefundExecutionAdapter.createTierAdjustmentRefund`
 * below refuses outright rather than call an unverified mutation — a staff
 * member processes the refund directly in Shopify Admin today and records
 * the result via the campaign route's manual "Record refund result"
 * action (the same fallback `app.rma.$id.tsx`'s `update_remedy_status`
 * already establishes for its own D7 staff-review cases).
 */

export interface GroupBuyRefundExecutionPort {
  /** Refunds the EXACT amount supplied against the order's original payment method, without touching line-item quantity/restock accounting. */
  createTierAdjustmentRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }>;
}

export class GroupBuyRefundExecutionNotImplementedError extends Error {
  constructor() {
    super(
      "Automated Shopify execution for Group Buy tier-adjustment refunds is not yet implemented " +
        "(unverified mutation shape — see this adapter's own header). Process this refund directly " +
        "in Shopify Admin, then record the result via the campaign settlement page's " +
        "'Record refund result' action."
    );
    this.name = "GroupBuyRefundExecutionNotImplementedError";
  }
}

/**
 * Deliberately refuses every call — see this file's header. Constructed the
 * same way every other production adapter in this codebase is
 * (`new ShopifyGroupBuyRefundExecutionAdapter(admin)`), so wiring it in later
 * (once the mutation shape is verified) requires no change to the calling
 * route or job, only to this class's body.
 */
export class ShopifyGroupBuyRefundExecutionAdapter implements GroupBuyRefundExecutionPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async createTierAdjustmentRefund(): Promise<{ reference: string }> {
    // `this.client` is unused until the mutation shape above is verified —
    // kept as a constructor parameter (not dropped) so wiring in the real
    // call later needs no change to how callers construct this adapter.
    void this.client;
    throw new GroupBuyRefundExecutionNotImplementedError();
  }
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingGroupBuyRefundExecutionPort implements GroupBuyRefundExecutionPort {
  readonly calls: { orderGid: string; lineItemGid: string; totalAmountMinorUnits: bigint; currency: string }[] = [];

  result: { reference: string } = { reference: "groupbuy-refund-fixture" };
  error: Error | null = null;

  async createTierAdjustmentRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.result;
  }
}
