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

The page template's third section is `apps` — Shopify's own `@app` block
host. The diamond feed is added to it **in the theme editor**, not in code.

That is the whole seam. Swapping providers is: remove one app block, add
another. No template edit, no homepage edit, no URL change, no redirect.
Building a custom API integration instead would have put the provider's data
model into our Liquid and thrown that property away, which is why the brief
rules it out unless Nivoda cannot support the experience.

Template order is `head` → `main` → `feed`, and the order matters: the
branded CaratForUs header renders before the third-party block, so the page
reads as CaratForUs rather than as an embedded tool.

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

1. **Neither live theme contains the Group Buy storefront Phase 2 work.**
   Neither has `templates/page.group-buys.json` or
   `sections/group-buy-detail.liquid`, so `/pages/group-buys` returns 200 and
   renders an essentially empty page. That work still lives only in the
   unpublished `188290826458`, gated by
   `docs/GROUP-BUY-STOREFRONT-LAUNCH-GATE.md`.

2. **`theme/templates/index.json` in this repository and the LAUNCH theme's
   copy differ on one line**, deliberately. The repo points the homepage Group
   Buy card at `/pages/group-buys` (the hub); LAUNCH points it at
   `/pages/group-buy` (the policy page). Because LAUNCH has no hub template,
   pushing the repo's `index.json` wholesale to LAUNCH would repoint a working
   card at an empty page — a Group Buy regression. So the diamond section was
   inserted into **LAUNCH's own copy**, preserving every other byte, rather
   than by pushing the repo file. Reconciling these two is a Group Buy
   deployment decision, not a diamond one.

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
