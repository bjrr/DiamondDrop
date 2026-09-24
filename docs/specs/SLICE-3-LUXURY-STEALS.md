# Slice 3 — Luxury Steals

## Status

**APPROVED 2026-09-23 at `6b85eab`, with owner decisions D27 and D11 below.
Disclosure copy approved (§13.1). Implementation in progress.**

Author: Principal Architect / Tech Lead
Date: 2026-09-23
Depends on: slices 0 and 2, both closed
Track A of `docs/PARALLEL-WORK-PLAN.md`

---

## 1. Outcome

A customer browsing CaratForUs can find a dedicated Luxury Steals collection of
genuinely limited, deliberately under-priced pieces. Every one is unmistakably
identified as **Final Sale** before they commit, and they cannot add one to
their cart without an explicit, never-pre-checked acknowledgment that is
recorded as evidence. Scarcity shown on screen is real inventory, never
decoration. When an order arrives, every Luxury Steal line is checked against
that evidence; a line without it is held for a human rather than quietly
fulfilled.

Final Sale restricts *discretionary* returns. It never denies a defect,
warranty, wrong-item or transit-damage claim, and the implementation must make
that separation impossible to blur.

## 2. Authoritative sources

| Area | Source |
|---|---|
| Everything Luxury Steals | `docs/LUXURY-STEALS.md` — locked |
| Acknowledgment evidence shape | `docs/specs/SLICE-0-FOUNDATION.md` §0.5 |
| Metafields are presentation cache, never authoritative | `docs/ARCHITECTURE-MVP1.md`; owner, 2026-09-23 |
| Money, delegation, git discipline | `CLAUDE.md` |
| Copy approval discipline | Slice 2C §22 — owner-approved strings pinned character-for-character |

## 3. Owner decisions, 2026-09-23

### D6 — RESOLVED: layered enforcement, no validation Function

**Ship the layered enforcement below for MVP1. Do not build a Cart/Checkout
Validation Function in slice 3.** The current custom-app architecture on
Basic/Grow cannot rely on Shopify Functions; a Function stays a future
hardening option if plan or distribution eligibility changes.

This closes D6, which `ARCHITECTURE-MVP1.md` §12 had left open.

**The consequence must be stated plainly rather than implied.** Without a
Function, nothing in Shopify's own checkout can *refuse* an un-acknowledged
Luxury Steal line. Our enforcement is preventive at the storefront and
**detective** at the order boundary. So the order-time check is not a
belt-and-braces nicety — it is the only thing standing between a bypassed
storefront and a silently fulfilled Final Sale item, and it is specified
accordingly.

### D26 — RESOLVED: Postgres is the system of record

**Luxury Steal assignment lives in Postgres.** A dedicated Shopify product
metafield — `carat.luxury_steal = true` — is synced as a **presentation cache**
for the storefront, exactly as published prices are.

- The dedicated **Luxury Steals collection** is for navigation and
  merchandising. Collection membership is **not** the system of record for
  Final Sale behaviour.
- **Shopify tags must not be the authoritative eligibility mechanism.**
- A change in status goes through the controlled admin path, which updates
  Postgres and then syncs the metafield. Theme behaviour and acknowledgment
  requirements derive from the synced state.

This is the same rule slice 2 already follows for price: metafields are a cache
the storefront reads, never the thing the business decides from.

### D27 — RESOLVED: assignment is variant-level

**The authoritative assignment is per variant.** The admin UX may offer a
product-level "apply to all variants" convenience action, but internally each
variant is independently assignable. This supersedes D26's product-level
wording; §5 and §4.7 carry the consequences.

**Consequence for the cache.** D26 named a *product* metafield. Variant-level
truth cannot be represented by one product-level boolean, so `carat.luxury_steal`
becomes a **variant** metafield, keeping the namespace and key the owner named
while preserving the variant-specific state D27 requires. No product-level
rollup field is introduced — see criterion 148 for why the card badge is
computed in Liquid instead.

### D28 — OPEN: does a held order have to be fulfilment-blocked?

Raised twice during implementation and proceeded past without an answer, so it
is recorded here rather than left implicit in a code comment — which is where
an independent QA review found it.

**The gap.** With D6 declining a validation Function, the order-time check is
the only enforcement that binds. But the "hold" it produces is evidence plus a
best-effort email plus an admin page. If the email bounces — durably audited,
but still unread — and nobody opens that page, nothing prevents the order being
picked and shipped. It is a detective control with no binding backstop.

**Option (a), recommended.** Request `write_merchant_managed_fulfillment_orders`
and place a real fulfilment hold on the Shopify order, so an unmatched line
cannot progress past packing. This makes criterion 138 mean what it sounds
like. Cost: one additional write scope.

**Option (b).** Accept the gap for MVP1 on the grounds that CaratForUs fulfils
manually and a jeweller is unlikely to ship a made-to-order piece without
looking. Cost: "held" stays a bookkeeping state, and the safety of the whole
slice rests on staff habit.

Either is defensible. What is not defensible is the wording that was here
before, which read as though fulfilment were prevented. Until the owner rules,
**(b) is what is implemented** and criterion 138 above says so plainly.

**Secondary, independent of the ruling.** A Luxury Steal hold has no persistent
embedded-admin alert, unlike a pricing failure under rule 17 — only a one-shot
email and a page staff must remember to visit. Worth closing regardless of how
D28 lands.

### D11 — RESOLVED: legal review is a pre-launch gate, not a slice 3 blocker

Build against the owner-approved text now; the storefront password stays on.
**Any counsel-approved wording change before launch must create or update the
pinned copy and the policy version — never silently edit historical evidence.**
An acknowledgment already captured records the text and version the customer
actually saw, and that record is immutable by design.

## 4. Acceptance criteria

Numbered continuing from slice 2C.

### 4.1 Assignment and identification

**125.** Luxury Steal assignment is a column on `master_variant` in Postgres
(D27), set only through the admin path. Nothing derives it from a tag or from
collection membership.

**126.** Assignment syncs to the `carat.luxury_steal` **variant** metafield. The
sync follows slice 2A's discipline: never marked synced before Shopify
confirms, and a sync failure leaves the previous published state authoritative.

**127. A stale or missing metafield must fail SAFE.** If Postgres says a
product is a Luxury Steal and the metafield says otherwise, the **server** is
right. The order-time check reads Postgres, never the metafield, so a
presentation cache that has drifted cannot let a Final Sale item through
unacknowledged.

**128.** Removing Luxury Steal status goes through the same controlled path and
re-syncs. Orders already placed keep the terms they were sold under — the
acknowledgment evidence records what applied at purchase.

### 4.2 Storefront identification and scarcity

**129.** Luxury Steal and Final Sale identification appears on product cards
and product pages — conspicuous, not a footnote.

**130. Quantity messaging reflects real inventory or is absent.** "Only X left"
may render only where X is actual available inventory. A decorative countdown
is a false scarcity claim, not merchandising.

**131.** Real inventory, no overselling, no backorders; an item becomes
unavailable when inventory reaches zero.

**132.** The storefront fabricates no comparison price and no savings claim
(policy §"Pricing and Promotions").

### 4.3 Acknowledgment — the customer-facing gate

**133.** An explicit acknowledgment is required **before add-to-cart** for any
Luxury Steal line. Never pre-checked; acceptance is never inferred.

**134.** The acknowledgment text is the policy's approved wording (§13.2),
pinned character-for-character, with `I Understand & Agree` as the affirmative
action.

**135.** Evidence persists server-side via the existing `Acknowledgment` model:
exact text, policy version, timestamp, affirmative action label, and the
customer / cart / product / variant references available at the time.

**136.** The acknowledgment reference travels with the cart line, so the order
boundary can match line to evidence.

### 4.4 The order boundary — the enforcement that actually binds

**137.** An `orders/create` webhook verifies **every** Luxury Steal line
against stored acknowledgment evidence.

**138.** A line with no matching evidence puts the order into a **held for
staff review** state, and it is never auto-cancelled — a customer who paid is
not the right party to punish for a storefront bypass.

**What "held" means today, stated precisely (D28).** The order is recorded as
`unmatched` in `luxury_steal_order_check`, an admin email is attempted and its
outcome audited either way, and the order appears on the held-orders admin
page. **Nothing on the Shopify order itself is marked, tagged or blocked.** A
normal fulfilment workflow — picking from the Shopify orders list, or any
fulfilment app — has nothing telling it to stop.

So "never silently fulfilled" is a claim about *evidence and notification*,
not about fulfilment being prevented. The earlier wording overstated it, which
an independent QA review caught. See D28 for the open decision.

**139.** Webhook processing is idempotent and authenticity-verified, reusing
slice 0's `receiveShopifyWebhook` — a redelivered `orders/create` must not
create a second hold or a second evidence record.

**140.** Whether a line matched is recorded either way. "Verified, matched" is
evidence too, and its absence later is otherwise indistinguishable from "never
checked".

### 4.5 Final Sale must not swallow legitimate claims

**141.** Final Sale blocks **discretionary** returns, exchanges, cash refunds
and merchandise-credit returns only.

**142.** Nothing in this slice may auto-deny, auto-close or route away a defect,
wrong-item, wrong-specification, transit-damage, not-as-described,
duplicate-charge, non-delivery, warranty or legally-required remedy. Those
route to their normal workflows — slices 4, 5 and 11 — and a Luxury Steal flag
must never be the reason one is refused.

**143.** Customer-facing copy states the restriction without implying the
absence of those remedies. Asserted by a copy test, because this is the exact
sentence a well-meaning edit shortens into something untrue.

### 4.6 Promotions

**144.** Discount codes are not automatically accepted on Luxury Steals; they
apply only where an authorised promotion explicitly includes them.

**145.** The Let Us Beat Your Quote 10% fallback does not apply to Luxury
Steals. Recorded here; enforced in slice 10, which must read this criterion.

### 4.7 Variant-level assignment (D27)

**146.** The **selected variant** determines whether the Final Sale disclosure
and acknowledgment are required. Selecting a non-assigned sibling must remove
both; selecting an assigned one must restore them, with the acknowledgment
returning to **unchecked**. A checkbox that stays ticked across a variant
change would carry consent from a variant the customer never agreed to.

**147.** One Luxury Steal variant must not make normal sibling variants Final
Sale. Asserted directly, on a fixture product with a mixed variant set.

**148.** A product or collection card may show the Luxury Steal badge when **at
least one currently purchasable variant** is assigned. Computed in Liquid from
the variant metafields and each variant's live `available`, not from a stored
product-level rollup — a rollup would need recomputation on every inventory
movement and would be wrong in the window before it caught up. The badge on a
card is therefore advisory; the PDP's per-variant state is what gates
add-to-cart.

**149.** The `carat.luxury_steal` cache preserves per-variant state sufficient
for the theme to render correctly without a second round trip. It is a
`boolean` variant metafield, and **the theme must read it through `.value`**:

    {% if variant.metafields.carat.luxury_steal.value %}

`variant.metafields.ns.key` alone resolves to a metafield *drop*, which is an
object and therefore truthy **whenever the metafield exists at all — including
when its value is `false`**. Testing the drop would show Final Sale on every
variant that had ever been synced. Unassignment writes an explicit `false`
rather than deleting (criterion 128), which guarantees the drop exists on
non-assigned variants, so this is the difference between correct and
uniformly wrong rather than an edge case. Every metafield read in the shipped
`theme/snippets/price.liquid` already goes through `.value`; task 3-5 follows
that precedent.

**150.** Order-time enforcement queries Postgres, never the metafield or any
client-supplied flag. Restates criterion 127 at the variant grain, because D27
is exactly where a "just read the cache, it's per variant now" shortcut becomes
tempting.

**151. Ordinary price recalculation excludes a variant on its OWN assignment,
and a non-assigned sibling is still recalculated.**

Found during task 3-1. A pre-existing `master_product.is_luxury_steal` column
already existed, and `runRecalculation.server.ts` skipped a variant only when
its **product** carried that flag. D27 moves the truth to the variant, so a
variant-level Luxury Steal whose product flag is `false` would not have been
skipped: the job would compute an ordinary price and publish it over the
deliberately-low assigned price, which `LUXURY-STEALS.md` requires to be
explicit and auditable. Money-critical, and latent rather than visible —
auto-publish is off and no real Luxury Steals exist yet, so nothing would have
failed loudly.

The legacy column is **retired**, not left alongside the new one: backfilled
down to its variants and dropped in the same migration, so there is no second
source of truth for anything to drift against. Zero products carried the flag,
so the backfill is a no-op here and correct anywhere else.

The reverse hazard is the one to test. The old behaviour excluded **every**
variant of a Luxury Steal product; the new behaviour deliberately does not, so
a normal sibling must still be recalculated. That is criterion 147 at the
pricing layer, and it is asserted directly.

**152. A failed `carat.luxury_steal` sync retries and is surfaced, but must
NOT make the variant unavailable.**

CLAUDE.md rule 17 governs a failed publish of a *price* to Shopify: hold the
last published price, retry, alert, and after 48 hours unresolved make the
affected variant unavailable. Applying that wholesale here would be wrong, and
the difference is worth stating rather than inheriting by reflex.

A failed price sync leaves Shopify selling at a **wrong price** — real money,
and withdrawing the variant is the safe end state. A failed Luxury Steal
metafield sync leaves the storefront showing a Luxury Steal **without its
badge, disclosure or acknowledgment gate**. That is a disclosure defect, not a
mispricing, and criterion 127 already makes it fail safe: the order-time check
reads Postgres, so such an order is caught and held rather than fulfilled. The
customer sees the wrong presentation; the enforcement still binds.

Withdrawing the variant after 48 hours would therefore take a correctly-priced,
in-stock item off sale because a boolean did not reach a cache — a worse
outcome than the defect, and self-inflicted.

So: **retry, record the failure durably, surface it in the admin. Do not
change purchasability.** The previously published metafield state stays in
place, and nothing is marked synced before Shopify confirms (criterion 126,
which does carry over unchanged).

This is a deliberate narrowing of rule 17 for a non-money cache, not an
exemption from it. Any metafield that carries money stays under rule 17 in
full.

## 5. Data model

| # | Change | Why |
|---|---|---|
| M11 | `master_variant.is_luxury_steal` — NOT NULL, default `false` | Criteria 125 / 146-147 — the system of record, at the grain D27 requires |
| M11b | Backfill `master_product.is_luxury_steal` down to its variants, then DROP the column | Criterion 151 — retire the legacy grain rather than keep two sources of truth |
| M12 | `luxury_steal_order_check` — order ref, line ref, variant ref, matched acknowledgment id (nullable), outcome, checked-at | Criteria 137-140. A hold is a state we must be able to query and audit, not a log line |

`Acknowledgment` (slice 0) needs **no change** — it already carries exact text,
policy version, timestamp, affirmative action label and every reference this
slice populates. That is the model doing the job it was built for.

**Settled by D27: variant-level.** The admin "apply to all variants" action is a
convenience that writes N variant rows; it is not a second storage location,
and nothing may read assignment from the product.

## 6. Native Shopify vs custom

| Capability | Owner |
|---|---|
| Cart, checkout, payment, inventory, order record, fulfilment | **Shopify** |
| Collection and navigation | **Shopify** |
| Luxury Steal assignment, acknowledgment gate and evidence, order verification, hold state | **Custom** |
| Badges, disclosure, scarcity display | **Theme**, reading the synced metafield |

## 7. Test plan

**Money-critical / evidence-critical.** Acknowledgment required before
add-to-cart; never pre-checked; evidence persisted with exact text and version;
reference carried to the order; `orders/create` matching every line; an
unmatched line held and never fulfilled; redelivery creating no duplicate;
a matched line recorded as matched.

**Fail-safe.** Postgres says Steal, metafield says otherwise → still enforced.

**Separation.** A defect/warranty/wrong-item path is not blocked by the Final
Sale flag.

**Scarcity.** Quantity messaging renders only from real inventory.

**Copy.** Acknowledgment and disclosure pinned character-for-character once
approved, as slice 2C's strings are.

**Live gate.** Against `caratforus-dev`: acknowledge, add to cart, order, and
confirm the check records a match; then bypass the storefront and confirm the
order is held.

## 8. Non-goals

Cart/Checkout Validation Function (D6). Waitlists, restock promises, back-order
handling. Luxury Steals RMA — there is no discretionary return window to build.
Automated claim adjudication. Anything in `CLAUDE.md`'s Post-MVP list.

## 9. Task breakdown

| Task | Agent | Owns |
|---|---|---|
| 3-1 — M11/M12 migrations, assignment domain + admin path | Backend (`sonnet`) | `prisma/`, `app/domain/luxurysteals/**` |
| 3-2 — metafield sync | Backend (`sonnet`) | `app/shopify/admin/**` |
| 3-3 — acknowledgment capture + evidence | Backend (`sonnet`) | `app/routes/apps.carat.luxury-*` |
| 3-4 — `orders/create` verification and hold | Backend (`sonnet`) | `app/shopify/webhooks/**` |
| 3-5 — theme: badges, disclosure, gate, scarcity | Shopify Dev (`sonnet`) | `theme/**/luxury-*` only |
| 3-6 — tests | Test Eng (`haiku`) | `tests/` |
| 3-7 — QA + architect acceptance | QA (`sonnet`), Tech Lead (`opus`) | read-only |

3-5 obeys the Track A/B file boundary in `PARALLEL-WORK-PLAN.md`: new
`luxury-*` files and component-scoped CSS only.

## 10. Architecture review

**Boundary is right.** Shopify keeps cart, checkout, inventory and fulfilment.
We add assignment, a consent gate, evidence and an order-time audit — none of
which Shopify can express for us.

**No new infrastructure.** Two tables, one metafield, one webhook topic, one
theme surface. The acknowledgment model, webhook idempotency, policy versioning
and metafield sync all already exist and are live-proven.

**The one structural risk is D6's consequence.** With no Function, the
storefront gate is *preventive but bypassable* — a determined customer or a
stale cached page can reach checkout without acknowledging. Criteria 137-140
are therefore load-bearing rather than defensive, and criterion 127's
fail-safe direction matters for the same reason: the check must read the
server's truth, not the cache the bypass may have exploited.

**Second risk: the separation in §4.5 erodes quietly.** "Final Sale" is a
phrase that tends to expand in the retelling, in copy and in staff behaviour.
Criterion 143 pins the copy; criterion 142 keeps the claim workflows reachable.
Neither survives a rewrite that nobody tests, which is why both are tested.

**Third, smaller: scarcity honesty.** Criterion 130 forbids decorative
countdowns. This is a compliance matter, not a UX preference, and the theme
must render quantity only from real inventory.

**VERDICT: APPROVE WITH CONDITIONS.**

1. Owner approval of the **disclosure copy** (§13.1) before it is pinned or
   shipped. The acknowledgment text (§13.2) is already policy-approved.
2. Owner decision on **product-level vs variant-level** assignment (§5).
3. D11 — legal review of customer-facing acknowledgment copy — remains open and
   is recorded against slice 12; worth confirming whether counsel review
   precedes launch.

No unresolved architectural question. Implementation may begin on tasks 3-1 and
3-2, which touch no customer-facing copy, while the copy is approved.

## 11. Carried-forward register

Unchanged: F-2C-1 … F-2C-5. Slice 3 adds the following.

These are **unverified behaviours, not known defects** — recorded because the
storefront work (3-5) had no browser, no Shopify CLI and no theme test harness
available, and "reviewed by code trace" is not the same claim as "observed
working". Slice 2C's lesson stands: every one of its four phases had a defect
that only a live gate could reach.

| # | What is unproven | How it gets closed |
|---|---|---|
| F-3-1 | ~~The acknowledgment POST round trip → `_carat_ls_ack` on the line → order~~ **CLOSED 2026-09-24 by live gate stage 2, in production.** A real acknowledgment minted through the deployed App Proxy route, carried on a real order line, matched at `orders/create` against production Postgres. The companion order with no property was recorded `unmatched` and alerted. What remains unproven is only the PDP *front end* that produces the POST — see F-3-2/F-3-5. | — |
| F-3-2 | Criterion 146 in a browser: switching variants re-renders the gate, resets the checkbox and clears the hidden input | Live gate; both the normal `variant-change` path and the combined-listings path |
| F-3-3 | The combined-listings path specifically — code-reviewed only, with no fixture in this repo | Live gate, or an explicit decision that combined listings are out of MVP1 |
| F-3-4 | `shopify theme check`, plus any visual or screen-reader pass | Run the CLI where it is available; AT pass before public launch |
| F-3-5 | That the badge, disclosure and gate render at all on a real product | Live gate — it needs an assigned Luxury Steal variant, which needs 3-2b's admin path |

F-3-5 is the dependency worth noting: none of this can be exercised until a
real variant is assigned through the admin, so the live gate runs after 3-2b,
not before.

**Accepted, not carried:** accelerated-checkout and no-JS bypass of the gate.
Those are the D6 residual, covered by the order-time check, and they are not
going to be closed by a browser test.

## 12. Non-blocking note

Slice 3 is built against fixtures. Real Luxury Steals arrive through Track C
whenever the catalogue is ready; an unpriced or unmapped product simply is not
a Luxury Steal yet, and that blocks nothing here.

## 13. Copy

### 13.1 Final Sale disclosure — OWNER-APPROVED 2026-09-23

Reproduced exactly as approved, including the curly apostrophes in "can’t"
and "we’ll" and the em dash in the heading line. Pin character-for-character
once implemented, in the same manner as the slice 2C strings.

**Badge (cards and PDP):**

> Final Sale

**Product page disclosure:**

> Final Sale — this item cannot be returned or exchanged for change-of-mind reasons.
>
> Luxury Steals are limited pieces offered at exceptional prices. Because of that, this item can’t be returned or exchanged if you change your mind, prefer another style, or choose the wrong size or configuration. Please review the specifications and your selected options carefully before ordering.
>
> This does not affect claims for an item that arrives damaged, is not what you ordered, does not match its description, or may have a manufacturing issue covered by our warranty. If something is wrong with your order, contact us and we’ll review it under the applicable CaratForUs warranty or claims policy.

The owner's revision is more careful than the draft it replaced, in two ways
worth preserving against future editing:

- the heading scopes the restriction to **change-of-mind reasons** rather than
  stating flatly that the item cannot be returned;
- the third paragraph promises a **review under the applicable policy** rather
  than promising to "put it right", which would have committed to a remedy
  before inspection.

Criterion 143's test pins the whole string, so neither can be lost to a later
edit.

**Scarcity line — rendered only when it reflects real inventory:**

> Only {{ count }} left

### 13.2 Final Sale acknowledgment — ALREADY APPROVED IN POLICY

Taken verbatim from `docs/LUXURY-STEALS.md`, not drafted here:

> **FINAL SALE ACKNOWLEDGMENT**
>
> I understand that this item is a Luxury Steal and is **FINAL SALE**. I
> understand that it cannot be returned or exchanged because I change my mind,
> prefer another style, select the wrong size or configuration, or otherwise no
> longer want the item. I have reviewed the item specifications and selected
> options before purchasing.

Affirmative action: **I Understand & Agree**
