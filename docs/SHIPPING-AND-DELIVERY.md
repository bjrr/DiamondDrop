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
