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

**Where they live now: Markets → United States → Shipping.** Two options,
with free shipping attached to Express alone:

| Option | Price | Transit | Free shipping |
|---|---|---|---|
| Standard insured shipping with signature | $30.00 | 3–5 business days | off |
| Express insured shipping with signature | $55.00 | 1–2 business days | **on, from $1,000** |

Attaching the free threshold to Express rather than adding a third option is
what makes the $1,000+ case *free Express* instead of *free Standard*, and it
avoids a third rate that would only ever duplicate one of these two.

Ring sizing (about 3 to 5 extra business days) and made-to-order lead times
(about 3 to 6 weeks) are product-level facts, not shipping rates. They belong
on the product page and in the shipping policy, not in a rate name.

A first attempt went through `deliveryProfileUpdate` on the default delivery
profile. Shopify refused an in-place edit — *"this method definition... uses
new configurations that are only available through Shopify's updated APIs"* —
so the definitions were deleted and recreated there. **That surface turned
out not to be the one checkout reads**; see below.

### RESOLVED 2026-11-14: the rates lived in Markets, not the delivery profile

The stored delivery-profile configuration was correct and the runtime still
served $8/$15/free-at-$70 through every path. It was not caching and not
propagation delay. Shopify Admin said so plainly:

> **Shipping has moved to Markets.** Your shipping rates have not changed, just
> where you manage them.

The live rates belonged to the **United States market**, and the delivery
profile edited through `deliveryProfileUpdate` is a surface checkout no
longer reads. The lesson is the one this file already half-learned: a
configuration that reads back correct is not the same as a configuration that
is in effect, and only the runtime settles it.

Corrected in Markets > United States > Shipping, and verified at runtime:

| Cart | Rates offered |
|---|---|
| $425 | Standard insured shipping with signature $30.00; Express insured shipping with signature $55.00 |
| $1,055 | Express insured shipping with signature **$0.00**; Standard insured shipping with signature $30.00 |

No legacy $8/$15 rate and no free Standard rate at either price. Free
shipping is attached to Express alone, with a $1,000 minimum, which is what
makes the $1,000+ case free Express rather than free Standard.

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

## Shopify native policies — SET 2026-11-14

Only Privacy existed; Refund and Shipping were empty, and those are what
checkout and the footer link to.

`shopPolicyUpdate` needs `write_legal_policies`, which neither app holds, so
they were written through Shopify Admin instead. The editor is TinyMCE, and
typing a long policy into it key-by-key wedged the renderer twice. Setting
the content through the editor's own API in a single call
(`tinymce.get(id).setContent(html)`) worked immediately, and the Save button
enabled itself, which is how the change was known to have registered rather
than merely to have been typed.

Verified live on the storefront:

| Policy | URL | Contains |
|---|---|---|
| Refund | `/policies/refund-policy` | the 14-day window |
| Shipping | `/policies/shipping-policy` | $30, $55 and the $1,000 threshold |
| Privacy | `/policies/privacy-policy` | unchanged |

`/policies/terms-of-service` returns 404 because no native ToS policy is set.
Nothing links to it — the footer points at the `/pages/terms-of-service`
page, which works — so that is tidiness rather than a defect.

## Payments — CONFIRMED 2026-11-14

`shopifyPaymentsAccount` needs `read_shopify_payments`, which neither app
holds, so this was read directly in Settings → Payments rather than inferred
from a checkout page:

| | |
|---|---|
| Provider | **Shopify Payments** |
| Accepting payments | yes |
| Receiving payouts | yes |
| Payout account | Shopify Balance, ending 2121, USD, daily |
| Card methods | Shop Pay, Visa, Mastercard, Amex, +4 |
| Wallets at checkout | Shop Pay, PayPal, Google Pay, Venmo |
| Fraud prevention | CVV verification on, automated |
| **Test mode** | **OFF** |

No identity, bank or verification step is outstanding. The only amber note is
"Chargeback monitoring: currently unavailable", which is a plan feature and
does not affect taking live payments.

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
jewelry catalog yet.** No approved inventory source is waiting to be
imported either — Kira appears in `docs/VENDOR-SKU-TRANSFORMATION.md` only as
a *future* supplier, and no Kira or Laravo products exist in Shopify.

### Jewelry Coming Soon, so an empty catalog is not a broken page

`/collections/all` now presents an intentional Coming Soon state instead of
reading as an accident. It lives in the product grid's **empty state**, which
is the right place for two reasons: it renders only when the collection has
no products, and it therefore **removes itself the moment real products are
published** — no cleanup step to forget later.

- Heading: *Jewelry is coming soon* (it previously said "Nothing listed yet",
  which reads as a fault rather than a plan)
- Body explains the first collection is being finished and points at the
  early-access list
- Four routes that work today: **Join the early-access list**, See Group
  Buys, Shop Diamonds, Design something custom

No fake products, no fake prices, no SYOS mounting promoted into Jewelry, and
the navigation label stays **Jewelry**.

## Branding

**Social sharing image: set** to `carat-c-hero1-rings-desktop.png`, an
existing approved brand asset already used by the homepage hero. Worth
re-checking before publishing: `og:image` was not yet rendering on the
storefront immediately afterwards, and the shipping episode above is a fresh
reminder that a stored setting is not the same as a live one.

**Favicon: still unset, deliberately.** The only brand mark available is the
logo lockup, a gold diamond above the CARATFORUS wordmark. Scaled to 32px the
wordmark becomes an unreadable smudge, which looks worse in a browser tab
than Shopify's default. This needs a square, wordmark-free export of the
diamond mark — a new asset, and the brief says not to invent one.

`shop.description` is also empty, so `og:description` falls back to the shop
name on every page. One sentence in Settings → General would fix it.
