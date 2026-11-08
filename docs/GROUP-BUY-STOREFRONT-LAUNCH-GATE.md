# Group Buy storefront — first-campaign launch gate

**Status: the redesigned Group Buy storefront is built, tested and sitting in
an UNPUBLISHED theme. It must not be published until the verification below
passes against a real open campaign.**

Owner decision, 2026-11-08.

---

## Why this gate exists

The redesigned hub and campaign detail pages are covered by unit tests,
source fences and a draft-theme preview. What that preview could *not* cover
is the populated campaign detail page, because production has no open
non-fixture Group Buy campaign.

The ways to manufacture one are all worse than waiting:

| Shortcut | Why it is refused |
|---|---|
| Open `test-campaign` to get a live campaign | Opening **permanently freezes** a campaign's pricing. A one-way money action taken to satisfy a checklist is not a test, it is a production change. |
| Make a `zz-live-gate-*` fixture publicly reachable | Fixtures are real open campaigns with real frozen prices and synthetic products. Exposing one puts a synthetic product in front of customers. |
| Weaken the fixture refusal | That refusal is the only thing standing between a customer and those campaigns. Codes leak into logs, screenshots and handover notes; "nobody knows the code" is not a control. |
| Add a query-string preview bypass | A bypass that exists can be found. It would also need testing, and would outlive the reason it was added. |
| Create a fake production campaign or order | Fabricated production data is indistinguishable from real data a week later. |

So the absence of a populated detail-page smoke test is a **deferred launch
verification**, not an outstanding code defect, and not a reason to loosen
anything.

---

## The gate

When the first legitimate Group Buy is ready for business launch:

1. Configure it fully in the Admin Campaign Builder.
2. Review variant mappings and the price preview.
3. Open it — as a genuine campaign launch, not as a test.
4. **Verify it on the unpublished theme** using the checklist below.
5. Only after that passes, publish the redesigned theme.

Unpublished theme: **`188290826458`** (`group-buy-part2-preview`).
Preview URL: `https://caratforus.myshopify.com/pages/group-buys?preview_theme_id=188290826458`

---

## Verification checklist

Run at **320px, 375px, 390px, 430px and desktop**.

Chrome will not resize its window below roughly 1229px. A real narrow
viewport can be obtained by framing the page with `srcdoc` from the same
origin — fetch the page HTML, inject a `<base>` tag, and set the iframe to
the target width. Media queries then resolve against the iframe. This is how
the 320–430px measurements in the draft preview were taken.

### Hub — `/pages/group-buys`

- [ ] The campaign appears automatically, with no Theme Editor change
- [ ] Card image is the one chosen in the Admin Builder
- [ ] Headline and short description are correct
- [ ] `From $X` matches the **lowest current-tier card price** across eligible variants
- [ ] Joined count is correct
- [ ] Next-tier message names the right count and the right price
- [ ] Countdown reads correctly and does not run backwards
- [ ] **View Group Buy** opens the correct campaign
- [ ] One card per row at 320–430px; two at tablet; three at desktop
- [ ] No horizontal overflow at any width

### Campaign detail — `/pages/group-buys?campaign=<code>`

- [ ] Hero, mobile hero and gallery render; swipe works; position indicator correct
- [ ] Headline, description, highlights and display details are correct
- [ ] All customer options render with the right labels
- [ ] Invalid combinations visibly disable as the selection narrows
- [ ] Exact ring size is selectable and resolves correctly
- [ ] **No size-band terminology appears anywhere on the page**
- [ ] A complete selection resolves to the right Shopify variant
- [ ] The variant-specific Card price is correct
- [ ] Tier prices correspond to that same variant
- [ ] Changing configuration changes the price and the tier prices
- [ ] **Choosing Bank replaces the displayed price — it does not add a second one**
- [ ] Switching back to Card restores the Card price
- [ ] Neither payment method is selected on arrival
- [ ] Acknowledgment is required, never pre-checked, and reaches the policy page
- [ ] Signed-out browsing, configuring and pricing all work
- [ ] Ordering requires sign-in
- [ ] Sticky CTA shows the same price, payment type and state as the main controls
- [ ] **Share Group Buy** uses the native sheet, or copies the link as a fallback
- [ ] **‹ All Group Buys** returns to the hub
- [ ] Related campaigns appear and exclude the current one
- [ ] No horizontal overflow at any width

### Not part of this gate

**Do not place a real order to verify the page visually.** For the
money-moving paths — card cart-add, bank order creation, acknowledgment
evidence — the existing automated tests and live-gate evidence remain
authoritative, unless we explicitly decide to run a legitimate order test.

---

## Two pages, two jobs

| URL | Purpose |
|---|---|
| `/pages/group-buys` | Browse and buy Group Buys |
| `/pages/group-buy` | The Group Buy **policy** page |

These must stay separate. The policy page predates the hub and is linked
from the homepage ("How Group Buy works"), the Luxury Steals policy page and
the campaign detail page's acknowledgment area.

If a label is ever ambiguous between the two, **change the label, not the
URL.**
