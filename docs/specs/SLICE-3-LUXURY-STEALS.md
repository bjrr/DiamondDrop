# Slice 3 — Luxury Steals

## Status

**DRAFT — awaiting owner approval of the Final Sale disclosure copy (§13).
No implementation has begun.**

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

## 4. Acceptance criteria

Numbered continuing from slice 2C.

### 4.1 Assignment and identification

**125.** Luxury Steal assignment is a column on the master product/variant in
Postgres, set only through the admin path. Nothing derives it from a tag or
from collection membership.

**126.** Assignment syncs to the `carat.luxury_steal` product metafield. The
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
staff review** state. It is never silently fulfilled and never auto-cancelled —
a customer who paid is not the right party to punish for a storefront bypass.

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

## 5. Data model

| # | Change | Why |
|---|---|---|
| M11 | `master_product.is_luxury_steal` (or a variant-level equivalent if the owner wants per-variant assignment) | Criterion 125 — the system of record |
| M12 | `luxury_steal_order_check` — order ref, line ref, variant ref, matched acknowledgment id (nullable), outcome, checked-at | Criteria 137-140. A hold is a state we must be able to query and audit, not a log line |

`Acknowledgment` (slice 0) needs **no change** — it already carries exact text,
policy version, timestamp, affirmative action label and every reference this
slice populates. That is the model doing the job it was built for.

**Open for the owner:** product-level or variant-level assignment. Product-level
is simpler and matches how Luxury Steals are described; variant-level is needed
if one size or metal of a piece is a Steal and another is not. I recommend
**product-level** unless you expect mixed variants.

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

Unchanged: F-2C-1 … F-2C-5. Slice 3 adds none.

## 12. Non-blocking note

Slice 3 is built against fixtures. Real Luxury Steals arrive through Track C
whenever the catalogue is ready; an unpriced or unmapped product simply is not
a Luxury Steal yet, and that blocks nothing here.

## 13. Copy

### 13.1 Final Sale disclosure — PROPOSED, NEEDS OWNER APPROVAL

Shown on the product page and, abbreviated, on cards. Drafted to state the
restriction plainly while preserving the §4.5 separation — the second paragraph
is the one that must not be cut.

**Badge (cards and PDP):**

> Final Sale

**Product page disclosure:**

> **Final Sale — this item cannot be returned or exchanged.**
> Luxury Steals are limited pieces offered at exceptional prices. Because of
> that, this item can't be returned or exchanged if you change your mind,
> prefer another style, or choose the wrong size or configuration. Please
> review the specifications and your selected options carefully before
> ordering.
>
> This does not affect your rights if something is wrong with your order. If
> your item arrives damaged, is not what you ordered, doesn't match its
> description, or develops a manufacturing fault covered by our warranty,
> contact us and we'll put it right.

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
