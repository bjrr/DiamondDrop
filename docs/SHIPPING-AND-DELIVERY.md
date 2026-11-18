# Shipping & Delivery — MVP1 LOCKED DECISION

This document is the authoritative CaratForUs MVP1 shipping and delivery policy. If an older README summary, storefront draft, launch note, theme copy, or configuration conflicts with this document, **this document controls**.

## 1. Core shipment requirements

For every outbound customer shipment:

- insure the shipment for the full order value;
- provide tracking;
- require signature confirmation;
- customers may not waive the required signature;
- use the checkout/payment-approved shipping address unless a later change is explicitly reviewed and documented;
- preserve carrier/service, tracking, ship date, insured value/reference where available, signature flag, delivery evidence, address changes, and claim/exception references.

This supersedes the older rule that required signature only above $100.

## 2. Contiguous 48 states — standard shipping program

The standard CaratForUs shipping program applies to the **contiguous 48 U.S. states only**.

### Orders below $1,000 after discounts

For a qualifying merchandise total below **$1,000.00** after all merchandise discounts and pricing reductions, including the Bank Payment discount where applicable, offer:

- **Standard Insured Shipping with Signature — $30 — 3–5 business days**
- **Express Insured Shipping with Signature — $55 — 1–2 business days**

The stated 3–5 and 1–2 business-day windows are **carrier transit times after shipment**, not order-processing times.

### Orders $1,000 and above after discounts

For a qualifying merchandise total of **$1,000.00 or more** after all merchandise discounts and pricing reductions, including the Bank Payment discount where applicable, offer:

- **Complimentary Express Insured Shipping with Signature — 1–2 business days**

Do **not** offer paid Standard shipping once the order qualifies for complimentary Express shipping.

The $1,000 threshold is evaluated from the final qualifying merchandise total after discounts. Taxes, shipping charges, duties, and other non-merchandise charges do not count toward the threshold.

## 3. Alaska and Hawaii

Alaska and Hawaii are a separate shipping zone.

For Alaska and Hawaii:

- offer insured shipping with signature at the applicable actual/calculated carrier rate;
- do not include these destinations in the contiguous-48 flat-rate program;
- do not offer the $1,000 complimentary-Express benefit initially;
- use the carrier's actual service estimate rather than promising the contiguous-48 1–2 or 3–5 business-day windows when the carrier does not support them for the destination.

This policy may be revisited after CaratForUs has enough real shipping history to decide whether to subsidize Alaska/Hawaii rates.

## 4. Processing and production time

Shipping/transit time begins **after the order is ready and handed to the carrier**.

Current operational guidance:

- in-stock orders: approximately **1–2 business days processing** before shipment;
- ring sizing: may add approximately **3–5 business days**;
- made-to-order pieces: generally approximately **3–6 weeks** before shipment unless a product states a more specific lead time.

Do not present processing/production time as carrier transit time.

## 5. Customer-facing wording

Preferred customer-facing service names:

- **Standard Insured Shipping with Signature — 3–5 business days**
- **Express Insured Shipping with Signature — 1–2 business days**
- **Complimentary Express Insured Shipping with Signature — 1–2 business days**

For Alaska and Hawaii:

> Insured shipping with signature is available at the applicable carrier rate. Delivery times vary by destination and are shown at checkout.

Do not promise a carrier-specific delivery-by time (for example, 10:30 AM, noon, or end of day) unless the actual purchased carrier service provides that commitment and CaratForUs intentionally adopts it.

## 6. Checkout acceptance criteria

Before launch, verify checkout behavior against real runtime rates, not configuration storage alone.

At minimum:

1. A contiguous-48 order below $1,000 after discounts shows exactly:
   - Standard insured shipping with signature — $30;
   - Express insured shipping with signature — $55;
   - no free option.
2. A contiguous-48 order at or above $1,000 after discounts shows:
   - complimentary Express insured shipping with signature;
   - no paid Standard option.
3. A Bank Payment price reduction that brings the qualifying merchandise total below $1,000 also removes complimentary Express eligibility.
4. Alaska and Hawaii do not inherit the contiguous-48 flat rates or complimentary-Express threshold.
5. No legacy $8/$15/free-at-$70 rates appear anywhere.
6. Every offered customer shipment remains insured and signature-required.

## 7. Pricing and margin

Shipping/insurance costs must be represented in pricing/margin analysis so they do not silently erode margin.

The shipping threshold is a fulfillment benefit rule. It does not alter the Bank Payment Price or Regular/Card Price formulas in `docs/BANK-CARD-PRICING.md`.

## 8. Payment method does not change the shipping rules — LOCKED 2026-11-15

**Owner decision 2026-11-15. This section SUPERSEDES owner decision D19
(`docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md` §4, approved 2026-09-21) on
the shipping question, and on that question only.** D19's treatment of tax and
of the 24-hour guarantee's merchandise-only scope is unchanged and still
governs.

### The rule

CaratForUs shipping rules apply **consistently regardless of payment method**.
Selecting Bank Payment must **not** earn free shipping. Everything in §1–§5
applies identically to:

- Regular/Card checkout, and
- Bank Payment checkout.

The $1,000 qualification is evaluated using **the actual final merchandise
price for that payment method**. Worked example:

| | Card | Bank Payment |
|---|---|---|
| Merchandise total | $1,020 | $980 |
| Qualifies at $1,000? | yes | **no** |
| Shipping offered | Complimentary Express only | **$30 Standard / $55 Express** |

Alaska and Hawaii follow §3 on both payment methods: actual/calculated carrier
rate, full-value insurance, signature required, carrier's own delivery
estimate, and no complimentary-Express benefit.

### What D19 said, and why superseding it does not double-charge

D19 put an explicit **$0.00** shipping line on every Bank Payment draft order,
titled *"Shipping (included in item price)"*, reasoning that shipping and
insurance were already inside landed cost so a separate charge would bill the
customer twice.

That reasoning was checked against the production data before this decision
was implemented, because if it had been right the new rule would have been
incoherent. It does not apply. The production `cost_component` rows are:

| Component | Basis | Value |
|---|---|---|
| `shipping` | `cost_side` | **$12.00** |
| `insurance` | `cost_side` | **$3.00** |

These are an **internal fulfilment-cost allowance that protects margin**, not
a customer shipping charge passed through at face value. Two independent
reasons:

1. **The magnitudes do not correspond.** $12.00 is not $30 and not $55, and no
   calculation anywhere turns one into the other. A dollar-for-dollar
   embedding would have to match.
2. **The basis is `cost_side`.** They enter landed cost `C` and are then marked
   up by the margin solve. The customer never pays "$12 of shipping"; they pay
   a merchandise price computed to stay profitable *after* absorbing $12 of
   shipping cost and $3 of insurance cost. A pass-through charge would be
   `revenue_side`, or added after the solve. It is neither.

So **no double-charge existed**, and the customer shipping charge is additive
rather than a replacement for something already billed.

### Consequences for the pricing engine: none

The pricing engine is **unchanged**. No markup, floor, tier, rounding,
Bank/Card derivation or refund calculation was touched. `shipping` and
`insurance` remain `cost_side` cost components exactly as `README.md` requires
so they cannot silently erode margin.

`app/app/domain/pricing/shippingCostAllowanceFence.test.ts` pins the
allowance-versus-charge distinction, so a later change that moves either
component to the revenue side — quietly recreating the double-charge — fails a
test rather than reaching production.

### How it is implemented

Shipping rules live in **one** place: the Shopify delivery profile. Card
checkout reads it natively; the Bank Payment path reads the same configuration
through `draftOrderCalculate`'s `availableShippingRates`, with the **Bank
Payment line prices** as input — which is what makes the threshold
payment-method-specific without any branch that knows the threshold exists.
A second rate engine in CaratForUs code is forbidden: it would duplicate a
Shopify-native capability (CLAUDE.md principle 0), and on the day the two
disagreed a customer would be shown one number and charged another.

- The customer sends a service **title**. Never a price, never a rate handle.
  The server re-calculates the authoritative rates and looks the handle up
  from its own list, so the browser has no way to express a shipping price.
- **No order is created until a valid service is resolved.** An undeliverable
  destination, an unrecognised service, or a rate-calculation outage is a
  refusal. There is no free-shipping fallback anywhere on the path.
- The charge is recorded on the **order**, never on an order line.

### Shipping is a non-merchandise charge

It must stay outside:

- the Group Buy tier price;
- the Bank/Card merchandise-price derivation;
- tier savings, and the Bank Payment savings figure (§15 of CLAUDE.md:
  merchandise-only);
- the refund due when a later Group Buy tier reduces the merchandise price.

A later merchandise refund must not refund or recalculate a valid shipping
charge unless the order/shipping policy specifically requires it.

This is achieved by **placement, not by a check**: the charge lives on
`bank_payment_order` / `group_buy_bank_payment_order`, while close settlement
and refund arithmetic read the *lines*. A shipping amount folded into a line
price would be swept into the merchandise recomputation and refunded as
merchandise — refunding a carrier service already performed.
`app/app/domain/groupbuy/groupBuyShippingSeparationFence.test.ts` fails if a
shipping column appears on a line model, or if any settlement, refund, tier
pricing or Bank/Card derivation module starts reading one.

### Still open — two flows this decision does not reach

`createRedemptionDraftOrder` (Let Us Beat Your Quote redemption) and
`createCustomJewelryDraftOrder` (Custom Jewelry final purchase) ship physical
jewellery and **still carry the $0.00 shipping line**. They are deliberately
unchanged, and this is flagged rather than quietly decided.

Both price from a figure the customer has **already formally agreed** — a
competitor-matched quote, and an approved custom-design price held as
versioned acknowledgment evidence. Adding $30 or $55 after the fact changes an
agreed total. Both also treat Card and Bank Payment identically today, so
neither violates this section's actual rule, which is about consistency
*between payment methods*; the gap is against §2's separate charge.

Resolving it needs an owner decision on a different question: **does an
approved custom/quote-matched price include shipping, or is shipping added on
top?** The Custom Jewelry design-approval flow would also need to state the
answer before approval, not after.

`createServiceDraftOrder` (the $49 Custom Jewelry design deposit) keeps its
zero shipping line correctly and permanently: it is a service with nothing to
ship, so $0.00 is a true statement rather than a policy exemption.
