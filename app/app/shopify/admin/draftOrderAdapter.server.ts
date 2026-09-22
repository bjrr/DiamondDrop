import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import { minorUnitsToDecimalString } from "./priceSyncAdapter.server";
import { Money } from "~/domain/money/money";
import { CurrencyMismatchError } from "~/domain/money/errors";

/**
 * `ShopifyDraftOrderAdapter` — the ONLY module in this app that talks to the
 * Shopify Admin API's draft-order surface (spec §5.1/§5.4, Slice 2C task
 * 2C-1). It is the Bank Payment Checkout equivalent of `priceSyncAdapter.ts`,
 * and deliberately mirrors that file's shape and failure contract rather than
 * inventing a new one — the two adapters are the app's only writers of a
 * customer-facing price to Shopify, and a reviewer should be able to read one
 * having already read the other.
 *
 * WHAT IT DOES NOT DECIDE, same division of labour as the price-sync adapter:
 * which lines to charge, at what price, whether a line is Bank-eligible, and
 * whether the cart is Buy Now or Group Buy are all decided by the caller
 * (2C-3's checkout route) BEFORE this class is ever invoked (spec criterion
 * 72). This class's job is transport and verification of an already-decided
 * order, not pricing or eligibility.
 *
 * `productVariantsBulkUpdate`'s HTTP-200-hides-every-failure hazard applies
 * identically here — draft-order mutations reject with `userErrors` and fail
 * variable coercion with top-level `errors`, both on a 200 — so every method
 * below repeats `priceSyncAdapter`'s five-step check in the same order:
 *   1. top-level GraphQL `errors` (coercion/authorization) — checked FIRST;
 *   2. the mutation payload is present;
 *   3. `userErrors` is empty (the payload's own object is `null` when it is
 *      not, exactly as `productVariantsBulkUpdate` behaves — see below);
 *   4. the expected id is present in the response, not merely "an" id;
 *   5. echoed values (price, quantity, id) match what was sent.
 * Steps 1–3 are identical shape across all four mutations here, so they are
 * factored into `runDraftOrderMutation` below; steps 4–5 are mutation-specific
 * and stay inline at each call site, exactly as `priceSyncAdapter` keeps its
 * own id/price echo checks inline rather than genericizing them away.
 *
 * NOT YET VERIFIED AGAINST THE REAL STORE. Unlike `priceSyncAdapter`
 * (criterion 60, run 2026-09-19), `write_draft_orders` is not yet granted on
 * the dev store — the OAuth re-consent is pending (spec §7, §11). This file
 * is built and unit-tested against a mocked Admin client only; the mutation
 * shapes below are believed correct for Admin API 2026-07 but have NOT had an
 * independent live read-back the way `priceSyncAdapter`'s mutation did. A
 * live verification run equivalent to criterion 60's must happen before this
 * adapter is trusted the way `priceSyncAdapter` is, and should update this
 * comment with the same kind of evidence when it does.
 */

const CREATE_DRAFT_ORDER_MUTATION = `#graphql
  mutation CaratCreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
        # Page size MUST equal MAX_VERIFIABLE_LINE_ITEMS below — the echo
        # check compares counts, so the two moving apart breaks verification.
        lineItems(first: 50) {
          nodes {
            quantity
            originalUnitPrice
            variant { id }
          }
        }
      }
      userErrors { field message }
    }
  }`;

const SEND_INVOICE_MUTATION = `#graphql
  # The invoice recipient is an EmailInput (to / subject / from / body / bcc /
  # customMessage), NOT a DraftOrderInvoiceSendInput — that type does not exist
  # in 2026-07, and the server rejected it outright. Verified by introspection
  # against caratforus-dev, not inferred.
  mutation CaratSendDraftOrderInvoice($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id invoiceSentAt }
      userErrors { field message }
    }
  }`;

const COMPLETE_DRAFT_ORDER_MUTATION = `#graphql
  # NO paymentPending ARGUMENT. It does not exist on draftOrderComplete in
  # 2026-07 — the argument list is (id, paymentGatewayId, sourceName), verified
  # by introspection. Completing without a payment gateway leaves the order
  # unpaid, which is what §22 requires: nothing is committed until an admin has
  # verified the bank transfer by hand. See completeDraftOrder below.
  mutation CaratCompleteDraftOrder($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        order { id name }
      }
      userErrors { field message }
    }
  }`;

const CANCEL_DRAFT_ORDER_MUTATION = `#graphql
  mutation CaratCancelDraftOrder($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }`;

/**
 * The zero-price shipping line title (spec §4 D19, criterion 95). Shipping
 * and insurance are already priced INTO the landed cost that produced this
 * line's `unitPrice` (`CostComponentType.shipping`, `.insurance` —
 * `README.md` requires this so they cannot silently erode margin). A second,
 * separate shipping charge on the draft order would therefore bill the
 * customer twice for the same thing.
 *
 * The line is set EXPLICITLY at price "0.00" rather than omitted, so the
 * draft order's own record shows shipping was priced at nil deliberately —
 * a decision made once, here, not an absence a later reader has to guess the
 * reason for. If expedited shipping is ever charged separately, that is a
 * new, non-zero, non-guaranteed line priced at completion (spec §4 D19); it
 * does not change this constant.
 */
const ZERO_SHIPPING_LINE_TITLE = "Shipping (included in item price)";

/**
 * The page size of the `lineItems` connection in CREATE_DRAFT_ORDER_MUTATION,
 * and therefore the most lines this adapter can VERIFY it sent correctly.
 *
 * This is a guard, not a product limit. Step 5's echo check compares what
 * Shopify returned against what we sent; ask for more lines than the
 * connection will return and the counts disagree, the check throws — but by
 * then `draftOrderCreate` has already SUCCEEDED, so the failure leaves a real
 * draft order in the shop that nothing in our database points at. An orphaned
 * draft with live prices on it is worse than a refused request.
 *
 * So the limit is enforced BEFORE the call, where refusing costs nothing.
 * Raising it means raising `lineItems(first:)` in the mutation to match; the
 * two numbers must move together, which is why the mutation names this
 * constant in its comment.
 */
const MAX_VERIFIABLE_LINE_ITEMS = 50;

/**
 * Shopify's built-in "Due on receipt" payment term. These templates are
 * platform-global rather than per-shop, so the id is stable across stores —
 * confirmed by querying `paymentTermsTemplates` on caratforus-dev, where
 * template 1 is RECEIPT.
 *
 * It is hardcoded rather than resolved per request because a lookup on every
 * checkout buys nothing: if the id were ever wrong, the request would fail
 * loudly at `draftOrderCreate`, and the completed order's financial status is
 * asserted end to end by the live gate. A silent wrong answer is not among the
 * failure modes.
 */
const DUE_ON_RECEIPT_TEMPLATE_GID = "gid://shopify/PaymentTermsTemplate/1";

export interface DraftOrderLineItemInput {
  /** The Shopify product variant this line charges for. */
  shopifyVariantGid: string;
  quantity: number;
  /**
   * The price for ONE unit of this line, already resolved by the caller
   * (criterion 72: recomputed server-side from the published calculation at
   * quote time — the Bank Payment Price for Bank-eligible lines, the
   * Regular/Card Price otherwise, per §18). This adapter does not calculate,
   * floor, tier or round a price; it transports and verifies the one it is
   * given.
   */
  unitPrice: Money;
}

export interface DraftOrderShippingAddressInput {
  firstName?: string;
  lastName?: string;
  address1: string;
  address2?: string;
  city: string;
  /** ISO 3166-2 province/state code, e.g. "CA", "NY". */
  provinceCode?: string;
  zip: string;
  /** ISO 3166-1 alpha-2 country code, e.g. "US". */
  countryCode: string;
  phone?: string;
}

export interface CreateDraftOrderInput {
  email: string;
  /**
   * Sent to Shopify and NOT returned by this adapter (criterion 97/99): this
   * class never persists it, and callers must not either. Retrieve the
   * address from Shopify at the time it is needed, never from a local copy.
   */
  shippingAddress: DraftOrderShippingAddressInput;
  lineItems: readonly DraftOrderLineItemInput[];
  /**
   * Free-form note attached to the Shopify draft order (e.g. the
   * `bank_payment_order` id, for cross-reference from the Shopify admin UI
   * back to our record). Never put cost, margin or other admin-only pricing
   * data here — the note is visible to any Shopify admin user, not gated by
   * this app's own access control.
   */
  note?: string;
  tags?: readonly string[];
}

export interface CreatedDraftOrder {
  draftOrderGid: string;
  /** Null when Shopify has not (yet) generated one for this draft order. */
  invoiceUrl: string | null;
}

export interface SendDraftOrderInvoiceInput {
  draftOrderGid: string;
  /** The recipient. Shopify defaults to the draft order's own `email` field when omitted; this app always supplies it explicitly. */
  email: string;
  /**
   * Words to place inside the invoice Shopify composes and sends — criterion
   * 85's §22 disclosure. Optional at this layer because the adapter transports
   * whatever it is given and decides no copy of its own; the caller owns what
   * the customer reads.
   */
  customMessage?: string;
}

export interface CompleteDraftOrderInput {
  draftOrderGid: string;
}

export interface CompletedDraftOrder {
  orderGid: string;
  /** Shopify's human-readable order name (e.g. "#1042"), where returned. */
  orderName: string | null;
}

export interface CancelDraftOrderInput {
  draftOrderGid: string;
}

/**
 * Port-shaped interface (mirrors `ShopifyPriceSyncPort` in
 * `app/jobs/pricing/ports.ts`) so the checkout route (2C-3) and the guarantee
 * sweep (2C-4) can be unit-tested with no network and no database, exactly
 * like the pricing job is against `ShopifyPriceSyncPort`.
 */
export interface DraftOrderPort {
  /** `draftOrderCreate`. Never sends `reserveInventoryUntil` (§22, criterion 73). */
  createDraftOrder(input: CreateDraftOrderInput): Promise<CreatedDraftOrder>;

  /** `draftOrderInvoiceSend`. */
  sendInvoice(input: SendDraftOrderInvoiceInput): Promise<{ invoiceSentAt: Date }>;

  /**
   * `draftOrderComplete` via the MANUAL payment gateway (`paymentPending:
   * false`, criterion 89). A draft order completed this way has no online
   * payment attached — Shopify records the resulting order as paid through
   * its manual gateway, which is correct here because payment was already
   * verified by an admin (spec §5.4) before this method is ever called. The
   * app never handles card data and never touches funds; this call only
   * tells Shopify a human already confirmed the money arrived.
   */
  completeDraftOrder(input: CompleteDraftOrderInput): Promise<CompletedDraftOrder>;

  /**
   * `draftOrderDelete` — the cancellation call the guarantee sweep needs
   * (D22, criterion 80 revised). Deletes an unpaid draft order outright;
   * there is no separate "cancelled" state for a draft order the way a real
   * Shopify order has one.
   */
  cancelDraftOrder(input: CancelDraftOrderInput): Promise<{ cancelledDraftOrderGid: string }>;
}

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

export class ShopifyDraftOrderAdapter implements DraftOrderPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  /**
   * Steps 1–3 of the five-step check shared by every mutation in this class:
   * top-level `errors` first (a coercion or authorization failure never
   * populates `userErrors`, so checking it second would let one through
   * unreported — same reasoning as `priceSyncAdapter`), then the mutation's
   * own payload must be present, then `userErrors` must be empty. Returns the
   * unwrapped payload for the caller to run its own steps 4–5 (identity and
   * echo checks) against, since those differ per mutation shape.
   */
  private async runDraftOrderMutation<TPayload extends { userErrors?: { field?: string[] | null; message: string }[] }>(
    operation: string,
    document: string,
    variables: Record<string, unknown>,
    field: string
  ): Promise<TPayload> {
    const response = await this.client.graphql(document, { variables });
    const body = (await response.json()) as GraphqlEnvelope;

    if (body.errors?.length) {
      throw new AdminApiError(operation, body.errors.map((e) => e.message));
    }

    const payload = body.data?.[field] as TPayload | undefined;
    if (!payload) {
      throw new AdminApiError(operation, [`response had no ${field} payload`]);
    }

    const userErrors = payload.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new AdminApiError(
        operation,
        userErrors.map((e) => `${(e.field ?? []).join(".") || "(general)"}: ${e.message}`)
      );
    }

    return payload;
  }

  async createDraftOrder(input: CreateDraftOrderInput): Promise<CreatedDraftOrder> {
    if (input.lineItems.length === 0) {
      throw new AdminApiError("draftOrderCreate", ["cannot create a draft order with zero line items"]);
    }

    // Refused here rather than discovered by the echo check, which only runs
    // AFTER Shopify has already created the order — see
    // MAX_VERIFIABLE_LINE_ITEMS.
    if (input.lineItems.length > MAX_VERIFIABLE_LINE_ITEMS) {
      throw new AdminApiError("draftOrderCreate", [
        `cannot verify more than ${MAX_VERIFIABLE_LINE_ITEMS} line items; received ${input.lineItems.length}`,
      ]);
    }

    // DUPLICATE VARIANTS ARE REFUSED, NOT MERGED. The echo check keys sent
    // prices by variant gid so that two lines whose prices were transposed
    // are caught (a positional check would not be). That keying makes a
    // repeated variant ambiguous: two lines collapse to one map entry, and
    // Shopify may itself merge them into a single line item, so the count
    // check would then fail after the order already exists — the same
    // orphaned-draft failure the line limit above prevents.
    //
    // Coalescing them here instead would be worse: summing quantities is a
    // decision about what the customer is buying, and criterion 72 puts every
    // such decision in the caller, before this class is reached. The caller
    // (2C-3) coalesces; this class refuses what it cannot verify.
    const seenVariantGids = new Set<string>();
    for (const line of input.lineItems) {
      if (seenVariantGids.has(line.shopifyVariantGid)) {
        throw new AdminApiError("draftOrderCreate", [
          `variant ${line.shopifyVariantGid} appears on more than one line item; ` +
            "coalesce duplicate variants into one line before calling this adapter",
        ]);
      }
      seenVariantGids.add(line.shopifyVariantGid);
    }

    const currency = input.lineItems[0]!.unitPrice.currency;
    for (const line of input.lineItems) {
      if (line.unitPrice.currency !== currency) {
        throw new CurrencyMismatchError(currency, line.unitPrice.currency);
      }
    }

    // Each sent line's decimal price string, keyed by variant gid, so the
    // echo check below (step 5) can compare Shopify's returned string
    // against the exact one we sent without parsing either side back into a
    // number — the same string-compare discipline `priceSyncAdapter` uses.
    const sentPriceByVariantGid = new Map<string, string>();
    const lineItemsVariables = input.lineItems.map((line) => {
      const priceDecimalString = minorUnitsToDecimalString(line.unitPrice.amountMinorUnits);
      sentPriceByVariantGid.set(line.shopifyVariantGid, priceDecimalString);
      return {
        variantId: line.shopifyVariantGid,
        quantity: line.quantity,
        // `priceOverride`, NOT `originalUnitPrice`, AND THE DIFFERENCE IS THE
        // WHOLE PRICE. This adapter originally sent `originalUnitPrice`, which
        // does not exist on `DraftOrderLineItemInput` in 2026-07 — Shopify
        // neither errored nor coerced, it simply ignored the field and priced
        // the line at the variant's catalogue price. The live gate caught it
        // only because step 5 compares the echoed price against the sent one;
        // a mocked client echoes back whatever it was handed, so no unit test
        // could ever have found this.
        //
        // The API's own descriptions settle which field is correct:
        // `priceOverride` is "used in place of the product variant's catalog
        // price in this draft order", while `originalUnitPriceWithCurrency` is
        // for custom line items and is explicitly "ignored when variantId is
        // provided" — which every line here provides.
        //
        // Currency travels WITH the amount because Shopify converts a price
        // override whose presentment currency differs from the draft order's.
        // Sending the amount alone would leave that conversion to a default we
        // do not control.
        priceOverride: {
          amount: priceDecimalString,
          currencyCode: currency,
        },
      };
    });

    // THE FIELD THAT MUST NEVER APPEAR: `reserveInventoryUntil` is a real key
    // on `DraftOrderInput` in this API version, and §22 forbids reserving
    // inventory for an unpaid Bank Payment order. It is not merely omitted by
    // accident — it is never referenced anywhere in this object literal, so
    // there is no code path in this method that could add it. Criterion 73's
    // test asserts this on the serialised payload, not on this comment.
    const variables = {
      input: {
        email: input.email,
        shippingAddress: {
          firstName: input.shippingAddress.firstName,
          lastName: input.shippingAddress.lastName,
          address1: input.shippingAddress.address1,
          address2: input.shippingAddress.address2,
          city: input.shippingAddress.city,
          provinceCode: input.shippingAddress.provinceCode,
          zip: input.shippingAddress.zip,
          countryCode: input.shippingAddress.countryCode,
          phone: input.shippingAddress.phone,
        },
        lineItems: lineItemsVariables,
        // Explicit, not absent (D19, criterion 95): the record shows
        // shipping was priced at nil deliberately.
        shippingLine: {
          title: ZERO_SHIPPING_LINE_TITLE,
          price: minorUnitsToDecimalString(Money.zero(currency).amountMinorUnits),
        },
        // PAYMENT TERMS ARE WHAT KEEP THE COMPLETED ORDER UNPAID, and the
        // live gate caught their absence the hard way: completing a draft
        // with no payment terms produced an order Shopify marked PAID. It had
        // processed nothing — the bank transfer happens outside Shopify
        // entirely — so the order was asserting a receipt that did not exist,
        // which is precisely what §22 forbids. `paymentPending: false` used to
        // express this and no longer exists on draftOrderComplete (2026-07);
        // payment terms are its replacement.
        //
        // "Due on receipt" is the honest term for a Bank Payment order: the
        // money is owed now, it has not arrived yet, and the resulting order
        // shows PENDING until an admin verifies the transfer. Net-N terms
        // would misstate the deal as credit we have not extended.
        paymentTerms: { paymentTermsTemplateId: DUE_ON_RECEIPT_TEMPLATE_GID },
        note: input.note,
        tags: input.tags ? [...input.tags] : undefined,
      },
    };

    const payload = await this.runDraftOrderMutation<{
      draftOrder?: {
        id: string;
        invoiceUrl: string | null;
        lineItems?: { nodes?: { quantity: number; originalUnitPrice: string; variant?: { id: string } | null }[] };
      } | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>("draftOrderCreate", CREATE_DRAFT_ORDER_MUTATION, variables, "draftOrderCreate");

    const draftOrder = payload.draftOrder;
    if (!draftOrder) {
      throw new AdminApiError("draftOrderCreate", [
        "response carried no userErrors but also no draftOrder",
      ]);
    }

    // STEP 5 — echo check. Every line we sent must come back with the exact
    // variant, quantity and price we sent. Matched by variant gid rather than
    // array position: nothing in the schema promises the returned order
    // matches the request order, and a positional match could silently pass
    // a swapped-price bug where two lines' prices were transposed.
    const returnedLines = draftOrder.lineItems?.nodes ?? [];
    if (returnedLines.length !== input.lineItems.length) {
      throw new AdminApiError("draftOrderCreate", [
        `sent ${input.lineItems.length} line item(s) but the response echoed ${returnedLines.length}`,
      ]);
    }

    for (const [variantGid, sentPrice] of sentPriceByVariantGid) {
      const returned = returnedLines.find((line) => line.variant?.id === variantGid);
      if (!returned) {
        throw new AdminApiError("draftOrderCreate", [
          `sent a line for variant ${variantGid} but it was not echoed back in the response`,
        ]);
      }
      const expectedQuantity = input.lineItems.find((l) => l.shopifyVariantGid === variantGid)!.quantity;
      if (returned.quantity !== expectedQuantity) {
        throw new AdminApiError("draftOrderCreate", [
          `variant ${variantGid}: sent quantity ${expectedQuantity} but Shopify echoed ${returned.quantity}`,
        ]);
      }
      if (returned.originalUnitPrice !== sentPrice) {
        throw new AdminApiError("draftOrderCreate", [
          `variant ${variantGid}: published price mismatch — sent ${sentPrice} but Shopify echoed ${returned.originalUnitPrice}`,
        ]);
      }
    }

    return {
      draftOrderGid: draftOrder.id,
      invoiceUrl: draftOrder.invoiceUrl,
    };
  }

  async sendInvoice(input: SendDraftOrderInvoiceInput): Promise<{ invoiceSentAt: Date }> {
    const variables = {
      id: input.draftOrderGid,
      email: {
        to: input.email,
        // CRITERION 85 RIDES HERE. Shopify composes and sends the invoice
        // email; `customMessage` is the only place we can put words into it.
        // The §22 disclosure therefore travels WITH the invoice rather than as
        // a separate email of our own, which would arrive detached from the
        // thing it qualifies — exactly when a customer would miss it.
        ...(input.customMessage ? { customMessage: input.customMessage } : {}),
      },
    };

    const payload = await this.runDraftOrderMutation<{
      draftOrder?: { id: string; invoiceSentAt: string | null } | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>("draftOrderInvoiceSend", SEND_INVOICE_MUTATION, variables, "draftOrderInvoiceSend");

    const draftOrder = payload.draftOrder;
    if (!draftOrder) {
      throw new AdminApiError("draftOrderInvoiceSend", [
        "response carried no userErrors but also no draftOrder",
      ]);
    }
    if (draftOrder.id !== input.draftOrderGid) {
      throw new AdminApiError("draftOrderInvoiceSend", [
        `expected draft order ${input.draftOrderGid} but the response named ${draftOrder.id}`,
      ]);
    }
    if (!draftOrder.invoiceSentAt) {
      throw new AdminApiError("draftOrderInvoiceSend", [
        "response named the expected draft order but invoiceSentAt was not set",
      ]);
    }

    return { invoiceSentAt: new Date(draftOrder.invoiceSentAt) };
  }

  async completeDraftOrder(input: CompleteDraftOrderInput): Promise<CompletedDraftOrder> {
    // CRITERION 89, AS THE API ACTUALLY WORKS. The original implementation
    // sent `paymentPending: false`, which is wrong twice over: the argument
    // does not exist on `draftOrderComplete` in 2026-07, and its historical
    // meaning was "this order is PAID" — the opposite of what §22 requires.
    // Nothing about a Bank Payment order is paid until an admin has verified
    // the transfer by hand, so an order marked paid at completion would assert
    // a receipt nobody has seen.
    //
    // Completing with neither `paymentPending` nor a `paymentGatewayId` leaves
    // the resulting order unpaid, which is the state we want and which the
    // live gate asserts by reading `displayFinancialStatus` back as PENDING
    // rather than trusting this comment.
    //
    // Naming a specific manual gateway via `paymentGatewayId` is a refinement
    // for the verification surface (2C-c), where an admin records WHICH method
    // the money actually arrived by. It is not needed to create the order in
    // the correct unpaid state, and guessing a gateway id here would attach
    // payment metadata before anyone has verified a payment.
    const variables = { id: input.draftOrderGid };

    const payload = await this.runDraftOrderMutation<{
      draftOrder?: { id: string; order?: { id: string; name: string | null } | null } | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>("draftOrderComplete", COMPLETE_DRAFT_ORDER_MUTATION, variables, "draftOrderComplete");

    const draftOrder = payload.draftOrder;
    if (!draftOrder) {
      throw new AdminApiError("draftOrderComplete", [
        "response carried no userErrors but also no draftOrder",
      ]);
    }
    if (draftOrder.id !== input.draftOrderGid) {
      throw new AdminApiError("draftOrderComplete", [
        `expected draft order ${input.draftOrderGid} but the response named ${draftOrder.id}`,
      ]);
    }
    if (!draftOrder.order) {
      throw new AdminApiError("draftOrderComplete", [
        "response named the expected draft order but no order was created from it",
      ]);
    }

    return { orderGid: draftOrder.order.id, orderName: draftOrder.order.name };
  }

  async cancelDraftOrder(input: CancelDraftOrderInput): Promise<{ cancelledDraftOrderGid: string }> {
    const variables = { input: { id: input.draftOrderGid } };

    const payload = await this.runDraftOrderMutation<{
      deletedId?: string | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>("draftOrderDelete", CANCEL_DRAFT_ORDER_MUTATION, variables, "draftOrderDelete");

    if (!payload.deletedId) {
      throw new AdminApiError("draftOrderDelete", [
        "response carried no userErrors but also no deletedId",
      ]);
    }
    if (payload.deletedId !== input.draftOrderGid) {
      throw new AdminApiError("draftOrderDelete", [
        `expected to delete draft order ${input.draftOrderGid} but the response named ${payload.deletedId}`,
      ]);
    }

    return { cancelledDraftOrderGid: payload.deletedId };
  }
}
