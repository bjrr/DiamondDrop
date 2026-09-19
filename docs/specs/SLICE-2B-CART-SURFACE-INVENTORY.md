# Stage 2B entry condition C4 — cart and price surface inventory

## Status

**CLOSES C4 / criterion 55.** Produced 2026-09-19 by tracing the committed
theme at `f135c91` (Dawn `258f00f6`, `theme_version` 16.0.0), file by file.
Nothing here is inferred from Shopify conventions; every row names a real file
in `theme/` and the actual Liquid object or JS path that renders the value.

**Acceptance condition:** no cart surface may render Card pricing while the
cart is in Bank Payment mode, or the reverse.

---

## A. Cart money surfaces — the four that render cart prices

| # | File | Renders | Value source | Can go stale on mode switch? | Stage 2B change | Test |
|---|---|---|---|---|---|---|
| A1 | `sections/main-cart-items.liquid` | Per-line original and final line price, per-line unit price | `item.original_line_price`, `item.final_line_price`, `item.original_price`, `item.final_price` | **YES** — these are Shopify's own line prices, always Card-basis | Render the mode-correct line price; show both prices per line per owner §3 "Cart" | Render test in both modes; assert eligible line shows Bank, ineligible shows Card |
| A2 | `sections/main-cart-footer.liquid` | Cart subtotal, checkout CTA, `content_for_additional_checkout_buttons` | `cart.items_subtotal_price` | **YES** — sum of Card-basis line prices | Subtotal must be the mode-correct **sum of per-line totals** (owner §5: never re-tier from the combined subtotal). Two CTAs: Card Checkout / Bank Payment Checkout | Assert subtotal equals sum of per-line mode-correct totals, not a re-tiered figure |
| A3 | `snippets/cart-drawer.liquid` | Drawer line prices, drawer subtotal, drawer checkout CTA | Same objects as A1 + A2 | **YES** | Same treatment as A1/A2. **Separate file — fixing the cart page does not fix the drawer** | Drawer-specific render test in both modes |
| A4 | `sections/cart-live-region-text.liquid` | Accessibility live-region announcement of cart total | `cart.total_price` | **YES, and silently** | Announce the mode-correct total | Assert the announced figure matches the visible subtotal |

**A4 is the one most likely to be missed.** It is invisible to a sighted
reviewer and renders a total anyway. A screen-reader user in Bank mode hearing
the Card total is a worse failure than a visual mismatch, because nothing on
screen contradicts it.

## B. Cart badge

| # | File | Renders | Stale risk | Change |
|---|---|---|---|---|
| B1 | `sections/cart-icon-bubble.liquid` | `cart.item_count` only — **verified, no money** | None | None required. Listed because both AJAX paths re-render it, so it must not be assumed price-bearing later |

## C. Cart notification (post-add-to-cart popup)

| # | File | Renders | Stale risk | Change |
|---|---|---|---|---|
| C1 | `snippets/cart-notification.liquid` | Product title + **checkout CTA**. No price — verified; `cart-notification-product.liquid` does not exist in this Dawn version | CTA only | The CTA must route by cart mode, as A2/A3 |

## D. AJAX re-render paths — how a stale surface actually appears

These matter more than the templates. Dawn re-renders cart sections through
the Section Rendering API and swaps `innerHTML`. **A surface fixed in Liquid
but not listed in the JS below will silently revert to server-rendered Card
pricing on the next quantity change.**

| # | File | Re-renders | Risk |
|---|---|---|---|
| D1 | `assets/cart.js` (`getSectionsToRender`, lines 144-167) | `main-cart-items`, `cart-icon-bubble`, `cart-live-region-text`, `main-cart-footer` | Cart mode must survive the round trip. Every re-rendered section must receive mode |
| D2 | `assets/cart-drawer.js` (two `getSectionsToRender`, lines 102 and 126) | `cart-drawer` / `CartDrawer`, `cart-icon-bubble` | **Two separate implementations** in one file — `CartDrawer` and `CartDrawerItems`. Both must be handled |
| D3 | `assets/cart-notification.js` | Notification contents | CTA routing |
| D4 | `assets/price-per-item.js` | Quick-order-list per-item price | Only if quick-order-list is retained |
| D5 | `assets/standard-actions-override.js` | Unit-price related overrides | Audit before shipping |

## E. Non-cart price surfaces (mode-independent, but in scope for consistency)

These render product prices, not cart prices, so they cannot go stale on a
cart mode switch. They are listed because owner §3 governs them and because
they share `price.liquid` with the cart.

| # | File | Role |
|---|---|---|
| E1 | `snippets/price.liquid` | **The shared price renderer.** Changing it affects PDP, cards, search and quick-order simultaneously — the highest-leverage and highest-risk single file |
| E2 | `snippets/card-product.liquid` | Collection cards → owner §3 "As low as" Bank Payment Price |
| E3 | `sections/main-collection-product-grid.liquid` | Collection grid |
| E4 | `sections/featured-collection.liquid` | Home/featured grids |
| E5 | `sections/main-product.liquid` | PDP → both prices + saving + two add-to-cart actions |
| E6 | `sections/featured-product.liquid` | Featured product block — **renders a full product price and is easy to forget** |
| E7 | `sections/predictive-search.liquid` (line 163) | **Search dropdown renders prices.** Owner §3 covers "collection and search" — this is the search half |
| E8 | `snippets/unit-price.liquid` | Unit pricing |
| E9 | `snippets/quick-order-list-row.liquid`, `sections/quick-order-list.liquid` | Bulk order UI |

## F. Checkout paths that BYPASS the cart — the most dangerous finding

| # | File | What it is | Why it matters |
|---|---|---|---|
| F1 | `snippets/buy-buttons.liquid` line 97 — `{{ form | payment_button }}` | Dynamic checkout (Shop Pay, Google Pay, etc.) on the **product page** | Goes **straight to checkout, skipping the cart entirely**. There is no cart, therefore no cart payment mode. The customer is charged the Shopify variant price — the Regular/Card Price |
| F2 | `sections/main-cart-footer.liquid` lines 122-124 — `content_for_additional_checkout_buttons` | Dynamic checkout **in the cart** | A Bank-mode cart with an accelerated checkout button beside it. One click and the mode is gone |

**This fails safe, and must still be handled.** Both paths charge the
**higher, correct Card price**, so no customer is ever undercharged and no
money is lost. But a customer who chose Bank Payment and clicked Shop Pay
pays the Card price with no explanation, which is a broken promise even
though it is not a pricing error.

Owner §19 is explicit: *"A customer who selected Bank Payment pricing must
never be able to complete a credit/debit-card payment at that lower Bank
Payment Price."* These paths satisfy that literally — they charge Card price,
not Bank price. The requirement they strain is the customer-facing one.

**Recommended treatment:** suppress F1 and F2 while the cart is in Bank
Payment mode, since Bank Payment Checkout is a separate invoiced flow those
buttons cannot honour. Flagged for the implementation plan rather than
decided here.

---

## Coverage assertion

Nine surface classes were requested. All nine traced:

| Requested | Found |
|---|---|
| Cart subtotal | A2, A3 |
| Line-item price | A1, A3 |
| Cart total | A4 (live region), A2/A3 (subtotal) |
| Checkout CTA | A2, A3, C1, **F1, F2** |
| Mini-cart / drawer | A3, D2 |
| Cart notification / popup | C1, D3 |
| Sticky cart | **None in this Dawn version** — verified by search, not assumed |
| AJAX cart response rendered by theme JS | D1-D5 |
| Header / cart badge | B1 (count only, no money) |

**Uncovered surfaces capable of showing the wrong basis: none**, subject to
the two bypass paths in F being handled as recommended.

## The rule this inventory implies

Every cart money value in this theme derives from a Shopify cart object —
`cart.items_subtotal_price`, `cart.total_price`, `item.final_line_price` and
their siblings — and **Shopify's cart always holds the Card price**, because
that is what is published to the variant. There is no mode-aware cart object
to read.

So Stage 2B cannot fix this surface by surface. It needs **one** mode-aware
price source that every surface in A, C and D reads, with the Shopify cart
objects treated as the Card-basis input to it rather than as display values.
Patching four templates independently guarantees the fifth is missed — and D1
and D2 guarantee any miss reappears on the next quantity change.


---

# LOCKED STAGE 2B ARCHITECTURE REQUIREMENTS

**Owner-locked 2026-09-19, following the C4 inventory above.** These are
requirements, not recommendations. Stage 2B's implementation plan must show
how each is satisfied before broad cart work begins.

## L1 — A single mode-aware cart pricing source

Shopify's cart and line objects (`cart.items_subtotal_price`,
`cart.total_price`, `item.final_line_price`, `item.original_line_price`,
`item.final_price`, `item.original_price`) are **Card-basis inputs**, never
display values. Bank-mode presentation is derived from **one** authoritative
mode-aware layer, and **every** cart money surface consumes that same source.

This follows directly from the inventory's structural finding: there is no
mode-aware cart object in Shopify to read. Patching surfaces independently
guarantees the next one is missed, and the AJAX paths guarantee any miss
reappears on the following quantity change.

**Acceptance:** no cart money surface reads a Shopify cart money object
directly for display. A fence test over `theme/` should enforce this the way
the resource-route fence enforces its invariant — a convention nothing checks
is a convention that decays.

## L2 — Accessibility is first-class, not a follow-up

`sections/cart-live-region-text.liquid` must announce the **active payment
mode's** total, never Shopify's raw Card total. Accessibility and live-region
behaviour belong in the acceptance criteria and in the regression tests, not
in a manual QA checklist.

This surface is singled out because it is the one a sighted reviewer cannot
see. A screen-reader user in Bank mode hearing the Card total gets no visual
contradiction to catch the error — the interface is simply and silently wrong
for them alone.

**Acceptance:** an automated test asserts the announced figure equals the
visible mode-correct subtotal, in both modes, after a quantity change.

## L3 — AJAX re-rendering must preserve mode-aware pricing

Every `getSectionsToRender` path is audited — **both implementations in
`assets/cart-drawer.js`** (`CartDrawer` at line 102 and `CartDrawerItems`
at line 126), plus `assets/cart.js`, `assets/cart-notification.js`,
`assets/price-per-item.js` and `assets/standard-actions-override.js`.

Any section replaced through the Section Rendering API must return or reapply
the correct active-mode prices. **Quantity changes and cart updates must never
revert any surface to Card pricing while Bank mode remains selected.**

This is the requirement most likely to be reported as met while being false:
the templates will look right on first render, and the regression appears only
after an interaction.

**Acceptance:** for each re-rendered section, a test that switches to Bank
mode, performs a quantity change, and asserts that section still shows
mode-correct pricing after the swap.

## L4 — Dynamic and accelerated checkout suppressed in Bank mode (OWNER APPROVED)

Whenever the cart is in Bank Payment mode, suppress every accelerated or
dynamic checkout surface that would bypass the mode-aware cart flow:

- `{{ form | payment_button }}` — `snippets/buy-buttons.liquid` line 97
  (product-level);
- `content_for_additional_checkout_buttons` —
  `sections/main-cart-footer.liquid` lines 122-124 (cart-level);
- Shop Pay and any other accelerated checkout surface that bypasses the Bank
  Payment path.

In **Card mode they remain available normally** — this suppression is
conditional on mode, not a permanent removal of Shopify-native functionality.

**The reasoning, recorded because the failure is subtle:** these paths already
fail safe. They charge the *higher, correct Card price*, so no customer is ever
undercharged and owner §19's prohibition on completing a card payment at Bank
pricing is satisfied literally. What they break is the promise: a customer who
selected Bank Payment, saw the lower price, and clicked Shop Pay pays the Card
price with no explanation offered. Suppression removes the trap rather than
relying on the customer noticing.

**Acceptance:** both surfaces absent from the DOM in Bank mode, present in Card
mode, and the transition tested in both directions.

## L5 — Test the hidden surfaces

Regression coverage must span, at minimum:

| Surface / interaction | Why it is in this list |
|---|---|
| Visual cart page | The obvious one |
| Cart drawer | A separate file from the cart page; fixing one does not fix the other |
| Cart notification | Separate template and separate JS |
| Live-region / accessibility text | Invisible to sighted review (L2) |
| Quantity changes | Triggers the AJAX re-render that reverts surfaces (L3) |
| AJAX section refreshes | The mechanism itself, per section |
| Reload / persistence | Mode must survive a page load, not live only in memory |
| Switching Bank ↔ Card repeatedly | Must not compound, double-discount, or drift |

Owner §19's money-critical list additionally requires: mixed
eligible/ineligible merchandise, server-side rejection of client-supplied
price tampering, prevention of Card checkout at Bank pricing, exact
order/payment-basis snapshot, and end-to-end cart-to-checkout handoff.

## Gate on proceeding

**No broad Stage 2B cart implementation begins until C1, C4 and C5 are all
closed and the implementation plan demonstrates how every surface in the
inventory above consumes the single mode-aware pricing source required by L1.**

C4 is closed by this document. C1 and C5 are in progress.


---

## R9 — price-bearing metafields are `type: "json"`, not bare integers. CONFIRMED.

Raised by the C5 implementer and ruled 2026-09-19. Spec §6 listed metafield
*names* and implied plain integer values. The implementation instead embeds
`{ masterVariantId, priceCalculationId, currency, bankPaymentPriceMinorUnits, … }`
in a single JSON value per price-bearing metafield.

**The reasoning is decisive and worth recording, because the alternative looks
simpler and is wrong.** `metafieldsSet` reports success and failure **per
field**. Two sibling metafields written in one call are therefore *not* atomic
with respect to each other — only a single field's own value is all-or-nothing.

A bare integer price plus a sibling `carat.*_price_calculation_id` field can
partially fail, leaving Shopify holding a **new price beside an old id**, or an
old price beside a new id. Either way the theme's staleness check compares the
wrong pair and concludes everything is coherent. That defeats the entire
mechanism C5 exists to provide — and it fails *silently*, which is worse than
not having the check at all, because the check would then actively vouch for a
mismatched pair.

Embedding the id inside the value makes price and id atomically consistent by
construction: they are one field, so they move together or not at all.

**Consequence for the theme half:** Liquid reads these as parsed objects
(`…metafields.carat.bank_payment_price_minor_units.value.bankPaymentPriceMinorUnits`),
not as bare numbers. Any Liquid written against an integer shape will be wrong.
Recorded here rather than left in a handoff because the theme work happens
later and by a different agent.

## R10 — `appliedUpliftRate` and `appliedTierLabel` need a fence, not a comment

`PublishedVariantPrice` carries both, marked INTERNAL ONLY for audit and admin
callers. `priceMetafieldPayload.test.ts` asserts neither ever appears in a
built payload, which is good — but the resolver's return type is the object
every customer-facing surface in Stage 2B will hold, and one spread into an
App Proxy response publishes the internal tier rate to the storefront in
violation of C-S5.

A test on the metafield builder does not protect the App Proxy route, which
does not exist yet. **Stage 2B must fence the proxy response shape itself** —
assert no response body ever contains `appliedUpliftRate`, `appliedTierLabel`,
a rule id, a profile version or a cost field — in the same spirit as the
resource-route fence. Added to task 2B-1.
