# Slice 2C — Bank Payment Checkout

## Status

**DRAFT — awaiting owner approval. No implementation has begun.**

Author: Principal Architect / Tech Lead
Date: 2026-09-21
Predecessor: Stage 2B, accepted and closed at `34bc303`

---

## 1. Outcome

A customer who has chosen Bank Payment pricing can complete a purchase at that
price. They supply an email and shipping address, receive an invoice for the
Bank Payment total, and are told plainly that the order is not committed until
payment is received and verified. The quoted price is guaranteed for 24 hours.
An admin verifies the incoming payment by hand, recording amount, method,
reference, timestamp and who verified it, and the draft becomes a real Shopify
order.

Stage 2B made Bank Payment a price a customer can *see*. 2C makes it a price a
customer can *pay*.

## 2. Authoritative sources

| Area | Source |
|---|---|
| Bank Payment orders, guarantee, verification, disclosures | `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` **§21, §22, §23** |
| Eligibility, cart mode, card-payment prohibition | same, **§18, §19, §20** |
| Merchandise-only savings | same, **§6** |
| Platform capability findings | `docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md` |
| Card/bank derivation, tiers, rounding | `docs/BANK-CARD-PRICING.md` |
| Cart surfaces, L1–L5, R9–R17 | `docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md` |
| Money, delegation, git discipline | `CLAUDE.md` |

**Owner decisions D19, D20, D21 approved 2026-09-21** — recorded in §4 below.

## 3. What already exists

2C is mostly **wiring**, not new invention. Already built and tested:

- `bank_payment_order` and `bank_payment_order_line` (migration M6), with the
  verification block on the **header** per ruling R3, and the line **whole-row
  append-only** per ruling R1;
- the cart pricing service and its allowlisted proxy DTO (2B-1);
- cart payment mode, the two add-to-cart actions, Card Checkout interception
  and the Card→Bank switch (2B-5);
- the published-price resolver and metafield coherence (C1/C5, R14);
- the admin alert channel (state persisted; **email delivery still needs
  configuration**, see §9).

**Not yet built:** the draft-order adapter, the checkout route, the details
form, the guarantee sweep, the verification admin surface, and the disclosures.

## 4. The three owner decisions, as approved

**D19 — shipping and tax.** Shipping and insurance are **already in landed
cost** (`CostComponentType.shipping`, `.insurance`; `README.md` requires it so
they do not silently erode margin). A separate shipping charge would bill the
customer twice. The draft order therefore carries a **zero-price shipping
line** — explicit rather than absent, so the record shows shipping was priced
at nil deliberately.

The **24-hour guarantee covers the merchandise price only**. Tax is a
jurisdictional fact that can change by law and is recalculated at completion.
This matches §6's merchandise-only savings rule; guaranteeing tax as well would
put the two rules in disagreement.

If expedited shipping is ever charged separately, that line is **not**
guaranteed and is priced at completion. Written here now rather than retrofitted.

**D20 — identity.** A short pre-invoice form captures **email and shipping
address**. Prefilled from `logged_in_customer_id` where available, never gated
on it. **A customer account is not required.** Email is materially required (a
draft order cannot exist without one); an account is not, and `CLAUDE.md`
requires keeping friction low except where materially required.

The usual objection — guest manual-payment orders inviting abandonment — does
not apply: §22 already means no inventory is reserved, so an abandoned bank
order costs nothing but admin noise.

**D21 — suspension vs an open order.** **Honour the order.** The quoted price
is already fixed on the bank order and does not depend on the suspended
calculation; no inventory was reserved; and suspension means *our* sync or
calculation failed. Cancelling would punish a customer for our outage.

If the 24 hours expire while the variant is still suspended, we cannot compute
a price to compare, so §21's "has the price changed?" is unanswerable. Treat
unresolvable as **not changed**: the order stays open and is flagged for admin.
Auto-cancelling on an unanswerable question converts an outage into a lost sale.

## 5. Acceptance criteria

Numbered continuing from Stage 2B. Each is written so a test can fail it.

### 5.1 Bank Payment Checkout

**71.** Bank Payment Checkout creates a Shopify **draft order** whose line
prices are the **Bank Payment Price** for eligible lines and the **Regular/Card
Price** for ineligible ones (§18), set via `originalUnitPrice`.

**72.** Every line price is **recomputed server-side** from the published
calculation at quote time. A tampered cart attribute or line property may
change which mode is requested, never what a line costs (criterion 43).

**73. `reserveInventoryUntil` is never sent** (§22). Asserted on the
**serialised request payload**, not on intent.

**74.** The route is a **resource route with no default export** (criterion 57).
`allowedActionOrigins` is empty in every production build, so a default export
means a silent 400 before validation runs.

**75.** Creation is **idempotent** (criterion 53): an `idempotency_key` row is
committed **before** the Admin API call, keyed per **criterion 105** on the
resolved customer email + mode + a content hash of the recomputed lines. **Not
the cart token**, which can rotate — see C2C-4. A repeat returns the stored draft order and sends
**no** second invoice.

**76.** A Buy Now cart and a Group Buy cart may **never** produce one bank order
(§20), refused server-side even when the theme guard is bypassed.

### 5.2 The 24-hour guarantee

**77.** `quotedAt` and `guaranteeExpiresAt` are stored per order;
`quotedBankPaymentPriceMinorUnits` and `quotedRegularCardPriceMinorUnits` per
line, with the `priceCalculationId` they came from.

**78.** Paid within 24 hours → the quoted price is honoured, whatever the
current price is.

**79.** After 24 hours, unpaid, **price unchanged** → the order stays open at
the quoted price (§21).

**80 and 81 are SUPERSEDED by owner decision D22 (§13). Implement §13's
versions, not the two struck paragraphs below — they are kept only so the
change stays legible.** The difference is material: D22 cancels only on
**human-approved** publications, and asks the question **historically** rather
than of the current published calculation.

> ~~**80.** After 24 hours, unpaid, any line's price changed by any amount →
> the order is cancelled and the customer emailed (§21). No tolerance band —
> one cent qualifies.~~
>
> ~~**81.** "Changed" compares the quoted price against the currently published
> price (`lastSyncedPriceCalculationId`), never the newest computed one. A
> price awaiting approval has not changed for this purpose, because it is not
> what a customer could buy at.~~

**82.** Per D21, a variant whose price is **unresolvable** (suspended, failed)
counts as **unchanged**; the order stays open and is flagged.

### 5.3 No commitment before verified payment

**83.** No inventory is reserved at any point before payment is verified (§22).

**84.** The **checkout page** states the order is not committed and
availability is not guaranteed until Bank Payment is received and verified
(§22). Owner-approved copy, pinned character-for-character.

**85.** The **confirmation email** carries the same disclosure (§22).

**86.** If payment arrives after the item has sold out, the case is **flagged
for admin** rather than auto-resolved (§22).

### 5.4 Manual verification

**87.** Verification is a manual admin action recording **amount, method,
reference where available, timestamp and verifying admin** (§23).

**88.** Verification is **idempotent**: a double submit records one
verification and completes one order.

**89.** Completing a verified order converts the draft to a real Shopify order
through a **manual payment gateway**. The app never handles card data.

**90.** Customer payment proof stays **email/manual** for MVP1 (§23). No upload
surface is built.

**91.** The verification workflow is **reusable for Group Buy** (§23) — the
record and the action are not Buy Now-specific. Group Buy's own downstream
rules are slice 8's and are not built here.

### 5.5 Card cannot pay a bank price

**92.** A Bank-priced order can **never** be completed by card (§19). The draft
order's total is the bank total; completing it goes through the manual gateway.

**93.** Switching a cart back to Card **reprices before payment** and shows the
updated total (§19) — already built in 2B-5, re-asserted here because 2C adds a
second path to checkout.

### 5.6 Identity and totals

**94.** Email and shipping address are captured before the invoice; prefilled
from `logged_in_customer_id` when present, never required to be a customer
account (D20).

**95.** A **zero-price shipping line** is set explicitly on the draft order
(D19). Tax is computed by Shopify and **recalculated at completion**; only
merchandise is guaranteed.

## 6. Data model

Mostly present. Three additions:

| # | Change | Why |
|---|---|---|
| M8 | `bank_payment_order.customer_email` **only** | D20 plus **criterion 97**: the address is sent to Shopify and **never persisted by us**. Email is the argued exception — the cancellation email must be sendable after the draft order is gone |
| M9 | `bank_payment_order.idempotency_key` unique, or reuse the existing `idempotency_key` table | Criteria 75 and **105** — email + mode + line hash, not cart token |
| M10 | Extend the append-only trigger to the new quote-adjacent columns if any are added to the line | Consistency with R1 |

**Not stored:** the card price for eligible lines beyond
`quotedRegularCardPriceMinorUnits`, which is a historical fact about what the
customer was shown, not a derivation (ruling R1's recorded exception).

## 7. Native Shopify vs custom

| Capability | Owner |
|---|---|
| Draft order, invoice delivery, draft→order conversion | **Shopify Admin API**, orchestrated by the app |
| Manual payment gateway | **Shopify** — the app never touches funds |
| Tax calculation | **Shopify** |
| Order record, fulfilment, customer notifications | **Shopify** |
| Quote, guarantee, expiry sweep | **Custom** |
| Payment verification record and workflow | **Custom** |
| Checkout form and disclosures | **Theme** |

**Scope needed:** `write_draft_orders` (and `read_draft_orders`). Current grant
is `read_products, write_products, read_inventory`. A scope change re-prompts
on the development store, as `read_inventory` did.

## 8. Test plan

**Money-critical.** Line prices recomputed server-side; tampered mode or price
rejected; `reserveInventoryUntil` absent from the serialised payload;
idempotent creation producing one draft and one invoice; the guarantee
boundary at exactly 24 hours; a one-cent change cancelling; an unchanged price
not cancelling; an unresolvable price not cancelling; double-submit
verification producing one order.

**Disclosure.** Checkout and email copy pinned character-for-character, as
`ownerApprovedCopy.test.ts` now does for the cart strings.

**Contract.** Per R16, any payload crossing into Liquid is fed to the consumer
from the **real producer's serialised output**, never a hand-built fixture.

**Live, against `caratforus-dev`.** Create a bank order end to end; confirm no
inventory is held; verify a payment; confirm the draft converts to a real
order; confirm the invoice arrives.

## 9. Dependencies and risks

**The email channel is not configured.** `EMAIL_API_KEY`, `EMAIL_FROM` and
`STAFF_EMAIL_ALLOWLIST` are unset, so alerts currently record
`skipped_unconfigured`. 2C's cancellation email (criterion 80) and confirmation
disclosure (criterion 85) are **customer-facing** — this moves from an
operational nicety to a launch blocker. Flagged as an ops task, not code.

**Customer-facing copy needs owner approval** before it ships: the
not-committed disclosure, the cancellation email, and the awaiting-verification
state. `CLAUDE.md` forbids inventing material terms.

**Draft orders are not the standard checkout.** The customer leaves the normal
flow. `BANK-PAYMENT-CHECKOUT-FINDINGS.md` recorded this trade-off when the
approach was first proposed; it remains true and is the price of charging a
genuinely different amount.

## 10. Non-goals

A customer payment portal. Automated payment matching or bank-feed
reconciliation. Payment-proof upload. Group Buy invoicing (slice 8). Partial
payments or deposits. Refunds against bank orders (slices 4 and 8). Multi-
currency. Anything in `CLAUDE.md`'s Post-MVP list.

## 11. Task breakdown

| Task | Agent | Owns |
|---|---|---|
| 2C-1 — draft-order adapter, idempotent creation, zero shipping line | Backend & Pricing (`sonnet`) | `app/shopify/admin/draftOrder*` |
| 2C-2 — M8/M9 migrations | Backend & Pricing (`sonnet`) | `prisma/` |
| 2C-3 — checkout route, details form, server-side reprice | Backend & Pricing (`sonnet`) | `app/routes/apps.carat.bank-checkout*` |
| 2C-4 — guarantee sweep and cancellation | Backend & Pricing (`sonnet`) | `app/jobs/bankpayment/` |
| 2C-5 — verification admin surface | Frontend & UX (`sonnet`) | `app/routes/` admin |
| 2C-6 — checkout and email disclosures | Shopify Dev (`sonnet`) | `theme/`, locales |
| 2C-7 — money-critical and contract tests | Test Engineer (`haiku`) | `app/tests/` |
| 2C-8 — QA and security review | QA & Security (`sonnet`) | read-only |
| 2C-9 — architect acceptance | Tech Lead (`opus`) | read-only |

2C-1 and 2C-2 precede everything. 2C-3 depends on both. 2C-4, 2C-5 and 2C-6
can run in parallel once 2C-3 lands.


---

## 12. Architecture Review Verdict

Reviewed 2026-09-21 against `CLAUDE.md`, `README.md`,
`docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md`, `docs/BANK-CARD-PRICING.md`,
`docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md`, `docs/ARCHITECTURE-MVP1.md` and the
repository at `34bc303`.

### 12.1 What holds

- **Native boundary is right.** The draft order, invoice, tax calculation,
  manual gateway, order record and fulfilment all stay Shopify. Custom surface
  is the quote, the guarantee, the verification record and the disclosures —
  things Shopify genuinely cannot express.
- **No new infrastructure.** No queue, service, database or dependency. Cost
  unchanged.
- **Mostly wiring.** The schema, cart service, allowlisted DTO, published-price
  resolver, coherence checks and alert channel already exist and are tested.
  2C adds an adapter, a route, a sweep and an admin surface.
- **D19/D20/D21 are consistent with locked decisions** rather than new policy —
  each derives from §6, §22 and §21 respectively.

### 12.2 Conditions — close before implementation

**C2C-1 — PII: do not duplicate the shipping address.** `CLAUDE.md` requires
minimising PII and says to *"reference Shopify customer/order IDs rather than
duplicating profiles"*. M8 as drafted stores a full shipping address in
`bank_payment_order`, duplicating what Shopify already holds on the draft
order, in a table we control and must then protect, retain and redact.

Send the address to Shopify at draft creation and **do not persist it**. Store
only what we cannot re-derive: the draft order GID. Retrieve the address from
Shopify when something needs it.

**Email is the one genuine exception** and should be argued rather than
assumed: the cancellation email (criterion 80) must be sendable when the draft
order may already be deleted. Store `customer_email` alone, and say in the
schema comment why that single field earns its place when the address does not.

**C2C-2 — the sweep cadence is unspecified, and a 24-hour rule cannot run on a
daily job.** Criterion 80 cancels an unpaid order after 24 hours if the price
moved. Nothing in the spec says what runs that check or how often. If it rides
the daily recalculation, an order can sit up to 24 hours past expiry before
anyone notices, and the customer may pay in that window against a price we
intended to withdraw.

Specify the cadence explicitly — hourly is the obvious floor — and make the
sweep idempotent so a double run cannot double-cancel or double-email.

**C2C-3 — `86` has no detection mechanism.** "If payment arrives after the item
sold out, flag for admin" requires knowing, at verification time, whether the
item is still available. Nothing in the spec queries that. State where the
check happens: at verification, re-query `availableForSale` for every line and
surface the result to the verifying admin **before** they confirm, rather than
discovering it after the order exists.

**C2C-4 — idempotency keyed on cart token is weaker than it looks.** Shopify
cart tokens can rotate. Two submissions either side of a rotation produce
different keys and therefore two draft orders and two invoices for one
customer. Include something stable — the resolved customer email plus the
line-content hash — or accept and document the residual.

### 12.3 The interaction that needs an owner decision

**D22 — auto-publish makes cancellation routine, and nobody has weighed that.**

Stage 2B enabled automatic publication of Bank Payment Price changes within
200 bps. §21 says **any** change, of any size, cancels an unpaid bank order
after 24 hours.

Those two rules were settled independently and they compose into something
neither anticipated: a customer places a bank order, gold moves 0.4% overnight,
the price auto-publishes with no human involved, and their order is cancelled
the next day for a change **no person decided to make and the customer could
not have anticipated**. With daily recalculation and live metal prices, this is
not an edge case — it is the expected path for any order left unpaid overnight.

Three options, and this is the owner's call:

1. **Accept it.** Honest, and consistent with §21 as written. Expect routine
   cancellations and make the checkout copy say so plainly.
2. **Exempt auto-published changes** from triggering cancellation, cancelling
   only on changes a human approved. Keeps the customer promise stable; means a
   bank order can outlive a small price move.
3. **Add a tolerance to the cancellation rule** — but §21 explicitly says "no
   minimum threshold: any change", so this contradicts a locked decision and
   would need reopening rather than interpreting.

**Recommendation: option 2.** It preserves §21's intent — protecting us from
honouring a stale price after a *material* repricing — while not punishing a
customer for routine noise the system published on its own. Option 1 is
defensible but will generate cancellations that look arbitrary to customers and
support staff alike.

I am not choosing this unilaterally because it changes when a customer's order
dies, which is a customer-facing promise.

### 12.4 Responsibility matrix

| Layer | Owns |
|---|---|
| **Shopify** | Draft order, invoice delivery, tax, manual gateway, order record, fulfilment, customer order emails, inventory truth |
| **Backend** | Quote and server-side reprice, idempotent creation, guarantee sweep, cancellation, verification record, sold-out check at verification |
| **Frontend / theme** | Bank Payment Checkout action, details form, checkout disclosure |
| **Persistence** | `bank_payment_order` + lines as the quote and verification record; **no duplicated address** |
| **Third parties** | Resend for the cancellation email — the only new external dependency, and it is already chosen |

### 12.5 Phasing

| Phase | Contains | Gate |
|---|---|---|
| **2C-a** | Adapter, migrations, checkout route and form | Architect acceptance; no customer traffic |
| **2C-b** | Guarantee sweep and cancellation | Blocked on **D22** and on the email channel being configured |
| **2C-c** | Verification admin surface and disclosures | Owner copy approval before anything ships |

### 12.6 Not built in MVP1

Customer payment portal; automated payment matching or bank-feed
reconciliation; payment-proof upload; Group Buy invoicing; partial payments or
deposits; refunds against bank orders; multi-currency.

---

### VERDICT: **APPROVE WITH CONDITIONS**

The design is sound, the native boundary is right, and most of 2C is wiring
components that already exist and are tested. Approval is conditioned on:

1. Closing **C2C-1 to C2C-4** before implementation. C2C-1 (PII) and C2C-2
   (sweep cadence) are defects in the spec as drafted, not preferences.
2. An owner decision on **D22**, which blocks phase 2C-b. Auto-publish and the
   any-change cancellation rule compose into routine customer-facing
   cancellations that neither decision anticipated.
3. **Email channel configured** before 2C-b ships. The cancellation email is
   customer-facing, which moves this from an operational nicety to a launch
   blocker.
4. **Owner approval of the customer-facing copy** — not-committed disclosure,
   cancellation email, awaiting-verification state — before 2C-c ships.
5. `write_draft_orders` granted, expecting an OAuth re-prompt as `read_inventory`
   required.

No implementation begins until conditions 1 and 2 are resolved.


---

## 13. D22 — auto-published changes do not cancel an unpaid bank order

**OWNER RULING, 2026-09-21. Approved option 2.**

An unpaid Bank Payment order past its 24-hour guarantee is cancelled only when
the published price changed through a **human-approved** publication. A change
that reached the storefront through **automatic publication** does not cancel
it.

### Why this does not contradict §21

§21 says *"any change, of any amount"* cancels, with no minimum threshold. That
rule was written before automatic publication existed, to stop us honouring a
stale quote after the price had genuinely moved. Its target was **a price we
decided to change**.

Automatic publication creates a class §21 could not have contemplated: a price
that changes with nobody deciding anything, from ordinary metal-market drift,
inside a tolerance chosen precisely because such moves are unremarkable. With
daily recalculation on live prices, that is the expected overnight outcome for
any unpaid order — so applying §21 literally would make cancellation the
**normal** ending for a bank order rather than an exception.

§21's "no minimum threshold" is preserved exactly where it bites: **once a
human has approved a repricing, any amount cancels.** One cent still qualifies.
The threshold was never the point; the decision behind the change was.

### THE PRECISION THAT MATTERS: it is not "was the latest publication automatic"

The naive implementation checks how the **current** published calculation was
published. That is wrong, and it fails in the customer's favour in a way nobody
would notice:

> A human approves a 6% rise. Overnight, gold drifts and a 0.3% change
> auto-publishes on top. The latest publication is now automatic — so the
> naive check says "do not cancel", and the order survives a repricing a human
> explicitly approved.

**The rule is therefore historical, not current-state.** Cancel when **any
human-approved publication occurred between the quote and now**, regardless of
what published most recently. `price_sync_intent` already records `decision`
(`auto_apply` vs `needs_approval`) and `syncedAt`, so the query is: did any
intent for these variants reach `synced` with `decision = needs_approval` after
`quotedAt`?

### What counts as human-approved

- an intent decided `needs_approval` and approved by an admin;
- a **manual price override** (§17's rejection-with-override path) — a human set
  that price deliberately, which is the strongest form of the signal.

### What does not

- an intent decided `auto_apply` and published automatically;
- no change at all;
- an **unresolvable** price (suspended or failed), which per **D21** counts as
  unchanged.

### Acceptance criteria, replacing 80 and 81

**80 (revised).** After 24 hours, unpaid, with **at least one human-approved
publication** for any line since `quotedAt` → cancel and email the customer.
No tolerance band: one cent of human-approved change qualifies.

**81 (revised).** The check is **historical**: any `price_sync_intent` for the
order's variants that reached `synced` with `decision = needs_approval` after
`quotedAt`. Not "how was the current published calculation published". A test
must cover human-approval-then-auto-publish and assert the order **is**
cancelled — that ordering is the one a current-state check gets wrong.

**82 (unchanged).** An unresolvable price counts as unchanged (D21).

**96 (new).** After 24 hours, unpaid, with **only automatic publications**
since `quotedAt` → the order **stays open at the quoted price**, and the
customer is not emailed. The quoted price is honoured on later payment.

### The residual, stated plainly

An order can now outlive an unbounded accumulation of small automatic moves —
twenty 0.4% days compound to roughly 8% while remaining individually
auto-publishable. We would honour the original quote against a materially
different current price.

This is bounded in practice by the 200 bps tolerance queuing anything larger
for a human, which then cancels. It is not bounded in theory. If it proves
material, the fix is a cumulative-drift ceiling on the guarantee rather than
reverting to §21's literal reading — but that is a new decision and is not
being made now.


---

## 14. Review conditions C2C-1 … C2C-4 — closed as acceptance criteria

Folded into §5 rather than left as review prose, because a condition that lives
only in a verdict is a condition nobody tests.

### C2C-1 — do not duplicate the shipping address (PII)

**97.** The shipping address is sent to Shopify at draft-order creation and
**never persisted by us**. `CLAUDE.md` requires minimising PII and says to
reference Shopify ids rather than duplicating profiles. An address stored in
`bank_payment_order` is a second copy we must then secure, retain and redact,
for no capability Shopify does not already give us through the draft order.

**98. `customer_email` is the one stored exception, and it is argued rather
than assumed.** The cancellation email (criterion 80) must be sendable when the
draft order may already have been deleted, so the address of the person to tell
cannot live only on the thing being removed. The schema comment must state that
reasoning, so a later reader does not "tidy up" by adding the postal address
beside it.

**99.** Anything else needing the address — an admin reviewing a payment, say —
**reads it from Shopify at the time**, never from our tables.

### C2C-2 — the guarantee sweep runs hourly and is idempotent

**100.** The sweep runs **hourly**, not on the daily recalculation. A 24-hour
rule on a daily job can leave an order live a full day past expiry, during
which a customer may pay against a quote we intended to withdraw.

**101.** The sweep is **idempotent**: a double run cancels once and emails
once. It must be safe to run concurrently with itself, since an hourly
scheduler eventually overlaps a slow run.

**102.** The sweep never cancels on its own failure. If the current published
price cannot be resolved, the order is left open and flagged — D21 and
criterion 82, applied to the sweep rather than only to the guarantee rule.

### C2C-3 — sold-out is checked at verification, before the admin confirms

**103.** At verification, every line's current `availableForSale` is re-queried
from Shopify and **shown to the verifying admin before they confirm**.
Criterion 86 says a payment arriving after a sell-out is flagged for admin
handling; that is only possible if the admin is told **while deciding**, not
after an order exists.

**104.** A sold-out line does not block verification. Recording that payment
arrived is a fact, and §22 requires human handling rather than an automatic
resolution — the admin decides, with the information in front of them.

### C2C-4 — idempotency does not key on the cart token alone

**105.** The idempotency key is derived from the **resolved customer email**
plus a content hash of the server-recomputed lines — not the Shopify cart
token, which can rotate. Two submissions either side of a rotation would
otherwise produce two draft orders and two invoices for one customer.

**106.** The key is committed **before** the Admin API call, per
`ARCHITECTURE-MVP1.md` §6.7 and criterion 75. A repeat returns the stored draft
order and sends no second invoice.
