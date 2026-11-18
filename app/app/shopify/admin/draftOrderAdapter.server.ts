import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";
import { minorUnitsToDecimalString } from "./priceSyncAdapter.server";
import { Money } from "~/domain/money/money";
import { CurrencyMismatchError } from "~/domain/money/errors";
import type { AvailableShippingRate } from "~/domain/shipping/shippingRateSelection";

export type { AvailableShippingRate };

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
        # READ BACK SO THE SHIPPING CHARGE CAN BE VERIFIED, not for display.
        # We send a signed rate HANDLE and Shopify decides the price from it,
        # so this is the only way to confirm the amount Shopify applied is the
        # amount the customer was quoted. A stale handle, or one calculated
        # against a different destination, that resolved to some other service
        # would otherwise stay invisible until a customer complained.
        shippingLine { title }
        totalShippingPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }`;

/**
 * THE SHIPPING RATES SHOPIFY WOULD OFFER FOR A DRAFT, WITHOUT CREATING ONE.
 *
 * `draftOrderCalculate` is a mutation by GraphQL convention but it persists
 * nothing — verified against production, where the draft-order count was 0
 * before and after every probe. That is what makes it safe to call on a quote
 * request, before the customer has committed to anything.
 *
 * `availableShippingRates` comes from the SAME delivery profile that native
 * Card checkout reads, evaluated against the line prices sent here. Because
 * the Bank Payment path sends Bank Payment prices, the $1,000 threshold is
 * evaluated against the Bank Payment merchandise total without this app ever
 * knowing the threshold exists.
 *
 * A `variantId` IS REQUIRED for rates to come back at all. A custom line with
 * only a title and a price returns an EMPTY rate list — measured, not assumed
 * — because a line with no variant has no shipping requirement and no
 * delivery-profile association. That is why the Custom Jewelry and quote
 * redemption flows, whose lines are custom, cannot simply adopt this method.
 */
const CALCULATE_SHIPPING_RATES_MUTATION = `#graphql
  mutation CaratCalculateDraftOrderShippingRates($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        availableShippingRates {
          handle
          title
          price { amount currencyCode }
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

/**
 * A SEPARATE create mutation for a redemption draft order, rather than fields
 * added to CREATE_DRAFT_ORDER_MUTATION above.
 *
 * That one serves Bank Payment Checkout: money-critical, live-proven, and
 * carrying the scars that made it so. Widening its response shape to carry a
 * discount every Bank Payment order will never have would put the two paths'
 * echo checks in one place, where a change for one can only be reasoned about
 * by checking it does not break the other. These two mutations have nothing to
 * say to each other, so they are two mutations.
 *
 * `allowDiscountCodesInCheckout` and `appliedDiscount` are both READ BACK, not
 * merely sent — see `createRedemptionDraftOrder`.
 */
const CREATE_REDEMPTION_DRAFT_ORDER_MUTATION = `#graphql
  mutation CaratCreateRedemptionDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
        # Boolean! on the output type, so this cannot come back null and be
        # mistaken for "false". Verified by introspection, 2026-10-10.
        allowDiscountCodesInCheckout
        appliedDiscount {
          valueType
          # amountSet, NOT value: the value field is a Float! on both the input
          # and the output, and money is never compared as a float here.
          # amountSet is a MoneyBag, i.e. a decimal string, which compares
          # exactly.
          amountSet { shopMoney { amount currencyCode } }
        }
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

const CANCEL_DRAFT_ORDER_MUTATION = `#graphql
  mutation CaratCancelDraftOrder($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }`;

/**
 * The zero-price shipping line title.
 *
 * ============================================================================
 * SUPERSEDED FOR SHIPPABLE MERCHANDISE — OWNER DECISION 2026-11-15
 * ============================================================================
 * This used to be applied unconditionally by `createDraftOrder`,
 * `createRedemptionDraftOrder` and `createCustomJewelryDraftOrder` under spec
 * §4 **D19**, on the reasoning that shipping and insurance were already inside
 * landed cost and a separate charge would bill the customer twice.
 *
 * The owner superseded D19 on the shipping question on 2026-11-15:
 * **CaratForUs shipping rules apply consistently regardless of payment
 * method**, and selecting Bank Payment must not earn free shipping.
 * `docs/SHIPPING-AND-DELIVERY.md` controls.
 *
 * The double-charge argument was also checked against the data rather than
 * taken on trust, because it was the one thing that could have made the new
 * decision incoherent. It does not apply. The production `cost_component`
 * rows are `shipping` = **$12.00** and `insurance` = **$3.00**, both
 * `cost_side` — they enter landed cost `C` and are then marked up by the
 * margin solve. They are an internal fulfilment-cost ALLOWANCE protecting
 * margin, not a customer shipping charge passed through at face value: $12 is
 * not $30 and not $55, and no arithmetic anywhere turns one into the other. So
 * there was never a dollar-for-dollar customer shipping amount embedded in the
 * merchandise price, and charging the policy rate does not bill anything
 * twice. The pricing engine is therefore UNCHANGED (owner: "if shipping and
 * insurance is merely an internal cost input... do not unnecessarily rewrite
 * the pricing engine"). `shippingCostAllowanceFence.test.ts` pins the
 * distinction so a later reader cannot quietly re-import the old reasoning.
 *
 * WHAT STILL USES THIS CONSTANT: `createRedemptionDraftOrder` and
 * `createCustomJewelryDraftOrder`, and only because resolving them needs a
 * different owner decision. Both ship physical jewellery, so a zero shipping
 * line on them is a real gap against `docs/SHIPPING-AND-DELIVERY.md` §2 — but
 * both also price from a figure the customer has already formally AGREED (a
 * competitor-matched quote, and an approved custom-design price held as
 * versioned acknowledgment evidence), so adding $30 or $55 afterwards changes
 * an agreed total. Both treat Card and Bank Payment identically today, so
 * neither breaks the consistency-between-payment-methods rule that the
 * 2026-11-15 decision actually states. Flagged in §8 of that document rather
 * than silently changed here.
 *
 * `createServiceDraftOrder` sets NO shipping line at all, which is correct and
 * permanent: the $49 Custom Jewelry design deposit is a service with nothing
 * to ship, so there is no shipping fact to state either way.
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
 * A Shopify MoneyBag decimal string to integer minor units, or null if it is
 * not a plain decimal amount.
 *
 * ============================================================================
 * WHY A MONEYBAG AMOUNT CANNOT BE COMPARED AS A STRING
 * ============================================================================
 * A LIVE GATE CAUGHT THIS, and it was a production defect in two methods.
 *
 * `appliedDiscount.amountSet.shopMoney.amount` is composed by Shopify, and
 * Shopify normalises trailing zeros: send "149.00" and it returns "149.0". The
 * echo checks compared those as strings, so they REFUSED a draft order Shopify
 * had stored perfectly — the discount was `FIXED_AMOUNT`, the value was 149,
 * and the order total came back at exactly the expected balance.
 *
 * Every unit test passed, because a mocked client echoes back whatever it was
 * handed. Only a real call could surface it, which is the entire argument for
 * the live gate: `createRedemptionDraftOrder` had shipped with the same
 * comparison and would have thrown on every live redemption.
 *
 * A LINE PRICE IS DIFFERENT, and still compared as a string. `originalUnitPrice`
 * is a value we SENT, echoed back verbatim — the Slice 9 live gate confirmed it
 * round-trips exactly as "49.00" — and string equality is the strictest check
 * available for the field an ignored-price defect would corrupt. A MoneyBag is
 * Shopify's own composition, so the strictest HONEST check is by value.
 *
 * Returns null rather than throwing so the caller can report the raw string it
 * could not read, which is more useful than a parse error.
 */
function moneyBagAmountToMinorUnits(amount: string): bigint | null {
  const cleaned = amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

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

/**
 * One line-item custom attribute. Shopify surfaces a draft order line's
 * `customAttributes` as the resulting ORDER line item's `properties` — which
 * is the shape `orders/create` webhook consumers read — so this is how a
 * draft-order path carries evidence that a cart-based path attaches at
 * add-to-cart time.
 *
 * `key`/`value` here, `name`/`value` in the webhook payload: the rename is
 * Shopify's, not ours. Do not "fix" it.
 */
export interface DraftOrderLineItemAttributeInput {
  key: string;
  value: string;
}

export interface DraftOrderLineItemInput {
  /** The Shopify product variant this line charges for. */
  shopifyVariantGid: string;
  quantity: number;
  /**
   * Attributes to attach to this line, transported verbatim. Omit (or pass
   * empty) to send none — the field is then absent from the mutation input
   * entirely rather than sent as `[]`, so a caller that does not use
   * attributes cannot accidentally clear anything.
   *
   * REQUIRED, IN PRACTICE, FOR GROUP BUY. A Group Buy line must carry
   * `GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME`; without
   * it the `orders/create` handler verifies the line as `unmatched`, holds it,
   * and records ZERO qualifying units. This adapter cannot enforce that —
   * it serves Buy Now verification screens too, which have no such property —
   * so the obligation sits with the caller and is pinned by that caller's own
   * tests.
   */
  customAttributes?: readonly DraftOrderLineItemAttributeInput[];
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

/**
 * What `calculateAvailableShippingRates` needs: where it is going, and what
 * each line will actually be charged under the payment method in question.
 * Deliberately NOT the whole `CreateDraftOrderInput` — a rate quote needs no
 * email, no customer identity, no tags, no note, and asking for them would
 * invite a caller to think a quote and an order are the same request.
 */
export interface CalculateShippingRatesInput {
  shippingAddress: DraftOrderShippingAddressInput;
  lineItems: readonly DraftOrderLineItemInput[];
}

export interface CreateDraftOrderInput {
  /**
   * The AUTHENTICATED customer this order belongs to. Sent as `customerId` so
   * Shopify attaches the order to that exact customer record.
   *
   * WITHOUT IT, SHOPIFY INVENTS ONE. A draft order created with only an email
   * gets a customer matched or CREATED from that email, which is a different
   * record from the signed-in customer — different gid, same person. That was
   * a live production defect: every Group Buy Bank Payment order was attached
   * to an email-derived customer, so the `orders/create` handler compared the
   * order's customer against the acknowledgment's authenticated customer,
   * found `customer_mismatch`, held the line and counted ZERO units. The
   * acknowledgment check was right; the order was attached to the wrong
   * person. It also meant the order would not appear in the customer's own
   * account, which `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` requires.
   *
   * Optional only because Buy Now's verification-screen path predates it and
   * has no authenticated customer to pass. Any flow whose order must be
   * attributable to a signed-in customer MUST set it.
   */
  customerGid?: string;
  email: string;
  /**
   * Sent to Shopify and NOT returned by this adapter (criterion 97/99): this
   * class never persists it, and callers must not either. Retrieve the
   * address from Shopify at the time it is needed, never from a local copy.
   */
  shippingAddress: DraftOrderShippingAddressInput;
  lineItems: readonly DraftOrderLineItemInput[];
  /**
   * REQUIRED (owner decision 2026-11-15). Shopify's own signed handle for a
   * shipping rate it offered for this destination and basket, obtained from
   * `calculateAvailableShippingRates` and validated by
   * `resolveShippingRateSelection`.
   *
   * Non-optional on purpose. "Do not create an order until a valid shipping
   * service has been resolved" is a rule the type system can enforce for
   * free, and an optional field would let a future caller fall back to no
   * shipping line — which is precisely the superseded D19 behaviour, and the
   * failure mode that silently ships for free.
   */
  shippingRateHandle: string;
  /**
   * The price the customer was quoted for `shippingRateHandle`, for the echo
   * check only. NOT sent to Shopify: Shopify derives the charge from the
   * signed handle, and this adapter deliberately has no way to assert a
   * shipping amount. Supplying it here lets the adapter verify the two agree
   * and refuse the draft if they do not.
   */
  expectedShippingPrice: Money;
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

/**
 * A draft order for a SERVICE — one custom line, no variant, nothing to ship.
 * Deliberately NOT a variation of `CreateDraftOrderInput`: see
 * `createServiceDraftOrder`'s comment for why the money-critical Bank Payment
 * input is not loosened to accommodate this.
 */
export interface CreateServiceDraftOrderInput {
  /**
   * REQUIRED, unlike on `CreateDraftOrderInput`. Without it Shopify matches or
   * CREATES a customer from the email — a different record from the
   * authenticated one, which is exactly how every Group Buy Bank Payment order
   * ended up attached to the wrong person.
   */
  customerGid: string;
  email: string;
  /** What the customer sees as the line's name on the invoice. */
  title: string;
  /** The price for the single unit of this line. Quantity is always 1. */
  unitPrice: Money;
  customAttributes?: readonly DraftOrderLineItemAttributeInput[];
  /** Never put cost, margin or other admin-only data here — see `CreateDraftOrderInput.note`. */
  note?: string;
  tags?: readonly string[];
}

/**
 * A draft order carrying the Let Us Beat Your Quote fallback benefit as an
 * EXACT FIXED AMOUNT (owner decision, 2026-10-10).
 *
 * ============================================================================
 * WHY NOT A SHOPIFY DISCOUNT CODE — the owner's decision, and the reason
 * ============================================================================
 * A generic 10%-off code would compute its own number from whatever Shopify
 * considers discountable. That is not the benefit that was promised: the
 * amendment caps it at $100, limits it to eligible merchandise, and excludes
 * Group Buy lines, Luxury Steals, tax, shipping, duties and tips. A percentage
 * Shopify evaluates for itself gets all of that wrong in the customer's
 * favour, silently, on every order. A code is also bearer-usable — it can be
 * shared, and the benefit is non-transferable and single-use.
 *
 * So the amount is calculated server-side (`domain/beatyourquote/
 * redemptionCalculation.ts`), reserved against the benefit
 * (`jobs/beatyourquote/redeemFallbackBenefit.server.ts`), and sent here as a
 * figure Shopify does not get a vote on.
 */
export interface CreateRedemptionDraftOrderInput {
  /**
   * REQUIRED. Without `customerId` Shopify matches or CREATES a customer from
   * the email — a different record from the authenticated one. See
   * `CreateDraftOrderInput.customerGid`: that exact defect attached every Group
   * Buy Bank Payment order to the wrong person.
   *
   * It matters doubly here. The benefit is non-transferable, and order-time
   * verification compares the ORDER's customer against the reserving customer.
   * An order attached to an email-derived twin would fail that comparison and
   * send a legitimate redemption to staff review.
   */
  customerGid: string;
  email: string;
  shippingAddress: DraftOrderShippingAddressInput;
  lineItems: readonly DraftOrderLineItemInput[];
  /**
   * The EXACT discount, already calculated and reserved. This adapter does not
   * compute a percentage, apply a cap, or decide what is eligible — all three
   * happened before it was called, and all three are the substance of the
   * policy.
   */
  discount: Money;
  /** Shown to the customer on the invoice as the discount's name. */
  discountTitle: string;
  /** The reservation this draft order belongs to, for cross-reference from the Shopify admin. */
  redemptionIntentId: string;
  note?: string;
  tags?: readonly string[];
}

/**
 * A Custom Jewelry final purchase.
 *
 * ============================================================================
 * WHY THIS IS A THIRD METHOD AND NOT A FLAG ON AN EXISTING ONE
 * ============================================================================
 * It needs a combination none of the others has:
 *
 *   `createDraftOrder`          variant lines + payment terms, no discount
 *   `createServiceDraftOrder`   one custom line, no discount, no payment terms
 *   `createRedemptionDraftOrder` variant lines + a fixed discount, no terms
 *   THIS                        one custom line + a fixed discount, and
 *                               payment terms on the bank basis only
 *
 * Widening any of the three to cover this would make its own contract a matrix
 * a future reader has to solve before trusting it — and two of the three are
 * live-proven money paths whose narrowness is the reason they are trustworthy.
 *
 * ============================================================================
 * THE GROSS PRICE GOES ON THE LINE. THE CREDITS COME OFF AS A DISCOUNT.
 * ============================================================================
 * Owner requirement: "Never lose the gross approved price simply because only
 * the balance is collected at final checkout." So Shopify is told the piece
 * costs the full approved amount and that a fixed sum is deducted — rather than
 * a line priced at the balance, which would record the sale at the wrong
 * figure in the one system the customer and an accountant both look at.
 *
 * SHOPIFY HAS NO "CREDIT" PRIMITIVE for a draft order; `appliedDiscount` is the
 * only mechanism, and it is singular. So the deposit credit and any Let Us Beat
 * Your Quote benefit are summed into one discount whose TITLE names each
 * component, and our own `custom_jewelry_final_purchase` row keeps them in
 * separate columns. That split is deliberate: the authoritative accounting is
 * ours, and Shopify carries a faithful customer-facing summary of it.
 */
export interface CreateCustomJewelryDraftOrderInput {
  /**
   * REQUIRED. Without `customerId` Shopify matches or CREATES a customer from
   * the email — a different record from the authenticated one. See
   * `CreateDraftOrderInput.customerGid`: that exact defect attached every Group
   * Buy Bank Payment order to the wrong person.
   */
  customerGid: string;
  email: string;
  shippingAddress: DraftOrderShippingAddressInput;
  /** What the customer sees as the line's name on the invoice. */
  title: string;
  /** The GROSS approved price for the piece. Never the balance. */
  grossPrice: Money;
  /**
   * The deposit credit plus any benefit, already summed by the caller. Zero is
   * legitimate — a project with no deposit and no benefit.
   */
  totalCredit: Money;
  /** Names each component of the credit, for the invoice. */
  creditTitle: string;
  /**
   * Which basis. `bank_payment` attaches "Due on receipt" payment terms so the
   * resulting order stays UNPAID until an admin verifies the transfer (§22);
   * `card` attaches none, so the order becomes paid exactly when the customer
   * pays through Shopify's checkout.
   */
  paymentBasis: "card" | "bank_payment";
  customAttributes?: readonly DraftOrderLineItemAttributeInput[];
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
  /**
   * The shipping services Shopify would offer for this destination and these
   * charged line prices. Creates nothing. Returns an EMPTY array for an
   * undeliverable destination — callers must refuse the checkout, never
   * proceed with no shipping line (owner decision 2026-11-15).
   */
  calculateAvailableShippingRates(
    input: CalculateShippingRatesInput
  ): Promise<readonly AvailableShippingRate[]>;
  createDraftOrder(input: CreateDraftOrderInput): Promise<CreatedDraftOrder>;

  /**
   * `draftOrderCreate` for a SERVICE — one custom line, no variant, no
   * shipping, no payment terms. Takes `originalUnitPriceWithCurrency` rather
   * than `priceOverride` because a custom line has no catalogue price to
   * override; see the implementation's comment for why that distinction has
   * already cost one live defect.
   */
  createServiceDraftOrder(input: CreateServiceDraftOrderInput): Promise<CreatedDraftOrder>;

  /**
   * `draftOrderCreate` carrying an exact fixed-amount discount and REFUSING
   * further discount codes at checkout. Both are read back before this returns.
   */
  createRedemptionDraftOrder(input: CreateRedemptionDraftOrderInput): Promise<CreatedDraftOrder>;

  /**
   * `draftOrderCreate` for a Custom Jewelry final purchase: ONE CUSTOM LINE at
   * the gross approved price, less an exact fixed discount for the deposit
   * credit and any benefit, with payment terms only on the Bank Payment basis.
   */
  createCustomJewelryDraftOrder(input: CreateCustomJewelryDraftOrderInput): Promise<CreatedDraftOrder>;

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

  async calculateAvailableShippingRates(
    input: CalculateShippingRatesInput
  ): Promise<readonly AvailableShippingRate[]> {
    if (input.lineItems.length === 0) {
      throw new AdminApiError("draftOrderCalculate", ["cannot calculate shipping for zero line items"]);
    }

    const variables = {
      input: {
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
        // `priceOverride`, not the variant's own Shopify price. The whole
        // point is to have Shopify evaluate its rate conditions against the
        // price THIS payment method will actually charge.
        lineItems: input.lineItems.map((line) => ({
          variantId: line.shopifyVariantGid,
          quantity: line.quantity,
          priceOverride: {
            amount: minorUnitsToDecimalString(line.unitPrice.amountMinorUnits),
            currencyCode: line.unitPrice.currency,
          },
        })),
      },
    };

    const payload = await this.runDraftOrderMutation<{
      calculatedDraftOrder?: {
        availableShippingRates?: {
          handle: string;
          title: string;
          price?: { amount: string; currencyCode: string } | null;
        }[];
      } | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>(
      "draftOrderCalculate",
      CALCULATE_SHIPPING_RATES_MUTATION,
      variables,
      "draftOrderCalculate"
    );

    const rates = payload.calculatedDraftOrder?.availableShippingRates ?? [];
    const resolved: AvailableShippingRate[] = [];
    for (const rate of rates) {
      // A rate whose price cannot be read is DROPPED, not defaulted to zero.
      // Defaulting would invent free shipping out of a parsing failure, which
      // is the one outcome this whole change exists to prevent.
      if (!rate.price) continue;
      const minorUnits = moneyBagAmountToMinorUnits(rate.price.amount);
      if (minorUnits === null) continue;
      resolved.push({
        handle: rate.handle,
        title: rate.title,
        priceMinorUnits: minorUnits,
        currency: rate.price.currencyCode,
      });
    }
    return resolved;
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
        // Spread-conditional so an absent/empty list sends NO field at all
        // rather than `customAttributes: []` — see the input type's comment.
        ...(line.customAttributes && line.customAttributes.length > 0
          ? { customAttributes: line.customAttributes.map((a) => ({ key: a.key, value: a.value })) }
          : {}),
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
        // Spread-conditional so the Buy Now path, which has no authenticated
        // customer to attach, sends no `customerId` at all rather than null.
        ...(input.customerGid ? { customerId: input.customerGid } : {}),
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
        // ====================================================================
        // THE HANDLE, NOT A PRICE (owner decision 2026-11-15).
        // ====================================================================
        // `shippingRateHandle` is Shopify's own signed claim for a rate it
        // offered for THIS draft. Passing it means Shopify applies the title
        // and the price from that claim, so this adapter never asserts a
        // shipping amount and there is no number here that could disagree with
        // what the customer was quoted.
        //
        // Required, not optional: `CreateDraftOrderInput.shippingRateHandle`
        // is a non-optional field, so a caller cannot reach this mutation
        // without having resolved a real service first. That is the type
        // system enforcing "do not create an order until a valid shipping
        // service has been resolved", rather than a runtime check someone can
        // forget. The old unconditional zero line is gone — see
        // ZERO_SHIPPING_LINE_TITLE's comment for why it survives for services.
        shippingLine: { shippingRateHandle: input.shippingRateHandle },
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
        shippingLine?: { title: string | null } | null;
        totalShippingPriceSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
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

    // STEP 6 — THE SHIPPING ECHO CHECK (owner decision 2026-11-15).
    //
    // We sent a signed handle, not a price, so Shopify alone decided what to
    // charge. This confirms it decided the same thing the customer was
    // quoted. Compared in MINOR UNITS, never as strings: Shopify normalises
    // "30.00" to "30.0", and comparing those as text is the exact defect that
    // once made this adapter refuse perfectly good draft orders (see
    // `moneyBagAmountToMinorUnits`).
    //
    // A missing shipping line is a failure, not a pass. If the handle were
    // silently ignored the draft would carry no shipping at all, which is both
    // free shipping and the superseded D19 behaviour returning by the back
    // door — so absence is checked explicitly rather than treated as zero.
    const returnedShipping = draftOrder.totalShippingPriceSet?.shopMoney;
    if (!returnedShipping) {
      throw new AdminApiError("draftOrderCreate", [
        "sent a shipping rate handle but the response echoed no shipping total",
      ]);
    }
    const returnedShippingMinorUnits = moneyBagAmountToMinorUnits(returnedShipping.amount);
    if (returnedShippingMinorUnits === null) {
      throw new AdminApiError("draftOrderCreate", [
        `shipping total "${returnedShipping.amount}" is not a plain decimal amount`,
      ]);
    }
    if (returnedShippingMinorUnits !== input.expectedShippingPrice.amountMinorUnits) {
      throw new AdminApiError("draftOrderCreate", [
        `shipping charge mismatch — the customer was quoted ` +
          `${minorUnitsToDecimalString(input.expectedShippingPrice.amountMinorUnits)} but Shopify applied ` +
          `${returnedShipping.amount} for "${draftOrder.shippingLine?.title ?? "(no title)"}"`,
      ]);
    }
    if (returnedShipping.currencyCode !== input.expectedShippingPrice.currency) {
      throw new AdminApiError("draftOrderCreate", [
        `shipping currency mismatch — expected ${input.expectedShippingPrice.currency} but Shopify applied ${returnedShipping.currencyCode}`,
      ]);
    }

    return {
      draftOrderGid: draftOrder.id,
      invoiceUrl: draftOrder.invoiceUrl,
    };
  }

  /**
   * A draft order for a SERVICE — one custom line, no product variant, no
   * shipping address. Built for the $49 Custom Jewelry Design Deposit.
   *
   * ============================================================================
   * WHY THIS IS A SEPARATE METHOD RATHER THAN OPTIONS ON `createDraftOrder`
   * ============================================================================
   * `createDraftOrder` serves Bank Payment Checkout, which is money-critical
   * and live-proven. Making its `shippingAddress` optional and its
   * `shopifyVariantGid` nullable to accommodate a deposit would weaken the
   * contract that path depends on, so that every future reader has to work out
   * which combination of optional fields is legal for which caller. A separate
   * method with its own narrow input cannot do that.
   *
   * ============================================================================
   * A DIFFERENT PRICE FIELD, AND THAT IS THE WHOLE PRICE
   * ============================================================================
   * `createDraftOrder` sends `priceOverride`, which is correct for a line that
   * has a `variantId` — it replaces the variant's catalogue price. A CUSTOM
   * line has no catalogue price to override. Shopify's own description is
   * explicit that `originalUnitPriceWithCurrency` is "for custom line items"
   * and is "ignored when variantId is provided", so the two cases genuinely
   * take different fields.
   *
   * THAT DISTINCTION ALREADY COST ONE LIVE DEFECT. This adapter first sent
   * `originalUnitPrice` on variant lines; Shopify neither errored nor coerced,
   * it silently ignored the field and charged the catalogue price. No unit test
   * could have caught it — a mocked client echoes back whatever it is handed.
   * Only the live echo check found it.
   *
   * SO THIS METHOD IS LIVE-VERIFIED, 2026-10-09:
   * `tests/live/slice9.depositInvoicePriceField.ts`, 5/5 against
   * caratforus-dev. It creates one real draft order, reads it back in a
   * SEPARATE query (the create response's echo comes from the same mutation,
   * so it cannot prove persistence), and asserts the line persisted at 49.00
   * with no variant attached — i.e. priced from
   * `originalUnitPriceWithCurrency` and not from a catalogue entry. The probe
   * order is deleted in a `finally`, and the cleanup is itself an assertion.
   *
   * Re-run it if this method's mutation input changes at all. The step-5 echo
   * check below is still what guards production at runtime.
   *
   * ============================================================================
   * NO SHIPPING LINE, DELIBERATELY
   * ============================================================================
   * `createDraftOrder` sends an explicit zero-price shipping line so the record
   * shows shipping was priced at nil on purpose. There is nothing to ship here
   * at all — a design deposit is work, not goods — so no shipping line is sent
   * rather than a zero one, which would imply a delivery that does not exist.
   *
   * NO PAYMENT TERMS EITHER, and that is the opposite choice from Bank Payment
   * for the opposite reason. A Bank Payment order must complete UNPAID because
   * the money moves outside Shopify. A deposit invoice is paid THROUGH
   * Shopify's own checkout, so the order should become paid exactly when the
   * customer pays — which is what happens with no payment terms attached.
   */
  async createServiceDraftOrder(input: CreateServiceDraftOrderInput): Promise<CreatedDraftOrder> {
    const priceDecimalString = minorUnitsToDecimalString(input.unitPrice.amountMinorUnits);
    const currency = input.unitPrice.currency;

    const variables = {
      input: {
        // REQUIRED HERE, not optional as on `createDraftOrder`. A deposit must
        // be attributable to the signed-in customer: without `customerId`,
        // Shopify matches or CREATES a customer from the email — a different
        // record from the authenticated one. That exact defect attached every
        // Group Buy Bank Payment order to the wrong person and counted zero
        // qualifying units.
        customerId: input.customerGid,
        email: input.email,
        lineItems: [
          {
            // No `variantId` — this IS the custom line.
            title: input.title,
            quantity: 1,
            // The custom-line price field. See the method comment.
            originalUnitPriceWithCurrency: {
              amount: priceDecimalString,
              currencyCode: currency,
            },
            ...(input.customAttributes && input.customAttributes.length > 0
              ? { customAttributes: input.customAttributes.map((a) => ({ key: a.key, value: a.value })) }
              : {}),
          },
        ],
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
      throw new AdminApiError("draftOrderCreate", ["response carried no userErrors but also no draftOrder"]);
    }

    // STEP 5 — echo check, and for this method it is the ONLY thing standing
    // between a wrong price field and a deposit charged at zero. Matched
    // positionally because there is exactly one line and it has no variant gid
    // to match on; the count check below is what makes that safe.
    const returnedLines = draftOrder.lineItems?.nodes ?? [];
    if (returnedLines.length !== 1) {
      throw new AdminApiError("draftOrderCreate", [
        `sent 1 custom line item but the response echoed ${returnedLines.length}`,
      ]);
    }
    const returned = returnedLines[0]!;
    if (returned.quantity !== 1) {
      throw new AdminApiError("draftOrderCreate", [
        `sent quantity 1 but Shopify echoed ${returned.quantity}`,
      ]);
    }
    if (returned.originalUnitPrice !== priceDecimalString) {
      throw new AdminApiError("draftOrderCreate", [
        `custom line price mismatch — sent ${priceDecimalString} but Shopify echoed ${returned.originalUnitPrice}. ` +
          `A deposit invoice for the wrong amount must never be issued.`,
      ]);
    }
    if (returned.variant?.id) {
      // A custom line must not somehow acquire a variant: that would mean
      // Shopify priced it from a catalogue entry rather than from what we sent.
      throw new AdminApiError("draftOrderCreate", [
        `sent a custom line with no variant but Shopify echoed variant ${returned.variant.id}`,
      ]);
    }

    return {
      draftOrderGid: draftOrder.id,
      invoiceUrl: draftOrder.invoiceUrl,
    };
  }

  /**
   * A draft order carrying the fallback benefit as an exact fixed amount.
   *
   * ============================================================================
   * THE DISCOUNT AMOUNT CROSSES A `Float!`, AND THAT IS HANDLED, NOT IGNORED
   * ============================================================================
   * `DraftOrderAppliedDiscountInput.value` is a `Float!` — required, and a
   * float, which CLAUDE.md rule 6 forbids for money. It cannot simply be
   * omitted. Two things make that safe rather than merely unavoidable:
   *
   *   1. NO ARITHMETIC IS DONE IN FLOATING POINT. The amount arrives as integer
   *      minor units, is rendered to a decimal string by the same function the
   *      live-proven price path uses, and only then parsed to a Number for this
   *      one field. The float is a transport format, not a calculation.
   *   2. THE PARSE IS CHECKED, NOT ASSUMED. The Number is rendered back to a
   *      decimal string and compared to the original; a mismatch throws before
   *      anything is sent. Every 2-decimal amount this business will ever
   *      discount round-trips a double exactly, so this guard should never
   *      fire — which is the point of asserting it rather than reasoning about
   *      it in a comment.
   *
   * `amountWithCurrency` (a `MoneyInput`, so a decimal string with an explicit
   * currency) is sent ALONGSIDE it. Both fields exist on the input type and
   * could in principle disagree; sending both from one source string means they
   * cannot, and the echo check below reads back `amountSet` — a MoneyBag, not a
   * float — to confirm which figure Shopify actually stored.
   *
   * ============================================================================
   * `allowDiscountCodesInCheckout: false` IS A POLICY CONTROL, NOT A SETTING
   * ============================================================================
   * Amendment §3 makes the benefit non-stackable unless CaratForUs expressly
   * authorizes a combination. `quoteRedemption` enforces that on OUR side by
   * refusing to calculate on top of another promotion — but that only governs
   * what we put on the order. Left at Shopify's default, the customer could
   * type a code into checkout afterwards and stack it anyway.
   *
   * It is READ BACK for the same reason the line prices are. A write-only flag
   * is a promise nobody checks, and `draftOrderAdapter`'s whole history is one
   * field that Shopify silently ignored.
   *
   * NOT YET LIVE-VERIFIED END TO END. The mutation's shape is confirmed against
   * caratforus-dev by `tests/live/slice10.redemptionDiscountSchemaIntrospection.ts`
   * (2026-10-10, all checks passed): `appliedDiscount`,
   * `allowDiscountCodesInCheckout`, `FIXED_AMOUNT`, and the readability of
   * `amountSet`/`allowDiscountCodesInCheckout` for the echo check. Introspection
   * proves the fields exist and are legal to send; it does not prove Shopify
   * honours them at runtime. The echo check below is what proves that, on every
   * real call.
   */
  async createRedemptionDraftOrder(input: CreateRedemptionDraftOrderInput): Promise<CreatedDraftOrder> {
    if (input.lineItems.length === 0) {
      throw new AdminApiError("draftOrderCreate", ["cannot create a redemption draft order with zero line items"]);
    }
    if (input.lineItems.length > MAX_VERIFIABLE_LINE_ITEMS) {
      throw new AdminApiError("draftOrderCreate", [
        `cannot verify more than ${MAX_VERIFIABLE_LINE_ITEMS} line items; received ${input.lineItems.length}`,
      ]);
    }
    if (input.discount.amountMinorUnits <= 0n) {
      // A zero discount would spend the customer's single-use benefit on
      // nothing. `quoteRedemption` already refuses this; refused again here
      // because this adapter must not depend on its caller having done so.
      throw new AdminApiError("draftOrderCreate", [
        `refusing to create a redemption draft order for a discount of ${input.discount.amountMinorUnits} minor units`,
      ]);
    }

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
    if (input.discount.currency !== currency) {
      throw new CurrencyMismatchError(currency, input.discount.currency);
    }

    const discountDecimalString = minorUnitsToDecimalString(input.discount.amountMinorUnits);
    // The checked parse. See the method comment: the schema requires a Float,
    // so the conversion is verified rather than trusted.
    const discountFloat = Number(discountDecimalString);
    if (!Number.isFinite(discountFloat) || discountFloat.toFixed(2) !== discountDecimalString) {
      throw new AdminApiError("draftOrderCreate", [
        `the discount ${discountDecimalString} does not survive conversion to the Float the API requires ` +
          `(got ${discountFloat}); refusing to send a discount amount that may not be exact`,
      ]);
    }

    const sentPriceByVariantGid = new Map<string, string>();
    const lineItemsVariables = input.lineItems.map((line) => {
      const priceDecimalString = minorUnitsToDecimalString(line.unitPrice.amountMinorUnits);
      sentPriceByVariantGid.set(line.shopifyVariantGid, priceDecimalString);
      return {
        variantId: line.shopifyVariantGid,
        quantity: line.quantity,
        ...(line.customAttributes && line.customAttributes.length > 0
          ? { customAttributes: line.customAttributes.map((a) => ({ key: a.key, value: a.value })) }
          : {}),
        // `priceOverride` for a variant line — see `createDraftOrder`'s comment
        // for why this is not `originalUnitPrice`.
        priceOverride: { amount: priceDecimalString, currencyCode: currency },
      };
    });

    const variables = {
      input: {
        customerId: input.customerGid,
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
        // Explicit nil shipping, same reasoning as `createDraftOrder` (D19):
        // shipping is already priced into the landed cost behind each line's
        // unit price, so a second shipping charge would bill it twice.
        shippingLine: {
          title: ZERO_SHIPPING_LINE_TITLE,
          price: minorUnitsToDecimalString(Money.zero(currency).amountMinorUnits),
        },
        // THE BENEFIT. FIXED_AMOUNT, not PERCENTAGE — the cap and the
        // merchandise-only exclusions mean a percentage Shopify evaluates for
        // itself is a different number from the one promised.
        appliedDiscount: {
          valueType: "FIXED_AMOUNT",
          value: discountFloat,
          amountWithCurrency: { amount: discountDecimalString, currencyCode: currency },
          title: input.discountTitle,
          description: `Let Us Beat Your Quote fallback benefit (redemption ${input.redemptionIntentId})`,
        },
        // Amendment §3's non-stacking promise, enforced at Shopify's checkout
        // rather than only in our own arithmetic.
        allowDiscountCodesInCheckout: false,
        // NO `reserveInventoryUntil`, and no payment terms: a redemption is
        // paid through Shopify's own checkout, so the order becomes paid
        // exactly when the customer pays — the opposite choice from Bank
        // Payment, for the opposite reason. See `createServiceDraftOrder`.
        note: input.note,
        tags: input.tags ? [...input.tags] : undefined,
      },
    };

    const payload = await this.runDraftOrderMutation<{
      draftOrder?: {
        id: string;
        invoiceUrl: string | null;
        allowDiscountCodesInCheckout?: boolean | null;
        appliedDiscount?: {
          valueType: string;
          amountSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
        } | null;
        lineItems?: { nodes?: { quantity: number; originalUnitPrice: string; variant?: { id: string } | null }[] };
      } | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>("draftOrderCreate", CREATE_REDEMPTION_DRAFT_ORDER_MUTATION, variables, "draftOrderCreate");

    const draftOrder = payload.draftOrder;
    if (!draftOrder) {
      throw new AdminApiError("draftOrderCreate", ["response carried no userErrors but also no draftOrder"]);
    }

    // STEP 5 — the echo check. Lines first, same discipline as
    // `createDraftOrder`: matched by variant gid, never by position.
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
          `variant ${variantGid}: price mismatch — sent ${sentPrice} but Shopify echoed ${returned.originalUnitPrice}`,
        ]);
      }
    }

    // THE DISCOUNT ITSELF. An ignored `appliedDiscount` would produce a draft
    // order at full price that our database records as a redeemed benefit —
    // the customer pays everything and loses the benefit.
    const applied = draftOrder.appliedDiscount;
    if (!applied) {
      throw new AdminApiError("draftOrderCreate", [
        `sent a ${discountDecimalString} ${currency} fixed-amount discount but the draft order came back with none`,
      ]);
    }
    if (applied.valueType !== "FIXED_AMOUNT") {
      throw new AdminApiError("draftOrderCreate", [
        `sent valueType FIXED_AMOUNT but Shopify stored ${applied.valueType}; a percentage would compute its own figure`,
      ]);
    }
    const storedAmount = applied.amountSet?.shopMoney;
    if (!storedAmount) {
      throw new AdminApiError("draftOrderCreate", [
        "the draft order's applied discount carried no amountSet to verify against",
      ]);
    }
    // COMPARED BY VALUE IN INTEGER MINOR UNITS, not as a string and not as a
    // float. Shopify normalises MoneyBag trailing zeros — send "50.00", get
    // "50.0" — so a string comparison here refused draft orders Shopify had
    // stored perfectly. A live gate caught it; see
    // `moneyBagAmountToMinorUnits`. The comparison is still exact, because
    // integer minor units are exact.
    const storedDiscountMinorUnits = moneyBagAmountToMinorUnits(storedAmount.amount);
    if (storedDiscountMinorUnits === null) {
      throw new AdminApiError("draftOrderCreate", [
        `Shopify returned a discount amount this adapter cannot read as a decimal: "${storedAmount.amount}"`,
      ]);
    }
    if (storedDiscountMinorUnits !== input.discount.amountMinorUnits) {
      throw new AdminApiError("draftOrderCreate", [
        `discount mismatch — sent ${discountDecimalString} (${input.discount.amountMinorUnits} minor units) ` +
          `but Shopify stored ${storedAmount.amount} (${storedDiscountMinorUnits} minor units). ` +
          `A redemption for the wrong amount must never be invoiced.`,
      ]);
    }
    if (storedAmount.currencyCode !== currency) {
      throw new AdminApiError("draftOrderCreate", [
        `discount currency mismatch — sent ${currency} but Shopify stored ${storedAmount.currencyCode}`,
      ]);
    }

    // THE NON-STACKING PROMISE. `Boolean!` on the output type, so `undefined`
    // here means the field was not returned at all — which is itself a
    // failure, not a false.
    if (draftOrder.allowDiscountCodesInCheckout !== false) {
      throw new AdminApiError("draftOrderCreate", [
        `sent allowDiscountCodesInCheckout:false but Shopify echoed ${String(draftOrder.allowDiscountCodesInCheckout)}; ` +
          `the fallback benefit is not stackable and must not be combinable at checkout`,
      ]);
    }

    return { draftOrderGid: draftOrder.id, invoiceUrl: draftOrder.invoiceUrl };
  }

  /**
   * A Custom Jewelry final purchase: one custom line at the gross approved
   * price, less an exact fixed credit.
   *
   * ============================================================================
   * THE PRICE FIELD IS `originalUnitPriceWithCurrency`, AND THAT MATTERS
   * ============================================================================
   * A custom line has no `variantId`, so it has no catalogue price to override.
   * `priceOverride` — correct for every variant line in this file — is ignored
   * without one. Shopify's own description is explicit that
   * `originalUnitPriceWithCurrency` is "for custom line items" and is "ignored
   * when variantId is provided".
   *
   * THAT DISTINCTION ALREADY COST ONE LIVE DEFECT in this adapter: it first
   * sent `originalUnitPrice` on variant lines, Shopify silently ignored the
   * field, and every line was charged the catalogue price. No unit test could
   * catch it — a mocked client echoes back whatever it is handed. The custom
   * field is live-verified by `tests/live/slice9.depositInvoicePriceField.ts`,
   * which created a real draft order and read it back in a SEPARATE query.
   *
   * ============================================================================
   * PAYMENT TERMS ON THE BANK BASIS ONLY, AND THAT IS §22
   * ============================================================================
   * A Bank Payment order must complete UNPAID: the money moves outside Shopify
   * and a human verifies it. Completing a draft with no payment terms produced
   * an order Shopify marked PAID — a live defect this adapter already hit —
   * which asserts a receipt nobody has seen. "Due on receipt" is the honest
   * term: owed now, not yet arrived.
   *
   * A card purchase is the opposite case for the opposite reason. It is paid
   * THROUGH Shopify's checkout, so the order should become paid exactly when
   * the customer pays, which is what happens with no terms attached.
   *
   * ============================================================================
   * EVERY FIGURE IS READ BACK
   * ============================================================================
   * The line price, the stored discount amount, its FIXED_AMOUNT type, and
   * `allowDiscountCodesInCheckout:false`. A write-only field is a promise
   * nobody checks, and this method writes four of them.
   */
  async createCustomJewelryDraftOrder(input: CreateCustomJewelryDraftOrderInput): Promise<CreatedDraftOrder> {
    const currency = input.grossPrice.currency;
    if (input.totalCredit.currency !== currency) {
      throw new CurrencyMismatchError(currency, input.totalCredit.currency);
    }
    if (input.grossPrice.amountMinorUnits <= 0n) {
      throw new AdminApiError("draftOrderCreate", [
        `refusing to invoice a custom jewelry piece at ${input.grossPrice.amountMinorUnits} minor units`,
      ]);
    }
    if (input.totalCredit.amountMinorUnits < 0n) {
      throw new AdminApiError("draftOrderCreate", ["a credit cannot be negative"]);
    }
    if (input.totalCredit.amountMinorUnits > input.grossPrice.amountMinorUnits) {
      // A credit larger than the price would make the balance negative, which
      // the purchase record's own CHECK also refuses. Caught here because this
      // is the last point before Shopify is told something incoherent.
      throw new AdminApiError("draftOrderCreate", [
        `the credit ${input.totalCredit.amountMinorUnits} exceeds the gross price ${input.grossPrice.amountMinorUnits}`,
      ]);
    }

    const grossDecimalString = minorUnitsToDecimalString(input.grossPrice.amountMinorUnits);
    const creditDecimalString = minorUnitsToDecimalString(input.totalCredit.amountMinorUnits);
    // The required `Float!` — see `createRedemptionDraftOrder` for why this is
    // parsed from an exact decimal string and then verified by round-trip
    // rather than computed.
    const creditFloat = Number(creditDecimalString);
    if (!Number.isFinite(creditFloat) || creditFloat.toFixed(2) !== creditDecimalString) {
      throw new AdminApiError("draftOrderCreate", [
        `the credit ${creditDecimalString} does not survive conversion to the Float the API requires ` +
          `(got ${creditFloat}); refusing to send an amount that may not be exact`,
      ]);
    }

    const variables = {
      input: {
        customerId: input.customerGid,
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
        lineItems: [
          {
            // No `variantId` — this IS the custom line.
            title: input.title,
            quantity: 1,
            originalUnitPriceWithCurrency: { amount: grossDecimalString, currencyCode: currency },
            ...(input.customAttributes && input.customAttributes.length > 0
              ? { customAttributes: input.customAttributes.map((a) => ({ key: a.key, value: a.value })) }
              : {}),
          },
        ],
        // Explicit nil shipping (D19): shipping and insurance are already
        // priced into the approved price, so a second charge bills them twice.
        shippingLine: {
          title: ZERO_SHIPPING_LINE_TITLE,
          price: minorUnitsToDecimalString(Money.zero(currency).amountMinorUnits),
        },
        // THE CREDIT. Sent only when there is one — an `appliedDiscount` of
        // zero would render a £0.00 discount line on the customer's invoice,
        // which invites the question "why is there a discount of nothing?".
        ...(input.totalCredit.amountMinorUnits > 0n
          ? {
              appliedDiscount: {
                valueType: "FIXED_AMOUNT",
                value: creditFloat,
                amountWithCurrency: { amount: creditDecimalString, currencyCode: currency },
                title: input.creditTitle,
                description: input.creditTitle,
              },
            }
          : {}),
        // The credit is not a promotion to be combined with. A customer typing
        // a code into this checkout would reduce an approved custom price.
        allowDiscountCodesInCheckout: false,
        // §22: bank orders complete UNPAID. Card orders become paid on payment.
        ...(input.paymentBasis === "bank_payment"
          ? { paymentTerms: { paymentTermsTemplateId: DUE_ON_RECEIPT_TEMPLATE_GID } }
          : {}),
        note: input.note,
        tags: input.tags ? [...input.tags] : undefined,
      },
    };

    const payload = await this.runDraftOrderMutation<{
      draftOrder?: {
        id: string;
        invoiceUrl: string | null;
        allowDiscountCodesInCheckout?: boolean | null;
        appliedDiscount?: {
          valueType: string;
          amountSet?: { shopMoney?: { amount: string; currencyCode: string } | null } | null;
        } | null;
        lineItems?: { nodes?: { quantity: number; originalUnitPrice: string; variant?: { id: string } | null }[] };
      } | null;
      userErrors?: { field?: string[] | null; message: string }[];
    }>("draftOrderCreate", CREATE_REDEMPTION_DRAFT_ORDER_MUTATION, variables, "draftOrderCreate");

    const draftOrder = payload.draftOrder;
    if (!draftOrder) {
      throw new AdminApiError("draftOrderCreate", ["response carried no userErrors but also no draftOrder"]);
    }

    // STEP 5 — the echo check. The line first: one custom line, at the GROSS
    // price, with no variant attached.
    const returnedLines = draftOrder.lineItems?.nodes ?? [];
    if (returnedLines.length !== 1) {
      throw new AdminApiError("draftOrderCreate", [
        `sent 1 custom line item but the response echoed ${returnedLines.length}`,
      ]);
    }
    const returned = returnedLines[0]!;
    if (returned.quantity !== 1) {
      throw new AdminApiError("draftOrderCreate", [`sent quantity 1 but Shopify echoed ${returned.quantity}`]);
    }
    if (returned.originalUnitPrice !== grossDecimalString) {
      throw new AdminApiError("draftOrderCreate", [
        `custom line price mismatch — sent ${grossDecimalString} but Shopify echoed ${returned.originalUnitPrice}. ` +
          `The gross approved price must reach Shopify exactly.`,
      ]);
    }
    if (returned.variant?.id) {
      // A custom line acquiring a variant would mean Shopify priced it from a
      // catalogue entry rather than from what we sent.
      throw new AdminApiError("draftOrderCreate", [
        `sent a custom line with no variant but Shopify echoed variant ${returned.variant.id}`,
      ]);
    }

    // THE CREDIT, when one was sent. An ignored `appliedDiscount` would invoice
    // the customer the full price having already taken their $49 — charging
    // them twice for the deposit.
    if (input.totalCredit.amountMinorUnits > 0n) {
      const applied = draftOrder.appliedDiscount;
      if (!applied) {
        throw new AdminApiError("draftOrderCreate", [
          `sent a ${creditDecimalString} ${currency} credit but the draft order came back with none; the ` +
            `customer would be invoiced the full price having already paid their deposit`,
        ]);
      }
      if (applied.valueType !== "FIXED_AMOUNT") {
        throw new AdminApiError("draftOrderCreate", [
          `sent valueType FIXED_AMOUNT but Shopify stored ${applied.valueType}`,
        ]);
      }
      const storedAmount = applied.amountSet?.shopMoney;
      if (!storedAmount) {
        throw new AdminApiError("draftOrderCreate", [
          "the draft order's applied credit carried no amountSet to verify against",
        ]);
      }
      // BY VALUE IN INTEGER MINOR UNITS. This is the exact comparison the live
      // gate failed on its first run: Shopify stored the credit correctly as
      // 149 and returned "149.0", and a string comparison against "149.00"
      // refused a perfectly good draft order. See
      // `moneyBagAmountToMinorUnits`.
      const storedCreditMinorUnits = moneyBagAmountToMinorUnits(storedAmount.amount);
      if (storedCreditMinorUnits === null) {
        throw new AdminApiError("draftOrderCreate", [
          `Shopify returned a credit amount this adapter cannot read as a decimal: "${storedAmount.amount}"`,
        ]);
      }
      if (storedCreditMinorUnits !== input.totalCredit.amountMinorUnits) {
        throw new AdminApiError("draftOrderCreate", [
          `credit mismatch — sent ${creditDecimalString} (${input.totalCredit.amountMinorUnits} minor units) ` +
            `but Shopify stored ${storedAmount.amount} (${storedCreditMinorUnits} minor units). The customer ` +
            `would be invoiced the wrong balance having already paid their deposit.`,
        ]);
      }
      if (storedAmount.currencyCode !== currency) {
        throw new AdminApiError("draftOrderCreate", [
          `credit currency mismatch — sent ${currency} but Shopify stored ${storedAmount.currencyCode}`,
        ]);
      }
    }

    // `Boolean!` on the output type, so `undefined` means the field was not
    // returned at all — itself a failure, not a false.
    if (draftOrder.allowDiscountCodesInCheckout !== false) {
      throw new AdminApiError("draftOrderCreate", [
        `sent allowDiscountCodesInCheckout:false but Shopify echoed ${String(draftOrder.allowDiscountCodesInCheckout)}; ` +
          `a code typed at this checkout would reduce an approved custom price`,
      ]);
    }

    return { draftOrderGid: draftOrder.id, invoiceUrl: draftOrder.invoiceUrl };
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
