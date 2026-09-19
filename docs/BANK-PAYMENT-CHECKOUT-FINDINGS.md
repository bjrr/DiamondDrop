# Bank Payment at Checkout — Shopify Platform Findings

## Status

**ENGINEERING FINDING, 2026-09-18. RESOLVED BY OWNER DECISION, 2026-09-19:**
MVP1 ships display only. Bank Payment is an advertised alternative requiring
customer contact; draft-order automation is deferred to a separate future
checkout/payment decision.

Raised against `docs/BANK-CARD-PRICING.md` §8, which requires:

> When the customer selects an eligible Bank Payment method:
> **Final amount due = Bank Payment Price**

and instructs engineering to "verify what Shopify checkout/payment capabilities
are available … or explicitly surface the platform limitation before release. Do
not silently fake this behavior only on the product page/cart."

The pricing engine, App Proxy DTO and theme block are complete and correct.
What follows is about the payment step, where §1 documents a hard platform
limitation and §3 records what was decided about it.

## 1. The finding

**Shopify cannot change the payable total based on which payment method the
customer selects.** This is a platform limitation, not a configuration gap.

Three mechanisms exist that look like they might do it. None does.

### Payment Customization Functions (Shopify Plus)

The Function API that runs at payment-method selection exposes exactly these
operations:

- hide a payment method
- move (reorder) a payment method
- rename a payment method
- set payment terms (net/fixed/event-based, with optional deposit)
- require order review before completion (B2B only)

There is **no operation that alters price, line items, discounts or the order
total.** The API is limited to how payment options are presented and when
payment is due — not what is paid.

### Discount Functions

Discount Functions can change what is owed, but they run on the cart before
payment selection and receive no payment-method input. There is no ordering in
which a discount could react to a choice the customer has not yet made.

### Manual payment methods

Shopify supports manual/offline payment methods (bank deposit, bank transfer,
money order, custom) on all plans. Selecting one marks the order as awaiting
payment. **It does not change the total.** The customer is recorded as owing the
Regular/Card Price and then instructed to transfer that amount.

### Net conclusion

An online-store checkout will collect the **Regular/Card Price** regardless of
the method chosen. Any implementation that shows a lower Bank Payment Price on
the product page and then lets the customer reach checkout expecting to pay it
would be the "silently fake" outcome §8 prohibits.

## 2. What IS supported

### Draft orders (recommended)

A draft order can carry **any total**, including one derived from the Bank
Payment Price, and can be sent to the customer as an invoice payable by a manual
method. This is the only native Shopify mechanism that charges a genuinely
different amount for a bank payment.

Trade-offs, stated plainly:

- it is **not the standard checkout**. The customer leaves the normal flow,
  requests bank payment, and receives an invoice;
- it is **not instant**. A draft order is created by staff or by the app through
  the Admin API, so there is a step between intent and invoice;
- **inventory is not held** by a draft order the way a completed checkout holds
  it. For Luxury Steals, where scarcity is the product, that gap is material and
  needs its own decision;
- Group Buy interacts with this: a campaign price is frozen, so an invoice must
  quote the frozen tier price and be reconciled against the final tier at close,
  exactly as a card order is.

### Post-purchase order editing

The customer completes checkout at the Regular/Card Price, then the order is
edited down and the difference refunded. Rejected as a recommendation: the
customer is charged the higher amount first, card fees are incurred on the full
amount (defeating the purpose), and a refund on every bank order is operational
work plus a second chargeback surface.

## 3. Recommended implementation

**Phase 1 — display only. THIS IS WHAT SHIPS, and it is the whole of MVP1.**

Owner decision, 2026-09-19: for MVP1 the Bank Payment Price is an advertised
alternative that requires the customer to contact us and arrange payment. It is
not a checkout option, and the storefront must not imply that it is.

The Regular/Card Price is the published Shopify price and the price standard
checkout collects. The Bank Payment Price and its exact saving are displayed on
the product page and in the Group Buy block. **No claim is made at checkout that
a bank method will charge less**, because at that point it would not.

Copy is therefore accurate about how to obtain the bank price — a contact step,
not a payment-method radio button. OWNER-APPROVED WORDING, shipped verbatim:

> Bank Payment Price: $X
> Save $Y with Bank Payment
> Available with Zelle, bank transfer, ACH, or wire. Contact us to arrange payment.

Asserted character-for-character by the theme source guards, because a
well-meant rewording is the likeliest way approved copy drifts.

**Phase 2 — draft-order invoice flow. DEFERRED by owner decision, 2026-09-19.**

NOT part of this pricing slice and not implemented. No `write_draft_orders`
scope is requested and no inventory behaviour changes here. Recorded so the
option is not rediscovered from scratch when checkout and payment are taken up
as their own piece of work.

A "Pay by bank transfer" action on the product page creates a draft order at the
Bank Payment Price and emails the invoice. Requires: Admin API `write_draft_orders`
scope (today the app holds only `read_products, write_products`), a decision on
inventory holding, and a decision on how Group Buy campaigns issue and reconcile
invoices.

## 4. What must not be done

- Publishing the Bank Payment Price to Shopify as the product price. It is the
  lower of the two; every card sale would then be undercharged.
- Showing "select bank transfer at checkout to pay $X" while checkout charges
  the card price.
- Hiding card payment methods to force bank payment. Payment Customization can
  hide methods, but hiding cards does not lower the total — it removes the
  customer's ability to pay at all.

## 5. Sources

- [Payment Customization Function API](https://shopify.dev/docs/api/functions/latest/payment-customization) — enumerates the available operations; none modifies price.
- [Shopify Help Center — Considerations for editing orders](https://help.shopify.com/en/manual/fulfillment/managing-orders/editing-orders/considerations) — order-level discounts applied at checkout cannot be modified afterwards.
- [Shopify Help Center — Creating draft orders](https://help.shopify.com/en/manual/fulfillment/managing-orders/create-orders/create-draft) and [Getting paid for draft orders](https://help.shopify.com/en/manual/fulfillment/managing-orders/create-orders/get-paid) — arbitrary totals, manual payment methods, invoicing.
- [Shopify Community — Discounts based on payment methods](https://community.shopify.com/t/discounts-based-on-payment-methods/370228) — no native support; the documented workarounds hide methods rather than change totals.
