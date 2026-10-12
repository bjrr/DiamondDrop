import { minorUnitsToDecimalString } from "./priceSyncAdapter.server";
import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * `GroupBuyRefundExecutionPort` — the seam `app/jobs/groupbuy/
 * executeGroupBuyRefund.server.ts` calls to actually move money for a Group
 * Buy tier-adjustment refund. Deliberately narrow: ONE question ("refund this
 * exact amount against this order's original payment"), no proportion and no
 * tax computed here, same division of labour as
 * `rmaRemedyExecutionAdapter.server.ts`.
 *
 * THE AMOUNT IS NEVER RECALCULATED HERE. It arrives already computed and
 * staff-approved from `refundLedger.server.ts`, which is the single business
 * -logic authority. This adapter transports and verifies a decided figure.
 *
 * ============================================================================
 * A TIER ADJUSTMENT IS A PRICE ADJUSTMENT, NOT A MERCHANDISE RETURN
 * ============================================================================
 * The customer keeps 100% of what they bought; only a price difference moves
 * back to them. `rmaRemedyExecutionAdapter`'s `createRefund` — the obvious
 * candidate to reuse — sends
 * `refundLineItems: [{ lineItemId, quantity: refundableQuantity }]`, which is
 * Shopify's shape for "this quantity of this line was RETURNED": inventory
 * restock behaviour and refunded-quantity order accounting attach to it.
 * Reusing it would tell Shopify the customer returned merchandise they still
 * have — wrong for accounting, wrong for any later RMA or warranty claim on
 * the same line (its remaining refundable quantity would already read as
 * partly consumed), and exactly the transaction-evidence corruption
 * `CLAUDE.md`'s "preserve transaction evidence" rule exists to prevent.
 *
 * ============================================================================
 * THE SHAPE, RESOLVED BY LIVE INTROSPECTION (2026-10-12, caratforus-dev)
 * ============================================================================
 * `tests/live/slice6.groupBuyRefundExecutionSchemaIntrospection.ts` passed
 * against the real store. What it established, as facts rather than as the
 * hypothesis this file previously carried:
 *
 *   `RefundInput.refundLineItems` is OPTIONAL (not NON_NULL), so omitting it
 *   entirely is a legal input. That is the whole basis of this adapter: a
 *   refund with no returned merchandise is expressible, and nothing has to be
 *   fabricated to satisfy the API.
 *
 *   `RefundInput.transactions: [OrderTransactionInput!]` is the monetary path.
 *   `OrderTransactionInput` REQUIRES `amount: Money!`, `gateway: String!`,
 *   `kind: OrderTransactionKind!` and `orderId: ID!`, with `parentId: ID`
 *   optional. `OrderTransactionKind` includes `REFUND`.
 *
 *   THE PREVIOUS HYPOTHESIS WAS WRONG, and it is worth recording. This file
 *   used to say the correct shape was "most likely
 *   `RefundInput.orderAdjustments`". There is NO `orderAdjustments` field on
 *   `RefundInput` at all. Had the adapter been written from that guess it
 *   would have failed outright — which is the survivable outcome, but only by
 *   luck.
 *
 * `discrepancyReason` offers exactly RESTOCK, DAMAGE, CUSTOMER, OTHER. This
 * adapter sends OTHER: nothing was restocked, nothing was damaged, and the
 * refund is not the customer's doing — a campaign unlocked a better price and
 * we owe them the difference. The `note` carries the campaign and line
 * reference, so the real reason is recoverable from the order itself.
 *
 * ============================================================================
 * WHAT IS NEVER SENT, SO IT CANNOT BE INCLUDED BY ACCIDENT
 * ============================================================================
 * `refundLineItems`, `shipping`, `refundDuties`. Not set to empty — ABSENT
 * from the input object, so no code path in this file can populate them. The
 * owner's boundary is that a tier adjustment refunds the approved merchandise
 * difference and nothing else: no shipping, no tax, no duties, no tips.
 *
 * `notify` is false. A Shopify-composed refund email is wording nobody has
 * approved, and customer communication about a Group Buy settlement is ours.
 *
 * ============================================================================
 * WHY A POST-SUCCESS FAILURE MUST NOT BE AN `AdminApiError`
 * ============================================================================
 * `executeGroupBuyRefund`'s classifier reads `AdminApiError` as `failed`,
 * which is RETRYABLE — correct for a definitive rejection, because a rejected
 * mutation moved no money. But the echo verification below runs AFTER Shopify
 * has accepted the refund. A mismatch there, or a network failure while
 * reading back, must never be classified `failed`: that would mark the refund
 * failed and make it eligible for a SECOND, DUPLICATE refund of money that
 * has already left.
 *
 * So every failure path after the mutation succeeds throws
 * `GroupBuyRefundEchoMismatchError`, which is NOT an `AdminApiError` and
 * therefore classifies as `in_doubt` — the refund stays `processing` and a
 * person reconciles it. Fails closed to staff review, as the owner requires.
 */

export interface GroupBuyRefundExecutionPort {
  /** Refunds the EXACT amount supplied against the order's original payment, without touching line-item quantity/restock accounting. */
  createTierAdjustmentRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }>;
}

/**
 * Retained so the manual fallback's error message and the classifier's
 * reasoning still have a type to name. NO LONGER THROWN by the production
 * adapter — kept because `executeGroupBuyRefund`'s classifier references it,
 * and removing it would silently change that classification for any caller
 * still constructing it.
 */
export class GroupBuyRefundExecutionNotImplementedError extends Error {
  constructor() {
    super(
      "Automated Shopify execution for Group Buy tier-adjustment refunds is not available in this " +
        "configuration. Process this refund directly in Shopify Admin, then record the result via the " +
        "campaign settlement page's 'Record refund result' action."
    );
    this.name = "GroupBuyRefundExecutionNotImplementedError";
  }
}

/**
 * Shopify accepted the refund, and the independent read-back disagreed with
 * what we asked for — or could not be completed at all.
 *
 * DELIBERATELY NOT AN `AdminApiError`. See this file's header: money has
 * already moved by the time this is thrown, so it must classify `in_doubt`
 * and route to a person, never `failed` and become retryable.
 */
export class GroupBuyRefundEchoMismatchError extends Error {
  constructor(
    readonly refundGid: string | null,
    readonly problems: readonly string[]
  ) {
    super(
      `Group Buy refund ${refundGid ?? "(no id returned)"} was ACCEPTED by Shopify but the independent ` +
        `read-back disagreed: ${problems.join("; ")}. Money may have moved. Do NOT retry — reconcile the ` +
        `order in Shopify first.`
    );
    this.name = "GroupBuyRefundEchoMismatchError";
  }
}

/**
 * The order's refundable payment, and what has already been refunded against
 * it.
 *
 * `transactions` and `refunds` are plain LISTS on `Order` (not connections) —
 * confirmed by introspection, not assumed.
 */
const ORDER_REFUND_CONTEXT_QUERY = `#graphql
  query CaratGroupBuyRefundContext($id: ID!) {
    order(id: $id) {
      id
      name
      test
      currencyCode
      totalRefundedSet { shopMoney { amount currencyCode } }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        test
        amountSet { shopMoney { amount currencyCode } }
        maximumRefundableV2 { amount currencyCode }
      }
    }
  }`;

/**
 * NO `refundLineItems`, NO `shipping`, NO `refundDuties` in the input object
 * below — see the header. The response asks for everything the echo check
 * needs, but the echo check does NOT use it: it re-reads in a SEPARATE query,
 * because a value echoed by the mutation that created it proves only that
 * Shopify received the request, not that it persisted the result.
 */
const REFUND_CREATE_MUTATION = `#graphql
  mutation CaratGroupBuyTierAdjustmentRefund($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        totalRefundedSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }`;

/** The independent read-back. Every field here answers one of the owner's echo checks. */
const REFUND_READ_BACK_QUERY = `#graphql
  query CaratGroupBuyRefundReadBack($id: ID!) {
    refund(id: $id) {
      id
      note
      order { id }
      totalRefundedSet { shopMoney { amount currencyCode } }
      # EMPTY is the assertion. A tier adjustment returns no merchandise, so a
      # single node here means something was recorded as returned.
      refundLineItems(first: 10) {
        nodes { quantity restocked restockType lineItem { id } }
      }
      # Also expected empty: the owner's boundary forbids refunding shipping
      # unless the settlement explicitly calls for it, and this adapter never
      # sends a shipping input at all.
      refundShippingLines(first: 10) { nodes { id } }
      duties { amountSet { shopMoney { amount } } }
      transactions(first: 10) {
        nodes {
          id
          kind
          status
          gateway
          test
          amountSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }`;

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

/** A MoneyBag/Money decimal string to integer minor units, or null if unreadable. */
function moneyToMinorUnits(amount: string | null | undefined): bigint | null {
  if (amount === null || amount === undefined) return null;
  const cleaned = amount.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [whole, fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -magnitude : magnitude;
}

interface OrderTransactionNode {
  id: string;
  kind: string;
  status: string;
  gateway: string | null;
  test: boolean;
  amountSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
  maximumRefundableV2?: { amount: string; currencyCode: string } | null;
}

export class ShopifyGroupBuyRefundExecutionAdapter implements GroupBuyRefundExecutionPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async createTierAdjustmentRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }> {
    // ========================================================================
    // EVERY REFUSAL IN THIS SECTION HAPPENS BEFORE THE MUTATION
    // ========================================================================
    // So they all throw `AdminApiError`, which classifies `failed` — correct,
    // because no money moved and a corrected attempt is safe.
    if (input.totalAmountMinorUnits <= 0n) {
      throw new AdminApiError("refundCreate", [
        `refusing to refund ${input.totalAmountMinorUnits} minor units; a tier adjustment refund must be positive`,
      ]);
    }

    const context = await this.loadOrderContext(input.orderGid);

    if (context.order.currencyCode.toUpperCase() !== input.currency.toUpperCase()) {
      throw new AdminApiError("refundCreate", [
        `the approved refund is in ${input.currency} but order ${context.order.name} is in ` +
          `${context.order.currencyCode}; refusing rather than converting a figure staff approved`,
      ]);
    }

    const parent = selectRefundableParent(context.order.transactions);
    if (!parent) {
      throw new AdminApiError("refundCreate", [
        `order ${context.order.name} has no successful SALE or CAPTURE transaction to refund against. ` +
          `Its transactions are: ` +
          (context.order.transactions.map((t) => `${t.kind}/${t.status}`).join(", ") || "(none)"),
      ]);
    }

    // PREVIOUSLY REFUNDED AMOUNTS ARE RESPECTED. `maximumRefundableV2` is
    // Shopify's own answer to "how much is still refundable against this
    // transaction", so it already accounts for earlier refunds. Checked here,
    // before the call, because exceeding it is a definitive refusal rather
    // than something to discover from an error string.
    const maximumRefundable = moneyToMinorUnits(parent.maximumRefundableV2?.amount);
    if (maximumRefundable !== null && input.totalAmountMinorUnits > maximumRefundable) {
      throw new AdminApiError("refundCreate", [
        `the approved refund of ${input.totalAmountMinorUnits} minor units exceeds the ` +
          `${maximumRefundable} still refundable against transaction ${parent.id} ` +
          `(earlier refunds already consumed the rest)`,
      ]);
    }

    const amountDecimalString = minorUnitsToDecimalString(input.totalAmountMinorUnits);

    const variables = {
      input: {
        orderId: input.orderGid,
        currency: input.currency.toUpperCase(),
        // The real reason, recoverable from the order itself rather than only
        // from our database.
        note:
          `CaratForUs Group Buy tier adjustment — price difference refunded for line ` +
          `${input.lineItemGid}. No merchandise returned.`,
        // Customer communication about a Group Buy settlement is ours. A
        // Shopify-composed refund email is wording nobody approved.
        notify: false,
        // NOTHING WAS RESTOCKED, DAMAGED, OR THE CUSTOMER'S DOING. See header.
        discrepancyReason: "OTHER",
        // THE MONETARY PATH. `refundLineItems` is absent, not empty.
        transactions: [
          {
            orderId: input.orderGid,
            parentId: parent.id,
            // Must match the parent's gateway, or Shopify refunds against a
            // tender that did not pay.
            gateway: parent.gateway ?? "",
            kind: "REFUND",
            amount: amountDecimalString,
          },
        ],
      },
    };

    // ========================================================================
    // THE MUTATION. A network throw from here is NOT an AdminApiError, so it
    // classifies `in_doubt` — correct, because the request may have reached
    // Shopify and succeeded with the response lost.
    // ========================================================================
    const response = await this.client.graphql(REFUND_CREATE_MUTATION, { variables });
    const body = (await response.json()) as GraphqlEnvelope;

    // Top-level errors FIRST: a coercion or authorization failure never
    // populates `userErrors`, so checking those first lets one through
    // unreported. Same five-step order as every other adapter here.
    if (body.errors?.length) {
      throw new AdminApiError("refundCreate", body.errors.map((e) => e.message));
    }
    const payload = body.data?.refundCreate as
      | {
          refund?: { id: string; totalRefundedSet?: { shopMoney?: { amount: string } | null } | null } | null;
          userErrors?: { field?: string[] | null; message: string }[];
        }
      | undefined;
    if (!payload) {
      throw new AdminApiError("refundCreate", ["response had no refundCreate payload"]);
    }
    const userErrors = payload.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new AdminApiError(
        "refundCreate",
        userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
      );
    }

    const refundGid = payload.refund?.id ?? null;
    if (!refundGid) {
      // Ambiguous rather than definitive: no userErrors means Shopify did not
      // reject it, so a refund may exist that we cannot name. NOT an
      // AdminApiError.
      throw new GroupBuyRefundEchoMismatchError(null, [
        "Shopify reported no userErrors but returned no refund id, so the refund cannot be verified or named",
      ]);
    }

    // ========================================================================
    // FROM HERE, MONEY HAS MOVED. Every failure is `GroupBuyRefundEchoMismatchError`.
    // ========================================================================
    await this.verifyRefundEcho({
      refundGid,
      orderGid: input.orderGid,
      expectedMinorUnits: input.totalAmountMinorUnits,
      expectedCurrency: input.currency.toUpperCase(),
      parentTransactionId: parent.id,
    });

    return { reference: refundGid };
  }

  private async loadOrderContext(orderGid: string): Promise<{
    order: {
      id: string;
      name: string;
      test: boolean;
      currencyCode: string;
      transactions: OrderTransactionNode[];
    };
  }> {
    const response = await this.client.graphql(ORDER_REFUND_CONTEXT_QUERY, { variables: { id: orderGid } });
    const body = (await response.json()) as GraphqlEnvelope;
    if (body.errors?.length) {
      throw new AdminApiError("order", body.errors.map((e) => e.message));
    }
    const order = body.data?.order as
      | {
          id: string;
          name: string;
          test: boolean;
          currencyCode: string;
          transactions?: OrderTransactionNode[] | null;
        }
      | null
      | undefined;
    if (!order) {
      throw new AdminApiError("order", [`order ${orderGid} was not found`]);
    }
    return { order: { ...order, transactions: order.transactions ?? [] } };
  }

  /**
   * The independent read-back. EVERY check the owner named, and a mismatch in
   * any of them fails closed.
   *
   * READ IN A SEPARATE QUERY, deliberately. The mutation's own response
   * carries a `totalRefundedSet` too, and trusting it would prove only that
   * Shopify received the request — not that the result persisted. This is the
   * same discipline `slice9.depositInvoicePriceField.ts` established for a
   * price.
   */
  private async verifyRefundEcho(input: {
    refundGid: string;
    orderGid: string;
    expectedMinorUnits: bigint;
    expectedCurrency: string;
    parentTransactionId: string;
  }): Promise<void> {
    let body: GraphqlEnvelope;
    try {
      const response = await this.client.graphql(REFUND_READ_BACK_QUERY, {
        variables: { id: input.refundGid },
      });
      body = (await response.json()) as GraphqlEnvelope;
    } catch (error) {
      throw new GroupBuyRefundEchoMismatchError(input.refundGid, [
        `the read-back request itself failed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    if (body.errors?.length) {
      throw new GroupBuyRefundEchoMismatchError(
        input.refundGid,
        body.errors.map((e) => `read-back error: ${e.message}`)
      );
    }

    const refund = body.data?.refund as
      | {
          id: string;
          order?: { id: string } | null;
          totalRefundedSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
          refundLineItems?: {
            nodes?: { quantity: number; restocked: boolean; restockType: string; lineItem?: { id: string } | null }[];
          } | null;
          refundShippingLines?: { nodes?: { id: string }[] } | null;
          duties?: { amountSet?: { shopMoney?: { amount: string } | null } | null }[] | null;
          transactions?: {
            nodes?: {
              id: string;
              kind: string;
              status: string;
              amountSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
            }[];
          } | null;
        }
      | null
      | undefined;

    if (!refund) {
      throw new GroupBuyRefundEchoMismatchError(input.refundGid, [
        "the refund could not be read back at all, so nothing about it is verified",
      ]);
    }

    const problems: string[] = [];

    // 1 and 2 — the exact amount, in the right currency. BY VALUE: a MoneyBag
    // is composed by Shopify and normalises trailing zeros, so a string
    // comparison would refuse a correct refund.
    const total = refund.totalRefundedSet?.shopMoney;
    const totalMinorUnits = moneyToMinorUnits(total?.amount);
    if (totalMinorUnits === null) {
      problems.push(`the refunded total "${total?.amount ?? "(absent)"}" could not be read as an amount`);
    } else if (totalMinorUnits !== input.expectedMinorUnits) {
      problems.push(
        `refunded ${total?.amount} = ${totalMinorUnits} minor units, but ${input.expectedMinorUnits} was approved`
      );
    }
    if ((total?.currencyCode ?? "").toUpperCase() !== input.expectedCurrency) {
      problems.push(`refunded in ${total?.currencyCode ?? "(absent)"} but ${input.expectedCurrency} was approved`);
    }

    // 3 — the right order.
    if (refund.order?.id !== input.orderGid) {
      problems.push(`the refund belongs to order ${refund.order?.id ?? "(absent)"}, not ${input.orderGid}`);
    }

    // 5 and 6 — NO merchandise recorded as returned, and NO restock. Checked
    // as an empty connection AND, if anything is there, by quantity and
    // `restocked` — so a future Shopify behaviour that attaches a zero-quantity
    // line cannot slip through as "empty enough".
    const refundLineItems = refund.refundLineItems?.nodes ?? [];
    if (refundLineItems.length > 0) {
      problems.push(
        `${refundLineItems.length} line item(s) were recorded as RETURNED — a tier adjustment returns no ` +
          `merchandise: ` +
          refundLineItems
            .map((l) => `${l.lineItem?.id ?? "?"} qty ${l.quantity} restocked=${l.restocked} (${l.restockType})`)
            .join(", ")
      );
    }

    // 7 — no shipping and no duties refunded. This adapter never sends either
    // input, so anything here means Shopify added it.
    const shippingLines = refund.refundShippingLines?.nodes ?? [];
    if (shippingLines.length > 0) {
      problems.push(`${shippingLines.length} shipping line(s) were refunded; the approved settlement covers merchandise only`);
    }
    const duties = refund.duties ?? [];
    if (duties.length > 0) {
      problems.push(`${duties.length} duty refund(s) were recorded; the approved settlement covers merchandise only`);
    }

    // 4 — the refund's own transaction, against the parent we named, for the
    // approved amount. A SUCCESS or PENDING transaction is expected; anything
    // else means the money did not actually move as asked.
    const transactions = refund.transactions?.nodes ?? [];
    const refundTransactions = transactions.filter((t) => t.kind === "REFUND");
    if (refundTransactions.length === 0) {
      problems.push("the refund carries no REFUND transaction, so no money moved against the order's payment");
    } else if (refundTransactions.length > 1) {
      // 8 — a duplicate within one refund.
      problems.push(
        `the refund carries ${refundTransactions.length} REFUND transactions; exactly one was requested`
      );
    } else {
      const transaction = refundTransactions[0]!;
      const transactionMinorUnits = moneyToMinorUnits(transaction.amountSet?.shopMoney?.amount);
      if (transactionMinorUnits !== input.expectedMinorUnits) {
        problems.push(
          `the REFUND transaction moved ${transaction.amountSet?.shopMoney?.amount ?? "(absent)"} ` +
            `= ${transactionMinorUnits ?? "unreadable"} minor units, not the approved ${input.expectedMinorUnits}`
        );
      }
      if (transaction.status !== "SUCCESS" && transaction.status !== "PENDING") {
        problems.push(`the REFUND transaction status is ${transaction.status}, so the money did not move as asked`);
      }
    }

    if (problems.length > 0) {
      throw new GroupBuyRefundEchoMismatchError(input.refundGid, problems);
    }
  }
}

/**
 * The transaction to refund against.
 *
 * MUST BE A SUCCESSFUL SALE OR CAPTURE. Refunding against an AUTHORIZATION
 * refunds money that was never captured; refunding against an existing REFUND
 * is nonsense. A failed or pending payment has nothing to give back.
 *
 * Prefers the LARGEST still-refundable transaction so a split-tender order
 * refunds from the one most likely to cover the adjustment in a single
 * transaction — partial multi-tender refunds are a distinct problem this
 * adapter does not solve, and it refuses (via the maximum-refundable check in
 * the caller) rather than silently refunding part of the approved figure.
 */
function selectRefundableParent(transactions: readonly OrderTransactionNode[]): OrderTransactionNode | null {
  const candidates = transactions
    .filter((t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS")
    .sort((a, b) => {
      const left = moneyToMinorUnits(a.maximumRefundableV2?.amount) ?? 0n;
      const right = moneyToMinorUnits(b.maximumRefundableV2?.amount) ?? 0n;
      return left === right ? 0 : right > left ? 1 : -1;
    });
  return candidates[0] ?? null;
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
