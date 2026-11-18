# Launch readiness — shipping, returns, payments, catalog

Work of 2026-11-14, continuing the pre-launch audit.

---

## Shipping rates

Authoritative policy: **`docs/SHIPPING-AND-DELIVERY.md`**. The store was
running Shopify's defaults ($8 / $15 / free Standard at $70), which matched
nothing in it.

### Where the rates live, after two wrong answers

The first attempt wrote the rates through `deliveryProfileUpdate`. They read
back correct and the runtime kept serving $8/$15/free-at-$70 through every
path — not caching, not propagation delay. Shopify Admin said why plainly:

> **Shipping has moved to Markets.** Your shipping rates have not changed, just
> where you manage them.

So the second attempt moved them to **Markets → United States → Shipping**,
where they did take effect. But the Markets shipping UI cannot express what
this policy needs: it offers product scope, additional rates and a
free-shipping minimum, and has **no price-range upper bound and no second
zone**. A $1,000+ cart therefore still showed paid Standard $30 alongside the
free Express, which §2 forbids.

The fix was **"Switch back to shipping profiles"** in Settings → Shipping and
delivery, which restores the delivery profile as the runtime authority and
exposes both price-range conditions and multiple zones. The rates the first
attempt had written were still there, correctly conditioned, and became live
the moment authority moved back.

The lesson, now learned twice: **a configuration that reads back correct is
not the same as a configuration that is in effect.** Only the runtime settles
it — and *which surface is authoritative* is itself a setting.

### Final configuration — one profile, two zones, four rates

`General profile` (`116303986906`), all 377 variants, nothing else:

**Contiguous 48 states** — 48 states + DC. No AK, no HI, no territories.

| Rate | Price | Condition |
|---|---|---|
| Standard Insured Shipping with Signature | $30.00 | $0 – $999.99 |
| Express Insured Shipping with Signature | $55.00 | $0 – $999.99 |
| Complimentary Express Insured Shipping with Signature | $0.00 | $1,000 and up |

Three definitions rather than a free-shipping flag on Express, because §2
requires paid Standard to **disappear** at $1,000, not to sit beside the free
option. A price *range* on the two paid rates is what removes them.

**Alaska and Hawaii** — AK, HI only. One UPS carrier-calculated participant
(`105961554138`, service discovery on), so checkout quotes the carrier's real
rate and real estimate. No flat rate and no $1,000 benefit reaches this zone,
per §3.

### Runtime verification — all seven cases

Measured through `/cart/shipping_rates.json`, which is the path checkout uses.
Stored configuration was explicitly *not* accepted as evidence.

| # | Cart | Destination | Rates actually offered | §6 |
|---|---|---|---|---|
| A | $425.00 | Dallas TX | Standard $30.00; Express $55.00 | ✅ 6.1 |
| B | $995.00 | Dallas TX | Standard $30.00; Express $55.00 | ✅ 6.1 |
| C | **$1,000.00 exactly** | Dallas TX | Complimentary Express $0.00 **only** | ✅ 6.2 |
| D | $1,055.00 | Dallas TX | Complimentary Express $0.00 **only** | ✅ 6.2 |
| E | $1,055 − $100 = **$955** | Dallas TX | Standard $30.00; Express $55.00 | ✅ §2 |
| F | $425 and $1,055 | Anchorage AK | UPS Ground $32.25; 2nd Day $37.30; Next Day $82.16; Next Day Early $112.16 | ✅ 6.4 |
| G | $425 and $1,055 | Honolulu HI | identical UPS set | ✅ 6.4 |

Three results worth stating rather than assuming:

- **The threshold is inclusive.** Exactly $1,000.00 qualifies (case C), which
  is what "$1,000.00 or more" requires. An exclusive boundary would have been
  invisible at $1,055.
- **Shopify evaluates the condition after discounts** (case E), which §2
  requires. Verified with a single-use code created and **deleted
  immediately**; `discountNodes` is empty again.
- **AK/HI quote identically at $425 and $1,055**, proving the complimentary
  tier does not leak into that zone.

No legacy $8 / $15 / free-at-$70 rate appears anywhere (§6.5). Order count and
draft-order count were **0 before and 0 after**, re-confirmed at the end.

### RESOLVED 2026-11-15 — Bank Payment orders now charge shipping

**This was raised here as an owner decision, and the owner made it on
2026-11-15: CaratForUs shipping rules apply consistently regardless of payment
method, and selecting Bank Payment must not earn free shipping.
`docs/SHIPPING-AND-DELIVERY.md` §8 is the locked rule and supersedes D19 on
shipping.** What follows is what the finding was, and what was done about it.

#### The finding

Everything above is the **native Shopify checkout**, which is the Card path.
The **Bank Payment path does not use Shopify checkout**: it is a custom route
(`apps.carat.bank-checkout`) that creates a **draft order**, and Shopify never
applies delivery-profile rates to a draft order. Every Bank Payment draft
instead carried an explicit zero shipping line titled *"Shipping (included in
item price)"*, under **owner decision D19 (2026-09-21)** — so a $425 Bank
Payment basket shipped free where Card charged $30.

#### The double-charge question, answered from the data

D19's reasoning was that shipping and insurance were already inside landed
cost, so charging separately would bill the customer twice. If that had been
right the new rule would have been incoherent, so it was checked against the
production `cost_component` rows rather than assumed either way:

| Component | Basis | Value |
|---|---|---|
| `shipping` | `cost_side` | **$12.00** |
| `insurance` | `cost_side` | **$3.00** |

It is an **internal fulfilment-cost allowance**, not a customer charge passed
through at face value. Two independent reasons: $12.00 is neither $30 nor $55
and nothing anywhere converts one into the other; and `cost_side` means they
enter landed cost and are then *marked up* by the margin solve, so the customer
pays a price computed to stay profitable after absorbing $12 of shipping cost
rather than paying $12 of shipping. A pass-through charge would be
`revenue_side`, or added after the solve. It is neither.

**So no double-charge existed, and the pricing engine was left completely
alone** — which is what the brief asked for in that case.
`shippingCostAllowanceFence.test.ts` pins the distinction, so the old reasoning
cannot be quietly re-imported later.

#### How it is implemented

One authority, no second rate engine. Card checkout reads the Shopify delivery
profile natively; the Bank Payment path reads **the same configuration**
through `draftOrderCalculate`'s `availableShippingRates`, passing the **Bank
Payment line prices**. That is what makes the $1,000 threshold
payment-method-specific — no code anywhere needs to know the threshold exists.

`draftOrderCalculate` is a mutation by GraphQL convention but persists nothing,
which is what makes it safe to call for a quote; draft-order count was 0 before
and after every probe. A `variantId` is required for rates to come back at all
— a custom line with only a title and a price returns an empty list, measured
rather than assumed — which is why the Custom Jewelry and quote-redemption
flows cannot simply adopt the same method.

Three properties, each closing a specific hole:

- **The browser sends a service TITLE. Never a price, never a rate handle.**
  The server re-calculates the authoritative rates and looks the handle up from
  its own list, so there is nothing on the wire a tampered client could turn
  into cheaper shipping. Shopify's handle is a signed JWT and a forged one is
  rejected — tested, by mutating the price claim to `"0.0"` and keeping the
  signature, which Shopify refuses outright — but "the upstream rejects it" is
  a weaker guarantee than "it never gets there", and the observed rejection is
  an opaque 500 rather than a `userError`.
- **No order is created until a valid service is resolved.**
  `CreateDraftOrderInput.shippingRateHandle` is non-optional, so the type
  system enforces that rather than a runtime check someone can forget. An
  undeliverable destination, an unrecognised service and a rate-calculation
  outage are all refusals. **There is no free-shipping fallback on any path.**
- **An adapter echo check** compares the shipping amount Shopify actually
  applied against what the customer was quoted, in minor units — Shopify
  normalises `"30.00"` to `"30.0"`, and comparing those as strings is a defect
  this adapter has already had once. A *missing* shipping line fails too:
  absence is not read as zero, because that would be the superseded behaviour
  returning by the back door.

The charge is recorded on `bank_payment_order` and
`group_buy_bank_payment_order` — the **order header, never a line**. Settlement
and refund arithmetic read the *lines*, so placement is what holds a
non-merchandise charge out of merchandise recomputation.
`groupBuyShippingSeparationFence.test.ts` fails if a shipping column appears on
a line model, or if any settlement, refund, tier-pricing or
Bank/Card-derivation module starts reading one.

#### Runtime verification — the owner's eight cases

Bank legs measured through `draftOrderCalculate` with Bank Payment price
overrides, which is literally the call the route makes. Card legs measured
through `/cart/shipping_rates.json`, the path native checkout uses.

| # | Case | Offered |
|---|---|---|
| 1 | **Card** $425, contiguous 48 | Standard $30.00; Express $55.00 |
| 2 | **Bank** $425, contiguous 48 | Standard $30.00; Express $55.00 |
| 3 | **Card** exactly $1,000 | Complimentary Express **only** |
| 4 | **Bank** exactly $1,000 | Complimentary Express **only** |
| 5 | **Bank $980 / Card $1,025** — the owner's example | **Bank: Standard $30.00; Express $55.00.** Card, above $1,000: Complimentary Express only |
| 6 | **Bank** Alaska, $425 *and* $1,055 | UPS Ground $32.25; 2nd Day $37.30; Next Day $82.16; Next Day Early $112.16 — **identical at both**, so no free threshold |
| 7 | **Bank** Hawaii, $1,055 | identical UPS set |
| 8 | No `Shipping (included in item price) $0.00` anywhere | asserted on the real route's outgoing draft and on the adapter request |

Case 5 is the one the decision exists for: $980 on Bank Payment is below the
threshold and is charged, while the same basket at $1,025 on card is above it
and is not. The card threshold was verified **inclusive at exactly $1,000** and
again at $1,055, which brackets $1,025 on what is a simple `>=` comparison.

Order count and draft-order count were **0 before and 0 after**. No real paid
order was placed.

#### Deployment ordering

The live **COMING SOON** theme still carries the pre-change checkout
JavaScript, which sends no `shippingServiceTitle`. That request now **fails
closed with a 400** — no order, and certainly no free shipping — and it is
unreachable in any case, because no product is published and nothing can be
added to a cart. The updated dialog, JavaScript and copy went to the **LAUNCH**
theme, which is the one that will go live. LAUNCH remains unpublished.

#### Still open — two flows this does not reach

`createRedemptionDraftOrder` (quote redemption) and
`createCustomJewelryDraftOrder` (Custom Jewelry final purchase) ship physical
jewellery and **still carry the $0.00 line**, deliberately. Both price from a
figure the customer has already formally agreed — a competitor-matched quote,
and an approved custom-design price held as versioned acknowledgment evidence
— so adding $30 or $55 afterwards changes an agreed total. Both also treat
Card and Bank Payment identically today, so neither breaks the
consistency-between-payment-methods rule; the gap is against §2's separate
charge.

Resolving it needs a different owner decision: **does an approved custom or
quote-matched price include shipping, or is shipping added on top?** The
design-approval flow would also have to state the answer *before* approval, not
after. Recorded in `docs/SHIPPING-AND-DELIVERY.md` §8 rather than quietly
decided here.

`createServiceDraftOrder` (the $49 design deposit) keeps its zero line
correctly and permanently — it is a service with nothing to ship.


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
| Shipping | `/policies/shipping-policy` | rewritten 2026-11-14 — see below |
| Privacy | `/policies/privacy-policy` | unchanged |

### Shipping policy rewritten 2026-11-14 for the locked policy

The first version described one uniform U.S. program: $30/$55 for every state,
free Express at $1,000 with no geographic qualification, and "Express transit
is expedited" where §5 requires a stated 1–2 business days. All three were
wrong once `docs/SHIPPING-AND-DELIVERY.md` landed.

The replacement separates **Contiguous 48 states** from **Alaska and Hawaii**
under their own headings, uses the §5 service names verbatim, carries the §5
Alaska/Hawaii sentence, states that the threshold is measured after discounts
and that tax/shipping/duties do not count toward it, says paid Standard is no
longer offered once an order qualifies, says the signature **cannot be
waived** (§1), and keeps preparation time visibly separate from transit time
(§4). It promises no delivery-by hour (§5).

Verified against the live storefront, not the editor: **19 assertions, all
passing** — including the negative ones that no $8, $15 or $70 figure and no
"cash discount"/"surcharge"/"card fee" wording survives anywhere on the page.

Written through Admin again, because `shopPolicyUpdate` needs
`write_legal_policies` and neither app holds it. Same technique as before:
`tinymce.get(id).setContent(html)` in one call, then the Save button enabling
itself is the signal that the change registered rather than merely been typed.

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
