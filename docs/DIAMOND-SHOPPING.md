# Loose diamond shopping — the provider-neutral seam

Owner instruction, 2026-11-09: customers should be able to start from the
homepage and shop loose certified diamonds at direct CaratForUs pricing.
Prefer Nivoda Connect for the feed, **but keep the storefront surface
provider-neutral** so Nivoda can later be replaced "with UNI or another
provider without changing homepage/navigation URLs."

---

## The URL contract

| Surface | Value |
|---|---|
| Customer page | `https://caratforus.com/pages/diamonds` |
| Page handle | `diamonds` |
| Theme template | `templates/page.diamonds.json` |
| Homepage section | `sections/carat-diamond-cta.liquid` |

**Nothing in that column may ever contain a supplier's name.** The handle is
the public contract: it ends up in browser history, search indexes and ad
campaigns, so `/pages/nivoda` could not survive a provider change even though
it would work perfectly today. `app/app/theme/diamondSurface.test.ts` pins
this — it fails if a supplier name appears in the section, the homepage
wiring, a CTA link, or a template filename, and it fails if a
`page.<supplier>.json` template is ever created.

## How the feed attaches

`sections/carat-diamond-feed.liquid` accepts `@app` blocks and branches on
whether any are present:

```liquid
{%- if section.blocks.size > 0 -%}   {%- comment -%} the live provider feed {%- endcomment -%}
{%- else -%}                         {%- comment -%} the Coming Soon state  {%- endcomment -%}
```

So connecting a provider is **one action in the theme editor**: add their
block to that section. The Coming Soon content then disappears on its own —
nobody has to remember to remove it, which is exactly the kind of thing that
gets forgotten and ends up stacked above a live product grid. Disconnecting
restores the Coming Soon state just as automatically.

No template edit, no homepage edit, no URL change, no redirect. Building a
custom API integration instead would have put the provider's data model into
our Liquid and thrown that property away, which is why the brief rules it out
unless Nivoda cannot support the experience.

### What survives a provider switch

Page order is `hero` → `feed` → `shapes` → `value` → `education` → `next`.
**Five of those six sections are ours and are untouched by the switch.** Only
`feed` changes.

| Section | File | On provider connect |
|---|---|---|
| Hero + category choices | `carat-diamond-hero` | kept; its two links become where the provider's feed is initialised |
| **Diamond feed** | `carat-diamond-feed` | **replaced by the provider's app block** |
| Shape navigation | `carat-diamond-shapes` | kept; link base/suffix repointed at the provider's shape parameter |
| Value pillars | `carat-diamond-pillars` | kept |
| Four characteristics | `carat-diamond-pillars` (second instance) | kept |
| Ring path | `carat-diamond-next` | kept; each option gains a real link |

The shape navigation is deliberately a **separate section from the feed**,
because the brief requires it to outlive the switch ("pass the selected shape
into whichever provider we choose") — so it cannot live inside the part that
gets replaced. The control-rail preview is the opposite case and lives
*inside* the Coming-Soon branch: a connected provider brings its own filter
UI, and two filter bars, one real and one decorative, is the worst outcome
available.

## The Coming Soon state

Until a provider is connected the feed area shows a framed, labelled preview
of the controls customers will use — diamond type, shape, certification,
carat, price, cut, colour, clarity — above a Coming Soon panel.

**The controls are `inert` and `aria-hidden`.** No pointer events, no tab
stops, no screen-reader exposure. The brief is explicit that placeholder
filters must not appear operational, and there is nothing behind them to
filter. The frame is labelled "Preview — live inventory is not connected yet"
so the state reads as *not yet* rather than *broken*; disabled controls with
no explanation would read as a bug.

**No fake inventory anywhere.** No diamond cards, no counts, no prices, no
results grid, no add-to-cart. Pinned by `diamondDestination.test.ts`, which
fails if a `$`-amount, a cart form, a product loop or an inventory count
appears in any diamond section.

The "Join the Early Access List" CTA points at **`/pages/first-access`**, the
existing First Access signup — which already offers a *Loose Diamonds*
interest. A second signup form here would split one audience across two
lists.

The two "next step" options (Buy the Diamond / Build an Engagement Ring)
render as `<div>`, not as disabled links or buttons: both need a selected
diamond and a connected provider, and an element that was never interactive
promises nothing to a keyboard or screen reader. When the integration exists,
each gains an `href` and loses its state chip.

### `?type=` and `?shape=` carry context, not filtering

Shopify Liquid cannot read an arbitrary query string server-side, so the
homepage's `?type=lab-grown` is reflected client-side: it marks the matching
category with `aria-current` and names it in the feed area's copy. An
unrecognised value is **ignored rather than defaulted**, so a stale or
hand-edited link cannot confidently show the wrong category. It marks and it
labels; it does not filter, sort or price.

## Responsive

Measured in a same-origin iframe at each width (Chrome will not resize its
window below ~1229px):

| Width | Overflow | Shapes/row | Category cards | CTA |
|---|---|---|---|---|
| 320px | none | 2 | 1 column | full width, 48px tall |
| 390px | none | 2 | 1 column | full width, 48px tall |
| 430px | none | 2 | 1 column | full width, 48px tall |
| 768px | none | 5 | 2 columns | inline, 44px |
| 1024px+ | none | 5 | 2 columns | inline, 44px |

Exactly one `<h1>` at every width. Five across does not fit a 320px phone,
and two across keeps each outline large enough to tell a cushion from a
princess — which is the entire job of that section.

## The two-theme situation

At the time of writing the store has **two** production-relevant themes:

| Theme | Role | Homepage |
|---|---|---|
| `188329230554` COMING SOON - First Access homepage | **MAIN (live)** | First Access landing page |
| `188329197786` LAUNCH - normal store homepage | unpublished | the normal store homepage |

The diamond work is on **LAUNCH only**. The live theme's homepage is the
Launching Soon configuration, whose requirements are locked in
`docs/COMING-SOON-FIRST-ACCESS.md`; adding a section to it would be
disturbing exactly what the brief says not to touch. The consequence is that
the diamond CTA becomes customer-visible when LAUNCH is published, which is
the owner's launch flip and not this work's to perform.

### Two things found while doing this, both outside the diamond brief

1. **The Group Buy storefront Phase 2 work is now in LAUNCH** (merged
   2026-11-13; it was previously only in the unpublished `188290826458`). The
   live COMING SOON theme still does not have it and was not given it.

   Seven files were merged **from this repository, not from the Phase 2
   theme** — the repo is the newer source, carrying the one-active-price
   correction (`76ac98e`). Diffed first to be sure: all five shared
   section/asset files are line-for-line identical between repo and theme
   (the byte-size gap was line endings alone), so the repo was authoritative
   and equivalent.

   | File | Why |
   |---|---|
   | `sections/group-buy-hub.liquid` | the hub |
   | `sections/group-buy-detail.liquid` | campaign detail |
   | `assets/group-buy-hub.js` | hub behaviour |
   | `assets/group-buy-detail.js` | detail + the one-active-price helper |
   | `assets/component-group-buy.css` | both |
   | `templates/page.group-buys.json` | `detail` → `hub` → `request` |
   | `locales/en.default.json` | the 17 keys the two sections read |

   The locale file is shared, so it was diffed rather than overwritten
   blindly: the repo copy is a strict superset — exactly those 17 Group Buy
   keys added, **zero LAUNCH-only keys and zero changed values** — which made
   the push purely additive. Without it both sections would have rendered
   "translation missing" in place of every heading and empty-state line.

2. **The LAUNCH theme uses its own navigation menu.** Shopify menus are
   *store-level*, shared by every theme, so adding "Diamonds" to `main-menu`
   would have changed the live Coming Soon theme's navigation too — which the
   brief forbids. The header's `menu` setting, however, is *theme-level*
   (`sections/header-group.json`). So a second menu `launch-main-menu` exists
   (main-menu plus a Diamonds item), and **only the LAUNCH theme's
   header-group.json points at it**. The live theme still reads `main-menu`,
   verified after the change.

   This is a second piece of intentional repo-vs-LAUNCH drift:
   `theme/sections/header-group.json` in this repository says `main-menu`,
   and the LAUNCH theme says `launch-main-menu`. Pushing the repo copy to
   LAUNCH would silently revert the navigation; pushing a repo copy that said
   `launch-main-menu` to the live theme would change the live navigation.
   Neither file is safe to push blindly — which is why both are listed here.

   When LAUNCH is published, the cleanest resolution is to copy the launch
   menu's items onto `main-menu` and point LAUNCH's header back at it,
   retiring `launch-main-menu`.

   **The launch menu, final order (owner-set, 2026-11-10):**

   | # | Label | Destination |
   |---|---|---|
   | 1 | Home | `/` |
   | 2 | Jewelry | `/collections/all` |
   | 3 | Luxury Steals | `/pages/luxury-steals` |
   | 4 | Group Buy | `/pages/group-buys` |
   | 5 | Diamonds | `/pages/diamonds` |
   | 6 | Set Your Own Stone | `/pages/set-your-own-stone` |
   | 7 | Let Us Beat Your Quote | `/pages/let-us-beat-your-quote` |
   | 8 | Custom Jewelry | `/pages/custom-jewelry` |
   | 9 | FAQ | `/pages/faq` |
   | 10 | Contact | `/pages/contact` |

   **Group Buy points at `/pages/group-buys` — the hub, not the explainer.**
   `/pages/group-buy` stays as the separate "How Group Buy works" policy
   page (owner correction, 2026-11-12). The hub template reached LAUNCH in
   the Phase 2 merge on 2026-11-13, so this nav item now renders the real
   browse experience.

   **"Jewelry" is a relabel of "Catalog", not a new destination.** The store
   has exactly one collection — `frontpage`, holding one product — so there
   is no existing Jewelry collection to point at, and creating one would be
   the duplicate the brief asks to avoid. The item keeps its `CATALOG` type
   and `/collections/all` target.

### Fitting ten items in the header

Dawn switches from the inline navigation to the hamburger at 990px. For a
ten-item menu that is far too late: measured in the browser, the items need
~823px of intrinsic width and the rest of the header ~413px (logo 185, icons
128, padding 100), and **at 1229px the menu was already wrapping onto a
second row** — silently, because `.list-menu--inline` sets `flex-wrap: wrap`.

**The first fix was wrong, and is recorded because the failure mode is easy
to repeat.** It raised the breakpoint to 1280px. That passed every
measurement and deleted the desktop navigation on ordinary laptops: a 1366px
screen at the default 125% Windows display scaling reports a CSS viewport of
~1092px, and a 1440px screen at 125% reports ~1152px. Both fell under 1280
and got the hamburger. Raising a breakpoint hides the symptom and takes the
navigation with it.

The correct fix makes the header **fit**, then puts the switch where it
genuinely stops fitting:

| | before | after |
|---|---|---|
| header padding | 100px | 40px |
| column gaps | 40px | 20px |
| logo | 185px | 143px |
| icons | 128px | 120px |
| nav | 763px | 683px |
| **total needed** | **1216px** | **1015px** |

Every value interpolates with `clamp()` between its tight figure at 1025px
and its roomy figure at 1920px, so a wide screen keeps the spacing the design
was approved with and only narrow ones compress. No width jumps visibly.

**Breakpoint: 1025px.** Desktop navigation at 1025px and above; hamburger at
1024px and below, which is exactly iPad landscape.

Two cascade bugs were found by measuring the rendered header rather than
trusting the CSS, and both are now pinned:

- base.css sets the padding through
  `.header:not(.drawer-menu).page-width` — three class-weight components.
  The override was first written with two, so it silently lost and the
  padding stayed at 50px a side, costing 60px of a ~200px budget.
- `.header__icon` already carries `width: 4.4rem`, so a `min-width` floor of
  40px changed nothing: a floor cannot shrink something already wider. It
  needed `width`.

**Font-size is untouched** — the nav links compute to 9.375px and the brief
says not to trade legibility for space. The logo has a 135px floor so it
cannot scale away either.

The stylesheet is loaded from `sections/header.liquid` **after** its inline
`<style>` block, and that ordering is load-bearing: the block sets
`header-drawer { display: none }` from 990px, and the rule that shows the
drawer again between 990 and 1024 has equal specificity, so it wins only on
source order. Moving the link higher would leave a 1000px tablet with no
navigation at all, and nothing would error.
`app/app/theme/headerNavigation.test.ts` pins all of it, and deliberately
asserts the breakpoint from **both** sides — high enough not to wrap, low
enough not to rob laptops.

| Width | Mode | Rows | Overlap | Clipping | Clearance | Overflow |
|---|---|---|---|---|---|---|
| 1920 | desktop | 1 | no | no | 212px | no |
| 1600 | desktop | 1 | no | no | 283px | no |
| 1440 | desktop | 1 | no | no | 318px | no |
| 1366 | desktop | 1 | no | no | 288px | no |
| 1280 | desktop | 1 | no | no | 221px | no |
| 1100 | desktop | 1 | no | no | 81px | no |
| 1025 | desktop | 1 | no | no | 22px | no |
| 1024 / 768 / 430 / 390 / 320 | hamburger | — | — | — | — | no |

All ten items appear in the drawer, in order, at every mobile width.

3. **`theme/templates/index.json` drift — RESOLVED 2026-11-13.** The repo
   pointed the homepage Group Buy card at `/pages/group-buys` (the hub) while
   LAUNCH pointed it at `/pages/group-buy` (the explainer), because LAUNCH had
   no hub template and the card would have landed on an empty page. The Group
   Buy Phase 2 merge shipped that template, so the card was moved to the hub
   and the two files are now byte-identical. Only the browse card moved; the
   two "How Group Buy works" CTAs still point at the explainer, which is the
   distinction `/pages/group-buys` (shop) versus `/pages/group-buy` (explain)
   exists to preserve.

## The page is published, and what that means

`/pages/diamonds` is **published** (`isPublished: true`). It had to be: an
unpublished Shopify page returns 404 to everyone, including inside a theme
preview, and the brief requires the page to render rather than 404.

Publishing a page is a **store-level** act, not a theme-level one, so the URL
is now reachable on the live Coming Soon theme too. That theme has no
`page.diamonds.json`, so it falls back to the default `page` template and
renders the page's **body copy** — which is why that body was written as a
short, honest Coming Soon statement rather than left as placeholder prose. A
visitor who finds the URL on the live site sees a presentable paragraph and a
link to First Access, not a broken layout.

To keep it from being *discovered* before launch, the page carries
`seo.hidden = 1` — the same mechanism already used for the archived
`first-access-v1` page. That keeps it out of the sitemap, storefront search
and search engines while leaving the direct URL working. **Remove that
metafield at launch**, or the finished page will stay unindexed.

## Pricing and markup

**There is no diamond markup configuration in this store, because there is no
diamond feed connected.** Verified rather than assumed: no Nivoda app
installed, no diamond metaobject definitions, zero `product_type:Diamond`
products. Nothing was changed, because there was nothing to change.

Markup must be set deliberately once a feed exists. Note that a diamond
feed's markup is **separate from** the CaratForUs pricing engine: that engine
computes a Bank Payment Price from metal, stone and labour cost inputs for
products we configure, and it has no inputs for a third-party stone whose
cost arrives from a supplier feed. Do not assume `docs/BANK-CARD-PRICING.md`
tiering applies to feed-priced diamonds until that is an explicit owner
decision — in particular whether the feed's customer-facing price is treated
as a Regular/Card Price, a Bank Payment Price, or neither.

## Supplier options, as they stood

| Option | Cost | State |
|---|---|---|
| Nivoda Connect | Starter free; Pro $199/mo (2M+ stones, certificate masking) | **not installed** |
| Unbridaled Diamonds (Unbridaled AI) | $650 one-time + $175–$300/mo | **already installed**, unconfigured |

Nivoda Connect requires a Nivoda account and a merchant-approved install;
both are owner actions. The Unbridaled app was already on the store and
advertises an AI diamond finder and ring builder with natural and lab-grown
stones, videos and certificates — worth knowing about, and worth a decision
either way, since leaving a second unconfigured diamond app installed is its
own small liability.
