# Slice 2C — Bank Payment Checkout

## Status

**APPROVED. Phase 2C-a CLOSED 2026-09-21. Phase 2C-b in progress.**

Author: Principal Architect / Tech Lead
Date: 2026-09-21
Predecessor: Stage 2B, accepted and closed at `34bc303`

| Gate | State |
|---|---|
| D19, D20, D21 | Approved 2026-09-21 (§4) |
| D22 | Approved 2026-09-21 (§13) — **unblocks 2C-b** |
| Architecture review | Approve with conditions (§12) |
| C2C-1 … C2C-4 | Closed as criteria 97–106 (§14) |
| `write_draft_orders` | Requested; OAuth re-consent pending |
| Email channel | **Not configured — blocks 2C-b** |
| Customer-facing copy | **Not approved — blocks 2C-c** |

**Criteria 80 and 81 in §5.2 are SUPERSEDED by §13.** They are struck through
in place rather than deleted, so the change stays legible; implement §13's
versions.

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

---

## 15. Architecture follow-ups raised by 2C-a

These are recorded here because they were discovered while building 2C-a, but
each belongs to a later slice. None blocks 2C.

### F-2C-1 — one source of truth for "is this variant sold through an open Group Buy?"

**Owner-directed follow-up, 2026-09-21. Due with Slice 6.**

Two places in the system now answer the same question, independently:

| Asker | Why it asks | Where it looks today |
|---|---|---|
| The pricing engine | An open campaign's pricing is **frozen** (`CLAUDE.md` #7), so recalculation must skip the variant | `OpenCampaignExclusionSource` (`app/jobs/pricing/ports.ts`) — currently a **no-op**; Slice 6 implements it |
| Bank Payment Checkout | A Buy Now cart and a Group Buy cart may never produce one order (criterion 76) | a direct `group_buy_campaign_variant` query scoped to `campaign.status = open`, inside `apps.carat.bank-checkout.tsx` |

They agree **right now** only because 2C-a was corrected to match the engine's
boundary. It first shipped asking "has this variant **ever** been in a
campaign", which would have refused checkout for variants in `draft`, `closed`
and `cancelled` campaigns — variants the engine keeps pricing, Shopify keeps
publishing and the storefront keeps advertising. The customer would have
reached the address form before being told no.

**The requirement: when Slice 6 implements the real `OpenCampaignExclusionSource`,
the checkout query must be deleted and replaced by a call to it.** Not
"kept in sync" — collapsed into one implementation, so there is no second
answer to drift.

Two divergent answers is not a tidiness problem. The engine skipping a variant
that checkout still sells means selling at a stale frozen price; checkout
refusing a variant the engine still prices means losing a sale that is
advertised as available. Both are silent, and both look like someone else's bug.

### F-2C-2 — `shopify.server` is eagerly bundled, so the deferral comments overstate what they achieve

`productionPriceSyncPort.server.ts` and `internal.jobs.price-recalculation.tsx`
both dynamically import `~/shopify.server` so the pricing cron can boot without
Shopify OAuth configured. It cannot: `app/entry.server.tsx` imports the module
**statically** and is loaded on every cold start, so the bundler keeps it in the
main chunk regardless. The build says so explicitly.

The dynamic import still usefully defers `requireShopifyConfig()`'s *throw* to
the moment auto-publish is used. It just cannot deliver the bootability the
comments claim. Corrected in the comment at `productionPriceSyncPort.server.ts`
rather than fixed, because the fix is to `entry.server.tsx` and has its own
blast radius. **Out of scope for 2C by owner direction unless it blocks
deployment.**

### F-2C-3 — the manual payment gateway is not yet named at completion

`draftOrderComplete` in 2026-07 takes `(id, paymentGatewayId, sourceName)`.
2C-a completes with the id alone, which leaves the order **unpaid** — verified
live as `displayFinancialStatus: PENDING` — and that is what §22 requires.

Naming a specific manual gateway belongs with the verification surface
(**2C-c**), where an admin records which method the money actually arrived by.
Attaching gateway metadata at creation would assert a payment nobody has
verified.

---

## 16. Phase 2C-a — closed 2026-09-21

Closed on live evidence against `caratforus-dev`, not on a green unit suite.
The reproducible harnesses are `app/tests/live/slice2cA.livegate.ts` (26 checks)
and `app/tests/live/slice2cA.completion.ts` (14 checks).

### What is proven

| Criterion | Proven by |
|---|---|
| 71, 72 — line prices are the recomputed Bank Payment Price | draft read back from Shopify at `1234.56` against a `1300.00` catalogue price |
| 73 — `reserveInventoryUntil` never sent | asserted on the serialised payload |
| 74 — resource route, no default export | `csrfResourceRouteFence.test.ts` |
| 75, 105, 106 — idempotent creation | replay returned the same draft, `invoiceSentAt` unchanged |
| 76 — Group Buy separation | all four campaign states exercised live: open blocks, draft/closed/cancelled do not |
| 77 — quote and guarantee stored | 24h window asserted |
| 87, 89 — verified completion through to a real order | `#1003`, exact gid persisted |
| 95, D19 — explicit zero shipping line | present at zero on the live draft |
| 97-99 — no duplicated PII | address at Shopify, absent from every column and every quote line |

### What the live gate found that no unit test could

Three of the adapter's assumed API shapes were wrong, and **a mocked client
agrees with every assumption you hand it**. Two were silent:

1. **`originalUnitPrice` does not exist** on `DraftOrderLineItemInput` in
   2026-07. Shopify dropped the field and priced the line at the variant's
   **catalogue price**. Caught only by the echo check. The correct field is
   `priceOverride`.
2. **Completion marked the order PAID.** Against a transfer that had not
   arrived and that Shopify had never processed. Fixed with Due-on-receipt
   payment terms; the order is now `PENDING`.
3. `draftOrderInvoiceSend` takes `EmailInput`, and `draftOrderComplete` has no
   `paymentPending` argument. Both rejected outright — loud, not silent.

**The standing lesson, and it outlives 2C:** a fixture that echoes its input
can only confirm what you already believe. Any adapter that writes a
customer-facing price must be proven against the real API before it is
trusted, and must verify the echo rather than assume it.

### Scopes as granted

`read_products, write_products, read_inventory, write_draft_orders,
read_orders, write_payment_terms`. `read_orders` captures the order id;
`write_payment_terms` is what keeps the order unpaid. Neither is customer PII.
Deliberately **not** granted: `write_orders`, `read_all_orders`,
`read_customers`, any protected name/email/phone/address field, `write_inventory`.

Operational note: `shopify app dev` re-pushes its own app configuration over a
deploy made while it is running. Deploy with it stopped.

### Left on the dev store

Three test orders (`#1001`, `#1002` PAID from before the payment-terms fix;
`#1003` PENDING) cannot be removed without `write_orders` and are for the owner
to delete by hand. Products and draft orders are at zero. Database fixtures are
archived; their quote lines and price calculations are append-only and remain.

`#1001` is worth remembering: it was created by the run reported as *blocked*.
`draftOrderComplete` had in fact succeeded and only the `order { id }` read was
denied — the same write-succeeded-read-failed shape as the orphaned draft, one
level up.

---

## 17. Phase 2C-b — the guarantee sweep

### 17.1 D22 notification behaviour — OWNER APPROVED 2026-09-21

**The cancellation is authoritative even when the email fails.** Protecting us
from honouring a withdrawn price must not be contingent on our mail server
being reachable.

**A notification failure is recorded separately and escalated to admin for
manual contact.** An undelivered cancellation is a real duty left undischarged,
not a rounding error. "Cancelled" and "told them" are two facts and the data
must never let them look like one.

**107.** A cancellation persists regardless of the email outcome.

**108.** The delivery outcome is recorded distinctly from the cancellation, and
a failed send raises an admin alert explicit enough that someone contacts the
customer by hand.

### 17.2 The human-approval test stays historical — OWNER CONFIRMED

**109.** The check asks whether **any** human-approved publication occurred
between `quotedAt` and now. It must **not** be reduced to inspecting how the
latest publication happened.

The reduction is tempting and fails silently in the customer's favour: a human
approves a 6% rise, gold drifts 0.3% overnight and auto-publishes on top, the
most recent publication is now automatic, and the order survives a repricing a
human explicitly approved. A test must cover that exact ordering —
human approval, then an automatic publication on top — and assert the order
**is** cancelled.

### 17.3 Cancellation requires BOTH halves

**110.** Cancel only when the published price **differs** from the quoted price
**and** that difference arrived through a human-approved publication.

Either half alone is wrong. Without the price comparison, a human re-approving
the same price cancels an order for nothing. Without the human-approval test,
ordinary overnight metal drift cancels nearly every unpaid bank order, which is
the outcome D22 exists to prevent.

### 17.4 Shippability gate — OWNER-SET, NOT NEGOTIABLE BY THE IMPLEMENTER

**111. 2C-b is NOT shippable until all three hold:**

1. `EMAIL_API_KEY`, `EMAIL_FROM` and `STAFF_EMAIL_ALLOWLIST` are configured;
2. a **real cancellation email is proven end to end**, not mocked, not
   `skipped_unconfigured`;
3. ~~the owner has approved the cancellation email's customer-facing copy~~ —
   **SATISFIED 2026-09-22.** The approved text is pinned character-for-character
   in `app/app/domain/bankpayment/guaranteeCancellationEmail.ts` and asserted by
   its test.

Code landing and passing its tests does **not** close 2C-b. The cancellation
email is locked customer-facing behaviour, and a sweep that silently cancels
orders without telling anyone is worse than no sweep at all — it would look
like it was working.

---

## 18. Phase 2C-b — closed 2026-09-22

Closed on live evidence against `caratforus-dev` and a real Resend send, not on
a green suite. Harnesses: `app/tests/live/slice2cB.cancellationEmail.ts` (13
checks) and `app/tests/live/slice2cB.firstName.ts` (5 checks).

### Criterion 111, item by item

| Gate | Evidence |
|---|---|
| Email channel configured | Resend, `CaratForUs <orders@caratforus.com>`, staff `orders@caratforus.com` |
| A real cancellation email proven end to end | Resend accepted it; provider message id `01a0c78c-5594-73be-9731-3aa73b01e75b` persisted to `cancellation_email_provider_message_id` |
| Owner approval of the copy | Approved 2026-09-22; pinned character-for-character, curly apostrophes and the US spelling "canceled" included |

### The owner's seven verification items

1. **Cancellation happens** — one order cancelled, reason naming the variant and both prices.
2. **Resend accepts the email** — status persisted as `sent`.
3. **Provider message id recorded** — persisted, and byte-identical after a re-run.
4. **The customer receives the approved copy** — the exact body printed by the harness; the greeting is proven separately, below.
5. **A failed delivery does not reverse the cancellation** — a recipient **Resend itself rejected**: order still `cancelled`, status `failed`, and no message id falsely claimed.
6. **Failure creates a persistent record** — queryable as `status = cancelled AND cancellation_email_status <> 'sent'`, not a log line.
7. **Retry does not duplicate** — the re-run considered **zero** open orders; nothing re-cancelled, nothing re-sent.

### The first name cost a design decision

The approved copy greets the customer by name, and criterion 97 deliberately
does **not** store one — the shipping address stays at Shopify. So the name is
read from the draft order at send time (criterion 99), **best-effort**: a
deleted draft, an API failure or an order with no first name falls back to
`Hi there,`. Holding a cancellation until Shopify answers would make a
withdrawn price contingent on an unrelated outage, and storing the name would
re-duplicate exactly the PII criterion 98 argued down to one field.

**`Hi there,` was approved on 2026-09-22** alongside the dynamic form, and is
pinned as a literal in its own right. The owner also ruled the mechanism: the
first name is never persisted for personalisation, and a failure to retrieve it
must neither delay nor reverse a cancellation.

The main gate could only prove the fallback, because its fixtures carry
synthetic draft-order gids. `slice2cB.firstName.ts` closes that hole against a
**real** draft order created through the real checkout route, and reads back
`Hi Ada,`.

### Two test defects the real configuration exposed

Configuring Resend turned four integration tests red — tests asserting the
honest `skipped_unconfigured` path that were passing only because the
developer's machine happened to have no email credentials. They were **sending
real email** during the suite.

The fix assigns empty strings in `tests/integration/setupEnv.ts` rather than
deleting the variables: a delete is undone the next time anything pulls in
`dotenv`, which is why the first attempt left the suite still sending. `dotenv`
never overwrites an existing key, so an empty string survives, and
`resolveEmailPort` treats empty exactly as missing.

This is the second time an operational setting has broken tests asserting a
default — `PRICE_AUTO_PUBLISH_ENABLED` was the first. Both now live in the
harness.

### F-2C-5 — the verifying admin is typed, not authenticated

`bank_payment_order.verified_by` is a **required typed string**, not an
identity. The app uses **offline** session tokens, so `authenticate.admin()`
yields a shop, not a person. The authenticated half — `session.shop` — is
recorded as `actorRef` on every audit event the verification writes, but
nothing proves *which* staff member typed the name.

For a launch-minimum manual workflow with a handful of trusted staff that is
acceptable, and the surface says so in plain words on the form itself rather
than implying an authenticated trail it does not have.

**Real per-user attribution needs online session tokens.** That is a change to
how the app authenticates, not to this screen, and it belongs with whichever
slice first needs to distinguish one staff member from another — a dispute over
who approved what being the obvious trigger.

---

## 19. Phase 2C-c, revised — owner clarifications 2026-09-22

The surface built at `cfdcdba` conflicts with three of these. This section is
the spec and architecture review for the revision.

### 19.1 D23 — the verifier is an authenticated identity, not a typed name

**OWNER RULING.** `verified_by` must come from the authenticated admin, not a
text field. F-2C-5 is therefore no longer a follow-up; it is the requirement.

**This is achievable and, importantly, additive.** Setting `useOnlineTokens:
true` makes token exchange request an online token **in addition to** the
offline one — verified in the installed library source
(`…/strategies/token-exchange.js`: the offline session is exchanged and stored
first, then the online session when the flag is set). The offline session the
guarantee sweep and the recalculation cron depend on through
`unauthenticated.admin` is untouched. Nothing background-facing changes.

`OnlineAccessUser` carries `id`, `email`, `first_name`, `last_name` and
`account_owner`, so the record can name a person rather than a shop.

**112.** `useOnlineTokens: true`, and the offline session must still be present
after an embedded request — asserted, because the whole background half of this
app depends on it.

**113.** Verification records the authenticated Shopify staff **user id** and
**email**. The free-text name field is removed from the form entirely: a field
that cannot be trusted is worse than no field, because it looks like evidence.

**114.** A request that somehow carries no associated user is **refused**, not
defaulted. An unattributable verification is not a verification.

### 19.2 D24 — a mismatched amount refuses, and refuses BEFORE recording

**OWNER RULING.** Do not complete the Shopify order when the amount received
differs from the expected Bank Payment amount. Show the mismatch; require
manual resolution. Invent no partial-payment, overpayment, credit or adjustment
behaviour.

**115.** The action compares received against expected and, on any difference,
**refuses before persisting anything**. Not "records the verification but skips
completion" — that would strand the order in the verified-but-incomplete state
D25 exists to recover, and would make a simple typo unrecoverable through the
idempotency guard.

**116.** The refusal states both figures and the difference, and says plainly
that resolution is manual. No remedy path is offered, because none is decided.

**117.** The attempt is written to the audit trail — someone tried, and was
refused. That uses the existing evidence pattern without inventing remedy
behaviour.

### 19.3 D25 — completion failing after evidence is recorded

**OWNER RULING.** Never let staff simply verify again. Preserve the state and
make recovery explicit, so we cannot create or complete an order twice.

**118.** When verification persists but `completeBankPaymentOrder` fails, the
order holds a distinct **verified, not completed** state. The verification form
does not reappear.

**119.** Recovery is its own explicit action — *retry completion* — never a
second verification. The evidence already recorded is never rewritten.

**120. THE DANGEROUS CASE, AND THE REASON THIS IS NOT A SIMPLE RETRY.**
`draftOrderComplete` may have **succeeded at Shopify** while our write of the
resulting order id failed. Retrying blind would complete the draft twice and
create a second real order against one payment. So recovery must first ask
Shopify whether the draft already became an order — `draftOrder { order { id } }`
— and **adopt** that id if so, completing only when Shopify confirms it never
did. 2C-a's live gate found exactly this shape once already: a
`draftOrderComplete` that succeeded while the read of its result was denied,
leaving order `#1001` that we never recorded.

### 19.4 The rest of the clarifications

**121.** The verification timestamp is system-generated. It already is; no form
field accepts one, and none may be added.

**122.** The payment reference stays optional — some bank methods carry no
useful reference (§8.7's "where available").

**123.** Before submitting, the surface states the consequence and shows the
expected amount, the amount received, the method, the reference where
available, and the order reference. The action is labelled **"Verify Payment &
Complete Order"** so the consequence is legible before the click, not after.

**124.** After success the completed state replaces the form. A form left
active after a completed order invites the second submission every other rule
here exists to prevent.

### 19.5 Architecture review

**Boundary unchanged.** Shopify still owns the order, the draft and the
gateway. We add an authenticated identity to an existing record and a recovery
path to an existing failure.

**One real risk, and it is D25's.** Everything else is a field change or a
refusal. The retry-completion path is the only new way to create a duplicate
real order, which is why criterion 120 makes it a read-before-write rather
than a retry.

**Online tokens are the only cross-cutting change.** Additive, as established
above, but it touches authentication for every embedded request — so criterion
112 asserts the offline session survives rather than assuming it.

**VERDICT: APPROVE.** No unresolved owner decision, no new infrastructure, and
the one risky path is specified as read-before-write.
