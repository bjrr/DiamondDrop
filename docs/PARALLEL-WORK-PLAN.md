# Parallel work plan — post-Slice 2C

Owner direction 2026-09-24: the real product catalogue and the customer-facing
luxury design must **not** gate MVP engineering. Three tracks run concurrently.

This plan exists to keep them genuinely parallel. The failure mode it guards
against is the one the owner named — a single sequential critical path — and
the way that failure actually arrives is **file collisions**, not scheduling.
So each track below owns named paths, and where two tracks want the same
directory the boundary is written down rather than negotiated later.

---

## The tracks

| | Track A — Engineering | Track B — Storefront design | Track C — Real-product onboarding |
|---|---|---|---|
| **Now** | Slice 3, Luxury Steals | Luxury visual identity | Mapping + pricing-input workflow |
| **Owns** | `app/**` (new modules), `theme/sections/luxury-*`, `theme/snippets/luxury-*` | `theme/assets/*.css`, `theme/config/settings_schema.json`, existing section layout | `app/routes/app.catalogue*`, `app/domain/catalogue/**`, data entry |
| **Agent** | Shopify Dev + Backend (`sonnet`) | Frontend & UX (`sonnet`) | Backend (`sonnet`) |
| **Blocked by** | D6 (see below) | brand direction | per-product data |
| **Blocks** | nothing else in MVP | nothing | nothing |

**Parallel-safety (architecture §10) is respected.** At most two *slices* run
concurrently. Track A is one slice. Tracks B and C are not slices — B is theme
presentation, C is data/admin tooling — and neither writes to the pricing or
ledger modules, so neither trips the slice 6/8 restriction.

---

## The one real collision, and how it is partitioned

Track A and Track B both want `theme/`. Left implicit, this becomes the
sequential path the owner asked us to avoid.

| Path | Owner | Rule |
|---|---|---|
| `theme/sections/luxury-*.liquid`, `theme/snippets/luxury-*.liquid` | **A** | New files only. A never edits an existing Dawn section's markup. |
| `theme/assets/component-luxury-*.css` | **A** | Component-scoped. No global selectors, no `:root` tokens. |
| `theme/assets/base.css`, other global CSS, `theme/config/settings_schema.json` | **B** | B owns presentation globally, including tokens A's components consume. |
| Existing Dawn sections/snippets | **B** | Layout and styling changes live here. |
| `theme/locales/en.default.json` | **shared, append-only** | Each track adds its own keys; neither edits the other's. Owner-approved strings stay pinned. |

A consumes B's tokens; B never needs to know A's markup. If A finds it needs a
global style change, that is a request to B, not an edit.

---

## Track A — Slice 3, Luxury Steals

Depends on slices 0 and 2, both closed. `docs/LUXURY-STEALS.md` is
authoritative.

**Scope:** collection and placement; Luxury Steal and Final Sale identification
on cards and PDPs; real-inventory scarcity ("Only X left" only when it reflects
actual inventory); the explicit, never-pre-checked Final Sale acknowledgment
with versioned evidence; order-time verification that the acknowledgment
exists.

**Two things that must not be got wrong:**

1. **Final Sale is not a denial of responsibility.** The policy is explicit
   that it restricts *discretionary* returns and must never be presented as
   eliminating warranty claims, damage-in-transit, or not-as-described
   remedies. Copy and enforcement both have to keep that separation.
2. **Scarcity must be real.** Quantity messaging is permitted *only* where it
   reflects actual available inventory. An "Only 2 left" that is decorative is
   a false scarcity claim, not a merchandising flourish.

**Products are not a dependency.** Slice 3 is built and tested against
fixtures. Real Luxury Steals arrive through Track C whenever they arrive.

---

## Track B — Storefront design

The theme is vendored Dawn with functional changes only. Nothing about it
currently says "luxury".

**Scope:** typography, colour and spacing tokens; product card and PDP
treatment; imagery and art direction; the Luxury Steals section's visual
language; mobile-first throughout; accessibility maintained (the cart and
checkout surfaces already meet a standard that must not regress).

**The storefront password stays on** for the duration, per owner direction.

---

## Track C — Real-product onboarding

A repeatable path from "a Shopify product exists" to "it is purchasable at a
verified Bank Payment Price", where **an incomplete product stays unavailable
instead of blocking anything**.

**Stages, each independently resumable:**

1. **Map** — link a Shopify product/variant to `master_product` /
   `master_variant`.
2. **Complete inputs** — metal, purity, weight, stones, labor source.
3. **Calculate** — the engine prices it, or refuses and names the missing input.
4. **Approve** — manual approval for every product initially.
5. **Sync** — publish to Shopify.
6. **Verify** — confirm the storefront shows the intended figures.

**The safety property is already built.** A variant with no published
calculation is not purchasable, and the theme shows "Price unavailable" rather
than substituting a native price. Track C inherits that: partial data is
*visible* as partial, never guessed at.

**Auto-publish stays OFF** until a real catalogue has been mapped, calculated,
approved, synced and visually verified.

---

## Owner inputs required

Listed per track so no track waits on another track's answer.

### Track A — before implementation

- **D6 — still open.** Whether to add a Shopify cart/checkout validation
  Function to hard-block un-acknowledged Luxury Steal checkouts. The recorded
  recommendation is layered enforcement in MVP1 with the Function as a
  fast-follow. Confirm or override; it decides the enforcement architecture,
  not a detail.
- **How Luxury Steals are identified** in Shopify — collection membership, a
  tag convention, or a metafield. Needed before anything can query them.
- **Final Sale acknowledgment copy.** The policy fixes the button
  ("I Understand & Agree") and the shape; the disclosure wording is
  customer-facing material terms and needs owner approval, as every such string
  in slice 2 did.
- **D11 remains open** — legal review of customer-facing policy and
  acknowledgment copy. Recorded against slice 12, but slice 3 writes
  acknowledgment text, so it is worth knowing whether counsel review precedes
  launch.

### Track B

- Brand direction: reference sites, typography, palette, logo assets.
- Photography and art direction, including how CAD renders, real photos and AI
  visualisations are labelled — README requires they be distinguishable.

### Track C — per product

None of this can be inferred, and none of it will be fabricated:

1. Shopify product and variant IDs for the launch set
2. Metal and purity (e.g. 14K gold)
3. **Base weight in grams**, plus grams per full size where size-dependent
4. Stone specifications per stone — type, shape, carat, colour, clarity, cut,
   lab or natural
5. Labor source (india / china / usa)
6. Confirmation that the seeded metal reference prices are real. They are
   currently `source: manual`, `effectiveFrom: 2026-01-01` seed fixtures, and
   gold moves.

---

## What is deliberately not in this plan

Slice 4 (RMA) could start alongside slice 3 — it depends only on slice 0 and
owns different modules. It is held back because **D7 and D10 are open and
`BUY-NOW-RETURNS` §14 expressly forbids inventing either** (tax treatment of
the restocking-fee refund and merchandise credit; credit expiry and
transferability). Starting slice 4 before those are settled would build a
refund path on invented tax behaviour.

That is the one place where waiting is correct rather than wasteful.
