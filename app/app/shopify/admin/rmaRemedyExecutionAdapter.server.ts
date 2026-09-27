import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import { minorUnitsToDecimalString } from "./priceSyncAdapter.server";

/**
 * `RmaRemedyExecutionPort` / `ShopifyRmaRemedyExecutionAdapter` — the ONLY
 * module that calls Shopify to actually MOVE MONEY for a Buy Now RMA remedy
 * (Slice 4 remedy-execution task, D5/D7/D10 — `docs/ARCHITECTURE-MVP1.md`,
 * `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`, `docs/specs/
 * SLICE-4-BUY-NOW-RMA.md`). Called by `app/jobs/rma/executeRmaRemedy.server.ts`,
 * which owns the idempotency wrapper, the D7 tax-preservation decision, and
 * every write to `RmaRemedy` — THIS FILE DECIDES NOTHING; it only makes a
 * GraphQL call and reports back exactly what Shopify said, the same division
 * of labour as `priceSyncAdapter.server.ts` and
 * `luxuryStealOrderReviewAdapter.server.ts`.
 *
 * ============================================================================
 * CONFIDENCE GRADING — READ BEFORE TRUSTING THESE SHAPES
 * ============================================================================
 * SCHEMA-INTROSPECTED against `caratforus-dev` on Admin API 2026-07,
 * 2026-09-27, by `tests/live/slice4.rmaRemedyExecutionSchemaIntrospection.ts`
 * (read-only `__type`/`__schema` introspection — no mutation was ever
 * called; see that file's own header). EVERY field, argument, input type and
 * enum value this adapter sends or reads was confirmed to exist under its
 * exact name, INCLUDING catching one real mistake before it shipped:
 * `Order.suggestedRefund`'s `refundLineItems` argument takes
 * `[RefundLineItemInput!]!`, NOT `[OrderRefundLineItemInput!]!` as first
 * written — introspection returned the true type name, the query was
 * corrected, and the same type was confirmed reused by
 * `RefundInput.refundLineItems`, which the mutation below now populates
 * (every OTHER field on `RefundLineItemInput` was confirmed nullable, so
 * omitting `restockType` is a valid call, not a missing-required-field
 * error). `storeCreditAccountCredit` was confirmed to exist under that exact
 * name (it was not a given — the entry point for D5's mechanism could easily
 * have been named differently).
 *
 * WHAT INTROSPECTION DOES NOT AND CANNOT CLOSE: whether these mutations
 * BEHAVE as intended against a real order/customer — that requires actually
 * calling them, which is money-moving and NOT authorised outside a live
 * order/return with owner sign-off. Same limitation `slice5.
 * orderLookupSchemaIntrospection.ts`'s own header states for its adapters.
 * Re-run the introspection gate (`npx tsx tests/live/
 * slice4.rmaRemedyExecutionSchemaIntrospection.ts`) after any Admin API
 * version bump before trusting these shapes again.
 *
 * WHY A DELIBERATELY NARROW SURFACE. Each method answers exactly one
 * question the job needs and nothing more:
 *   - `getSuggestedRefundForLine` — "what would Shopify's own refund
 *     calculator say the merchandise subtotal and tax are for returning this
 *     line's full refundable quantity?" Returns `null` for every case Shopify
 *     cannot answer (no refundable quantity left, order/line not found) —
 *     the job treats `null` as "cannot represent cleanly" and routes to
 *     `staff_review_required` (D7's fail-closed instruction), never guessing.
 *   - `issueStoreCredit` — credits an EXISTING Shopify Store Credit account.
 *     Returns `null` if the customer has no store credit account Shopify will
 *     let us credit (D5: "no silent fallback to gift cards ... route to staff
 *     review" — this file supplies the `null` that makes that fallback
 *     possible; it does not decide to take it).
 *   - `createRefund` — refunds an already-decided total (merchandise + tax)
 *     against the order's original payment transaction.
 *
 * NONE OF THESE THREE METHODS COMPUTES A PROPORTION, A PERCENTAGE, OR A TAX
 * RATE. `createRefund`/`issueStoreCredit` are handed an EXACT total the job
 * already decided; this file's only arithmetic is money-safe minor-units ->
 * decimal-string formatting via the shared `minorUnitsToDecimalString`
 * (imported, never reimplemented — same discipline `priceSyncAdapter.server.ts`
 * itself follows).
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

function unwrapUserErrors(
  operation: string,
  payload: { userErrors?: { field?: string[] | null; message: string; code?: string | null }[] } | undefined
): { field?: string[] | null; message: string; code?: string | null }[] {
  if (!payload) throw new AdminApiError(operation, [`response had no ${operation} payload`]);
  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new AdminApiError(
      operation,
      userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}${e.code ? ` [${e.code}]` : ""}: ${e.message}`)
    );
  }
  return userErrors;
}

// ---------------------------------------------------------------------------
// getSuggestedRefundForLine
// ---------------------------------------------------------------------------

const LINE_ITEM_REFUNDABLE_QUANTITY_QUERY = `#graphql
  query CaratRmaLineItemRefundableQuantity($orderId: ID!) {
    order(id: $orderId) {
      id
      currencyCode
      lineItems(first: 250) {
        nodes { id refundableQuantity }
      }
    }
  }`;

const SUGGESTED_REFUND_QUERY = `#graphql
  query CaratRmaSuggestedRefund($orderId: ID!, $refundLineItems: [RefundLineItemInput!]!) {
    order(id: $orderId) {
      id
      suggestedRefund(refundLineItems: $refundLineItems) {
        subtotalSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
      }
    }
  }`;

export interface SuggestedRmaRefund {
  readonly merchandiseAmountMinorUnits: bigint;
  readonly taxAmountMinorUnits: bigint;
  readonly currency: string;
}

export interface RmaRemedyExecutionPort {
  /**
   * `null` means Shopify cannot cleanly represent a refund of this line right
   * now (order/line not found, or nothing left to refund) — the caller's D7
   * fail-closed instruction, not this adapter's decision.
   */
  getSuggestedRefundForLine(input: { orderGid: string; lineItemGid: string }): Promise<SuggestedRmaRefund | null>;

  /**
   * Credits an EXISTING Shopify Store Credit account for `customerGid`.
   * `null` means no store-credit account exists for this customer (D5's
   * "no silent fallback to gift cards" case) — the caller decides to route
   * to staff review; this method never creates a gift card as a substitute.
   */
  issueStoreCredit(input: {
    customerGid: string;
    amountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string } | null>;

  /** Refunds the EXACT total supplied (merchandise + Shopify's own tax figure, already summed by the caller) against the order's original payment transaction. */
  createRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }>;
}

export class ShopifyRmaRemedyExecutionAdapter implements RmaRemedyExecutionPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async getSuggestedRefundForLine(input: { orderGid: string; lineItemGid: string }): Promise<SuggestedRmaRefund | null> {
    const lookupData = await execute(this.client, "rmaLineItemRefundableQuantity", LINE_ITEM_REFUNDABLE_QUANTITY_QUERY, {
      orderId: input.orderGid,
    });
    const order = lookupData.order as
      | { id: string; currencyCode: string; lineItems?: { nodes?: { id: string; refundableQuantity: number }[] } }
      | null;
    if (!order) return null;

    const lineItem = order.lineItems?.nodes?.find((node) => node.id === input.lineItemGid);
    // No refundable quantity left (already returned/refunded) is exactly a
    // "Shopify cannot represent this refund" case, not an error.
    if (!lineItem || lineItem.refundableQuantity <= 0) return null;

    const refundData = await execute(this.client, "rmaSuggestedRefund", SUGGESTED_REFUND_QUERY, {
      orderId: input.orderGid,
      refundLineItems: [{ lineItemId: input.lineItemGid, quantity: lineItem.refundableQuantity }],
    });
    const suggested = (refundData.order as { suggestedRefund?: unknown } | null)?.suggestedRefund as
      | {
          subtotalSet?: { shopMoney?: { amount: string; currencyCode: string } };
          totalTaxSet?: { shopMoney?: { amount: string; currencyCode: string } };
        }
      | null
      | undefined;
    const subtotal = suggested?.subtotalSet?.shopMoney;
    const totalTax = suggested?.totalTaxSet?.shopMoney;
    if (!subtotal || !totalTax) return null;
    if (subtotal.currencyCode !== totalTax.currencyCode) return null;

    return {
      merchandiseAmountMinorUnits: decimalStringToMinorUnits(subtotal.amount),
      taxAmountMinorUnits: decimalStringToMinorUnits(totalTax.amount),
      currency: subtotal.currencyCode,
    };
  }

  async issueStoreCredit(input: {
    customerGid: string;
    amountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string } | null> {
    const accountData = await execute(
      this.client,
      "rmaCustomerStoreCreditAccount",
      `#graphql
        query CaratRmaCustomerStoreCreditAccount($customerId: ID!) {
          customer(id: $customerId) {
            id
            storeCreditAccounts(first: 1) {
              nodes { id }
            }
          }
        }`,
      { customerId: input.customerGid }
    );
    const account = (accountData.customer as { storeCreditAccounts?: { nodes?: { id: string }[] } } | null)
      ?.storeCreditAccounts?.nodes?.[0];
    // D5 — no account to credit is a "route to staff review" signal, never a
    // reason to fall back to a gift card.
    if (!account) return null;

    const creditData = await execute(
      this.client,
      "storeCreditAccountCredit",
      `#graphql
        mutation CaratStoreCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
          storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
            storeCreditAccountTransaction { id }
            userErrors { field message code }
          }
        }`,
      {
        id: account.id,
        creditInput: {
          creditAmount: { amount: minorUnitsToDecimalString(input.amountMinorUnits), currencyCode: input.currency },
        },
      }
    );
    const payload = creditData.storeCreditAccountCredit as
      | { storeCreditAccountTransaction?: { id: string } | null; userErrors?: { field?: string[] | null; message: string; code?: string | null }[] }
      | undefined;
    unwrapUserErrors("storeCreditAccountCredit", payload);
    const transaction = payload?.storeCreditAccountTransaction;
    if (!transaction) {
      throw new AdminApiError("storeCreditAccountCredit", ["response carried no userErrors but also no transaction"]);
    }
    return { reference: transaction.id };
  }

  async createRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }> {
    const transactionsData = await execute(
      this.client,
      "rmaOrderRefundableTransaction",
      `#graphql
        query CaratRmaOrderRefundableTransaction($orderId: ID!) {
          order(id: $orderId) {
            id
            transactions(first: 25) {
              id
              kind
              status
              gateway
              parentTransaction { id }
            }
            lineItems(first: 250) {
              nodes { id refundableQuantity }
            }
          }
        }`,
      { orderId: input.orderGid }
    );
    const order = transactionsData.order as
      | {
          transactions?: { id: string; kind: string; status: string; gateway: string; parentTransaction: { id: string } | null }[];
          lineItems?: { nodes?: { id: string; refundableQuantity: number }[] };
        }
      | null;
    // The original sale/capture transaction — a root transaction (no parent
    // of its own) that actually succeeded. Refunding against anything else
    // is not this adapter's decision to invent.
    const parent = order?.transactions?.find(
      (t) => t.parentTransaction === null && t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE")
    );
    if (!parent) {
      throw new AdminApiError("refundCreate", [
        `order ${input.orderGid} has no successful SALE/CAPTURE transaction to refund against`,
      ]);
    }

    // Live-introspected 2026-09-27 against caratforus-dev (2026-07): `RefundInput`
    // has a `refundLineItems: [RefundLineItemInput!]` field — the SAME input
    // type `Order.suggestedRefund` takes — and it is the only way this
    // mutation ties a refund to a specific line/quantity for restock and
    // reporting purposes rather than a bare, untraceable transaction amount.
    // Every OTHER field on `RefundLineItemInput` was confirmed nullable (not
    // required), so omitting `restockType`/`locationId` is a valid call, not
    // a missing-required-field error — Shopify's own default restock
    // behaviour applies, since this codebase has no inventory/restock policy
    // input for a discretionary return to decide otherwise (flagged for
    // owner/architect review, not invented here).
    const lineItem = order?.lineItems?.nodes?.find((node) => node.id === input.lineItemGid);
    if (!lineItem || lineItem.refundableQuantity <= 0) {
      throw new AdminApiError("refundCreate", [
        `order ${input.orderGid} line ${input.lineItemGid} has no refundable quantity left`,
      ]);
    }

    const refundData = await execute(
      this.client,
      "refundCreate",
      `#graphql
        mutation CaratRmaRefundCreate($input: RefundInput!) {
          refundCreate(input: $input) {
            refund { id }
            userErrors { field message code }
          }
        }`,
      {
        input: {
          orderId: input.orderGid,
          notify: true,
          refundLineItems: [{ lineItemId: input.lineItemGid, quantity: lineItem.refundableQuantity }],
          transactions: [
            {
              orderId: input.orderGid,
              parentId: parent.id,
              gateway: parent.gateway,
              kind: "REFUND",
              amount: minorUnitsToDecimalString(input.totalAmountMinorUnits),
            },
          ],
        },
      }
    );
    const payload = refundData.refundCreate as
      | { refund?: { id: string } | null; userErrors?: { field?: string[] | null; message: string; code?: string | null }[] }
      | undefined;
    unwrapUserErrors("refundCreate", payload);
    const refund = payload?.refund;
    if (!refund) {
      throw new AdminApiError("refundCreate", ["response carried no userErrors but also no refund"]);
    }
    return { reference: refund.id };
  }
}

/**
 * The inverse of `minorUnitsToDecimalString` — parses a Shopify `Money`
 * decimal string (e.g. `"125.00"`) into exact integer minor units WITHOUT
 * ever crossing into a JS `number`. Pure string/bigint arithmetic, same
 * discipline as `minorUnitsToDecimalString` itself.
 */
function decimalStringToMinorUnits(decimal: string, minorUnitsPerMajorUnit = 100n): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) {
    throw new AdminApiError("decimalStringToMinorUnits", [`"${decimal}" is not a plain decimal amount`]);
  }
  const [, sign = "", wholePart = "0", fractionPartRaw = ""] = match;
  const decimalPlaces = minorUnitsPerMajorUnit.toString().length - 1;
  const fractionPart = fractionPartRaw.padEnd(decimalPlaces, "0").slice(0, decimalPlaces);
  const magnitude = BigInt(wholePart) * minorUnitsPerMajorUnit + (fractionPart === "" ? 0n : BigInt(fractionPart));
  return sign === "-" ? -magnitude : magnitude;
}

/** Records calls and returns pre-seeded results. Tests only. */
export class RecordingRmaRemedyExecutionPort implements RmaRemedyExecutionPort {
  readonly suggestedRefundCalls: { orderGid: string; lineItemGid: string }[] = [];
  readonly storeCreditCalls: { customerGid: string; amountMinorUnits: bigint; currency: string }[] = [];
  readonly refundCalls: { orderGid: string; lineItemGid: string; totalAmountMinorUnits: bigint; currency: string }[] = [];

  suggestedRefundResult: SuggestedRmaRefund | null = null;
  storeCreditResult: { reference: string } | null = { reference: "store-credit-txn-fixture" };
  refundResult: { reference: string } = { reference: "refund-fixture" };
  refundError: Error | null = null;
  storeCreditError: Error | null = null;

  async getSuggestedRefundForLine(input: { orderGid: string; lineItemGid: string }): Promise<SuggestedRmaRefund | null> {
    this.suggestedRefundCalls.push(input);
    return this.suggestedRefundResult;
  }

  async issueStoreCredit(input: { customerGid: string; amountMinorUnits: bigint; currency: string }): Promise<{ reference: string } | null> {
    this.storeCreditCalls.push(input);
    if (this.storeCreditError) throw this.storeCreditError;
    return this.storeCreditResult;
  }

  async createRefund(input: {
    orderGid: string;
    lineItemGid: string;
    totalAmountMinorUnits: bigint;
    currency: string;
  }): Promise<{ reference: string }> {
    this.refundCalls.push(input);
    if (this.refundError) throw this.refundError;
    return this.refundResult;
  }
}
