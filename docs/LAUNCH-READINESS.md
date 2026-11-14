# Launch readiness — shipping, returns, payments, catalog

Work of 2026-11-14, continuing the pre-launch audit.

---

## Shipping rates

The store was running Shopify's default rates, not CaratForUs policy.

| | Approved | Was | Now configured |
|---|---|---|---|
| Standard, under $1,000 | $30 insured + signature | $8.00 | **$30.00** |
| Express, under $1,000 | $55 insured + signature | $15.00 | **$55.00** |
| $1,000 and above | free Express insured + signature | free *Standard* at **$70+** | **free Express at $1,000+** |

Three method definitions on the one US zone of the default profile, with
non-overlapping price conditions, so a customer is never offered two
contradictory answers:

| Rate | Price | Applies |
|---|---|---|
| Standard insured shipping with signature | $30.00 | $0.00 – $999.99 |
| Express insured shipping with signature | $55.00 | $0.00 – $999.99 |
| Free Express insured shipping with signature | $0.00 | $1,000.00 and above |

Timing lives in each rate's description, which is what the customer sees at
checkout: ships in about 1 to 2 business days, then about 3 to 5 business
days in transit for Standard, expedited for Express. Ring sizing (about 3 to
5 extra business days) and made-to-order lead times (about 3 to 6 weeks) are
product-level facts, not shipping rates, and belong on the product and in the
shipping policy rather than in a rate name.

The existing rates could not be updated in place — Shopify refused with *"this
method definition... uses new configurations that are only available through
Shopify's updated APIs"* — so they were deleted and replaced in one atomic
`deliveryProfileUpdate`.

### Runtime has not caught up, and that is not yet explained

The stored configuration reads back correct: three active definitions, right
prices, right conditions, 377 variants covered, one location, one market, no
carrier service.

**Every runtime path still served the previous rates**, naming rates that no
longer exist in configuration:

| Path | Result |
|---|---|
| `draftOrderCalculate` ($425 and $1,055) | `Standard $0.00`, `Express $15.00` |
| `/cart/shipping_rates.json` (Dallas, New York, Atlanta) | `Standard $0.00`, `Express $15.00` |
| Checkout summary ($425 and $1,055) | `Shipping FREE` |

A fresh address each time rules out address-keyed caching. The most likely
explanation is Shopify propagation delay on rate changes, but that is a
guess, and **shipping must be re-verified before publishing** rather than
assumed fixed. The quickest confirmation: a cart under $1,000 should offer
$30 and $55, and one at $1,000+ should offer free Express only.

No order and no draft order was created during this testing; order count and
draft-order count were both 0 before and after.

## Returns policy

The page previously carried framing prose and the RMA *acknowledgment* — the
text a customer certifies when requesting an RMA — and **none of the approved
terms**. The locked policy
(`docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`) specifies them, so the gap
was disclosure, not policy.

Added as page content, between the intro and the acknowledgment block, using
the existing `carat-infocols` section rather than new code:

- **The return window** — 14 days, running from carrier-confirmed delivery;
  item must be received back inside it; RMA first.
- **The condition we need it back in** — original, new and unworn; original
  packaging; IGI or other certification returned with it; original ring
  size; tracked and insured return shipping paid by the customer.
- **What cannot be returned** — resized items not refundable unless
  defective; engraved/altered/personalised; Luxury Steals final sale.
- **If something is wrong with the item** — points at the 1-year warranty and
  the claim flow, so a defect is not mistaken for a 14-day return. This is
  the clause that keeps the returns page from contradicting the warranty
  page: a resized item that proves defective is still covered.

The acknowledgment block is untouched. It is versioned evidence a customer
affirms, which is a different thing from a published policy, and merging the
two would corrupt the evidence trail.

## Shopify native policies — BLOCKED ON SCOPE

Only **Privacy policy** exists in Shopify's own policy set. Refund and
Shipping policies are empty, which is what checkout and the footer link to.

`shopPolicyUpdate` requires `write_legal_policies`, which neither the
CaratForUs app nor the connector holds. **This is an owner action** in
Settings → Policies. The refund text is ready to paste from the page content
above.

## Payments

Not readable by API — `shopifyPaymentsAccount` requires
`read_shopify_payments`, which neither app holds. Verified instead by loading
a real checkout (no order placed, no payment method touched):

- **Express checkout offers Shop Pay, PayPal, Google Pay and Venmo.**
  Shop Pay's presence means **Shopify Payments is active**, since Shop Pay
  requires it.
- **No test-mode banner.** Shopify renders a prominent test-mode bar at
  checkout when it is on, and there was none.

Both are inferences from the rendered checkout rather than from the payments
settings page, so the owner should confirm the provider and test-mode state
directly before publishing.

## Catalog — the "zero published products" finding was a false alarm

Five products exist. **Nothing should be published to the normal storefront**,
and that is the designed state rather than a misconfiguration.

| Product | Status | Classification |
|---|---|---|
| ZZ webhook test — DO NOT SELL | ARCHIVED | **INTERNAL/TEST — DO NOT PUBLISH** |
| 14K Pear Solitaire — Ultra Light Tulip Mounting | UNLISTED | **CORRECT AS IS** (SYOS-only) |
| 14K Emerald Solitaire — Flat Band Pavé Mounting | UNLISTED | **CORRECT AS IS** (SYOS-only) |
| 14K Oval Solitaire — Hidden Halo Pavé Mounting | UNLISTED | **CORRECT AS IS** (SYOS-only) |
| Stone Removal ($50 service) | UNLISTED | **CORRECT AS IS** (SYOS-only) |

`docs/VENDOR-MOUNTING-PRICING-AND-CATALOG.md` §10 and §11 require exactly
this:

> Prefer Shopify-native visibility controls (for example, **UNLISTED** where
> supported) over custom theme filtering.

> **Do not publish SYOS-only vendor mountings into Shop Jewelry merely to
> make them purchasable.**

So publishing them would violate a locked policy. The three mountings are
complete — real vendor, transformed SKUs, 6 to 9 images each, per-size and
per-metal pricing, ring sizes, untracked inventory so they stay purchasable
through SYOS.

**The real gap is merchandising, not configuration: there is no Buy Now
jewelry catalog yet.** `/collections/all` is empty because nothing has been
built to sell there, which is a business input rather than a defect to fix in
Shopify.
