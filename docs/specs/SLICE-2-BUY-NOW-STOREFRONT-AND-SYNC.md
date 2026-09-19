# Slice 2 — Buy Now storefront, real Shopify price sync, and Bank Payment checkout

## Status

**DRAFT — awaiting owner approval. No implementation has begun.**

Author: Principal Architect / Tech Lead
Date: 2026-09-19
Predecessor: `docs/specs/SLICE-1-PRICING.md` (accepted at T11, HEAD `b709aa0`)

---

## 1. Outcome

A customer can browse the CaratForUs storefront, see a truthful "As low as"
price on collection and search cards, open a product page showing the
Regular/Card Price, the Bank Payment Price and the exact dollar saving, add the
item to a cart in either payment mode, and complete the purchase — by card
through native Shopify checkout at the Regular/Card Price, or by bank through an
invoiced Bank Payment order at the Bank Payment Price. Behind that, prices
computed by the Slice 1 engine actually reach Shopify: an approved price sync
intent drives a real `productVariantsBulkUpdate`, moves `approved → syncing →
synced`, and writes back the compare-and-set anchor, with small changes
publishing automatically once the path has proven itself and larger ones waiting
for a named human. When a sync fails, the last good price stays live, staff are
told in two channels, and only the single affected variant is withdrawn — and
only after 48 hours.

Slice 1 computed correct prices that reached nobody. Slice 2 is the slice where
the pricing engine stops being a private calculation and becomes the storefront.

---

## 2. Authoritative requirements

Every rule below is traced to a controlling document. Nothing in this spec is
invented; where a rule needed an engineering definition, §13 says so explicitly.

| Area | Controlling source |
|---|---|
| Bank Payment vs Regular/Card price, tiers, $5 ceiling, savings, terminology | `docs/BANK-CARD-PRICING.md` (LOCKED 2026-09-18) |
| Slice 2 sync, approval, recalculation triggers, sync failure, PDP/collection display, cart modes, bank orders | `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` (LOCKED 2026-09-19) |
| Platform capability findings for bank payment at checkout | `docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md` — **Phase 2 is un-deferred by the above; see §9.3 there** |
| Contracts C-S1…C-S6, findings F-5…F-29 | `docs/specs/SLICE-0-FINDINGS.md` |
| Framework pin, hybrid library boundary, CSRF origin guard (R-1), scopes | `docs/ARCHITECTURE-MVP1.md` §2.1, §5, §10 |
| Pricing engine, rule registries, frozen-rule discipline | `docs/specs/SLICE-1-PRICING.md` |
| Buy Now purchase path, recalculation cadence, master product model | `README.md` |
| Engineering principles, money safety, delegation, git discipline | `CLAUDE.md` |

**Superseded text that must not be implemented:** `docs/CASH-CARD-PRICING.md`
(entirely); contract **C-S6** in its original "both prices on every surface"
wording (amended — `SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` §9.2);
`BANK-PAYMENT-CHECKOUT-FINDINGS.md` §3 "Phase 1 — display only … this is the
whole of MVP1" (un-deferred by owner decision).

---

## 3. Proposed scope

Slice 2 is large because the owner's decision set spans three previously
separate concerns. I am **not** proposing to trim it, but I am proposing to
**sequence it in three stages with a gate between each**, because stage 1 is a
precondition of the owner's own auto-publish rule.

### Stage 2A — Real price sync (backend, no customer-visible change)

The `ShopifyPriceSyncPort` adapter, the `approved → syncing → synced` lifecycle,
the compare-and-set write-back, immediate recalculation on input change, the
approval/rejection/override workflow, and sync-failure handling. Auto-publish
remains **off**.

### Stage 2B — Storefront (customer-visible, card only)

Collection/search "As low as", the Buy Now PDP with both prices and both
add-to-cart buttons, cart payment-mode switching and repricing, Card Checkout
through native Shopify checkout. Bank Payment Checkout button present but
routing to stage 2C's flow.

### Stage 2C — Bank Payment orders

Draft-order creation at Bank Payment prices, invoicing, the 24-hour guarantee
sweep, manual admin payment verification, and the not-committed disclosures.

**Gate between 2A and auto-publish.** Owner decision §1.5 states that ≤2%
changes may auto-publish *only after the real sync path passes money-critical
integration tests*. That is implemented literally: auto-publish is a separate
enablement (`PRICE_AUTO_PUBLISH_ENABLED`, default **off**), and turning it on is
a deliberate act after the §11 money-critical suite is green against a real
development store. This also closes the outstanding **D14-followup item (4)**
recorded in `ARCHITECTURE-MVP1.md` §12, which asked for exactly this split.

### Explicitly in scope, carried from the register

F-26, F-27, F-28 (slice 2 gate items); C-S2 with its two notes; C-S6 as amended;
F-23 (`allowedActionOrigins`) and F-24 (route typegen) before the first App
Proxy POST form ships; F-7 (split migration/runtime DB roles) as a deploy task.

---

## 4. Acceptance criteria

Numbered for review sign-off. Each is written so a test can fail it.

### 4.1 Price sync (owner §1)

1. `ShopifyPriceSyncAdapter` implements `ShopifyPriceSyncPort` over
   `productVariantsBulkUpdate` and is the only module in the app that publishes
   a price to Shopify.
2. The published amount is the **final rounded Regular/Card Price** — the figure
   after the $5 ceiling, never the preliminary uplift, never the Bank Payment
   Price.
3. The card price is derived as
   `deriveRegularCardPrice(calc.bankPaymentPriceMinorUnits, calc.pricingProfile.fixedCardUpliftRate, calc.pricingProfile.regularCardPriceRuleId)`
   — from **the calculation's own profile**. A test pins this by publishing a
   historical calculation whose profile carries the legacy
   `CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1` rule while the active profile carries the
   tiered rule, and asserting the legacy figure is published.
4. No JavaScript `number` appears anywhere between `Money` and the GraphQL
   variable. The money-safety scan covers the adapter directory.
5. A successful sync moves the intent `approved → syncing → synced` and writes
   `master_variant.lastSyncedPriceCalculationId` **in the same transaction** as
   the status change to `synced`.
6. The sync executes only if the intent's `priceCalculationId` is still the
   newest computed calculation for that variant (compare-and-set). If a newer
   calculation exists, the intent becomes `superseded` and **no Shopify call is
   made**.
7. `isPlaceholderProfile` is re-checked **immediately before** the Admin API
   call, not merely at intent creation. A placeholder-profile price is never
   published.
8. Auto-publish is gated on `PRICE_AUTO_PUBLISH_ENABLED`, default **off**. With
   it off, an `auto_apply` decision still yields `approved` and stops there.
9. With auto-publish on, a change of **≤200 bps** in Bank Payment Price
   publishes without human action; **>200 bps** requires admin approval. The
   measurement is bank-to-bank (owner §11: inverted card moves at a tier
   boundary are accepted behaviour and require no additional guard).
10. Re-running the sync for an already-`synced` intent is a no-op and makes no
    second Admin API call.

### 4.2 Admin approval workflow (owner §2)

11. Intents are groupable by the **pricing input change** that caused them, and
    a single bulk-approve action approves every intent in one such group.
12. **There is no bulk reject** — no route, no button, no CLI verb. A test
    asserts the absence of a bulk-reject surface.
13. Per-item rejection **requires both an override price and a reason**; a
    rejection missing either is refused before any write.
14. A rejection writes a `price_override` row (kind `set`) carrying the override
    Bank Payment Price, the reason, the actor, the breached floors and the exact
    warning text shown, and moves the intent to `rejected`.
15. An override expires on the next **material** recalculation — defined in §13.1
    — unless `neverExpire` is set. Expiry appends a `price_override` row of kind
    `expired`; the table stays append-only.
16. A `neverExpire` override survives any number of material recalculations and
    is only removed by an explicit human revoke.

### 4.3 Recalculation triggers (owner §3)

17. Any persisted change to a price-affecting input writes a
    `pricing_input_change` row and **immediately** enqueues a recalculation for
    every variant that input affects.
18. The daily scheduled recalculation (D15) continues unchanged and is
    distinguishable from an input-triggered run by `trigger`.
19. A recalculation triggered by an input change records which input changed, so
    the resulting intents can be bulk-approved as one group (criterion 11).

### 4.4 Sync failure handling (owner §4)

20. A failed sync **never** changes the price live on Shopify. The last
    published price stays exactly as it was.
21. Failures retry automatically on a bounded backoff; each attempt is recorded
    with its error.
22. The first failure raises **both** an email alert and a persistent admin
    alert. The admin alert does not auto-clear; it clears only when the sync
    succeeds or a human dismisses it with a reason.
23. A 48-hour timer starts at the **first** failure for that variant, not at the
    latest retry.
24. At 48 hours unresolved, **only the affected variant** becomes unavailable.
    No other variant, no other product, no collection.
25. When a later sync succeeds, availability is **restored automatically** with
    no human action.
26. Throughout the unresolved window the customer may still purchase at the
    currently published price, and doing so is not an error condition.
27. A price publishing lower afterwards creates **no** retroactive refund
    obligation and no refund record.

### 4.5 Collection and search (owner §5)

28. A product card shows **"As low as $X"** where X is the lowest **currently
    purchasable** Bank Payment Price across that product's variants.
29. "Currently purchasable" excludes variants that are out of stock, `draft`,
    unsynced, or suspended under criterion 24. A variant nobody can buy never
    sets the headline price.
30. The Regular/Card Price is **not** shown on collection or search cards.
31. If no variant is currently purchasable, the card shows the product's
    unavailable state — never a stale or fabricated "As low as".

### 4.6 Buy Now product page (owner §6)

32. The PDP shows the Regular/Card Price, the Bank Payment Price and the exact
    dollar saving (final rounded card − bank), for the selected variant.
33. Two actions are present: **Add to Cart** and **Add to Cart with Bank Payment
    Discount**.
34. **Add to Cart with Bank Payment Discount** switches the whole cart to bank
    mode and reprices every eligible line.
35. Plain **Add to Cart** leaves the cart's existing mode untouched — it does
    not silently switch a bank-mode cart back to card.
36. A cart has exactly one payment mode. No cart state exists in which some
    lines are in card mode and others in bank mode.
37. No customer-facing surface displays the internal percentage, or the words
    "cash", "cash discount", "card fee", "credit card fee" or "surcharge".
    Asserted character-for-character against the theme source.

### 4.7 Cart and checkout (owner §7)

38. The cart offers **Card Checkout** and **Bank Payment Checkout**.
39. Bank Payment is always offered — there is no product, cart or customer state
    that removes it.
40. `bankPaymentDiscountEligible` exists per variant, defaults **ON**, and is
    the system of record in Postgres.
41. An ineligible line stays at the Regular/Card Price in a bank-mode cart, and
    the cart shows that line's price truthfully rather than implying a saving it
    will not receive.
42. A cart may not contain both Buy Now and Group Buy lines; the attempt is
    refused at add-to-cart and again server-side.
43. Line prices used to create a Bank Payment order are recomputed
    **server-side** from our own published price data. A tampered cart attribute
    or line property can change **which mode** is requested, never **what a line
    costs**.

### 4.8 Bank Payment orders (owner §8)

44. A Bank Payment order quotes prices guaranteed for **24 hours** from
    creation, and the quoted figures are stored per line.
45. After 24 hours, unpaid, prices unchanged → the order stays open.
46. After 24 hours, unpaid, **any** line's price changed by **any** amount →
    the order is cancelled and the customer emailed. No tolerance band.
47. **No inventory is reserved.** `reserveInventoryUntil` is never sent.
48. Checkout **and** the confirmation email state that the order is not
    committed and availability is not guaranteed until payment is received and
    verified.
49. Payment verification is a manual admin action recording **amount, method,
    reference where available, timestamp and verifying admin**.
50. Verification is idempotent: a double-submit records one verification and
    completes one order.
51. Completing a verified bank order converts the draft to a real Shopify order
    through a manual payment gateway; the app never handles card data.

---

## 5. Native Shopify vs custom boundary

| Capability | Owner | Note |
|---|---|---|
| Product/variant catalogue, media, variant price storage | **Shopify** | The published variant price is the Regular/Card Price |
| Card cart and card checkout, payments, taxes, order creation | **Shopify** | Entirely native, unmodified |
| Inventory and sold-out behaviour | **Shopify** | |
| Order confirmation and shipping email | **Shopify** | Bank-payment disclosure text added to the template |
| Draft order, invoice delivery, draft→order conversion | **Shopify Admin API**, orchestrated by the app | `draftOrderCreate`, `draftOrderInvoiceSend`, `draftOrderComplete` |
| Manual payment gateway | **Shopify** | Standard manual payment method; app never touches funds |
| Collection/PDP/cart presentation | **Theme (custom Liquid + vanilla JS)** | |
| Bank/card price computation and derivation | **Custom** (Slice 1 engine, unchanged) | |
| Price sync decision, approval, override, failure state | **Custom** | |
| Payment-mode cart state and server-side repricing | **Custom** | Cart attribute selects mode; app owns prices |
| "As low as" aggregate per product | **Custom** compute → **Shopify metafield** read cache | Money never reconciled from a metafield |
| Bank order quote, 24h guarantee, payment verification | **Custom** | |

### 5.1 Why Bank Payment Checkout is a draft order

Verified against current Shopify documentation, 2026-09-19:

- **Shopify cannot vary the payable total at payment-method selection.** The
  Payment Customization Function API can only hide, reorder, rename and set
  terms; customizing card fields at all requires **Plus**, and this store is
  planned for Basic/Grow. Discount Functions run before payment selection and
  receive no payment-method input.
- **A draft order can carry any total** via `originalUnitPrice` per line, be
  invoiced with `draftOrderInvoiceSend`, and be completed with
  `draftOrderComplete` against a manual gateway.
- **A draft order does not reserve inventory** unless `reserveInventoryUntil` is
  supplied. Omitting it satisfies owner §8.4 exactly, rather than by accident.

The draft-order flow is therefore not a workaround; it is the only native
mechanism that charges a genuinely different amount for a bank payment, and its
default behaviour matches three separate owner requirements (no reservation,
manual verification, order not committed until verified).

**Fail-safe direction.** If a bank-mode customer bypasses the theme and reaches
native checkout, they are charged the **Regular/Card Price** — the higher, fully
correct card figure. The failure mode of every bypass is an overcharge-free
correct card sale, never an undercharged bank sale.

### 5.2 Residual gap, stated rather than papered over

Criterion 24's per-variant withdrawal has no perfect native mechanism. Shopify
cannot unpublish a single variant, and forcing unavailability through inventory
would corrupt real stock data — which `docs/LUXURY-STEALS.md` depends on.

Proposed layered enforcement, mirroring `ARCHITECTURE-MVP1.md` §6.3:

1. the theme disables the variant from a metafield flag;
2. the app refuses a Bank Payment order containing it;
3. `orders/create` flags a card order containing a suspended variant for staff
   review rather than silently fulfilling it.

**Severity is genuinely low and bounded:** a customer who slips through pays the
last published price, which is the same price owner §4.7 explicitly permits them
to pay at 47 hours. A hard pre-checkout block needs a Cart Validation Function
(Plus). Recorded as **D16** in §13 rather than presented as solved.

---

## 6. Data model and migrations

Seven migrations, forward-only, each independently reversible by restore-plus-
forward-fix per `ARCHITECTURE-MVP1.md` §7.

| # | Change | Why |
|---|---|---|
| M1 | `master_variant.bank_payment_discount_eligible BOOLEAN NOT NULL DEFAULT true` | Owner §7.3, default ON |
| M2 | `price_override.never_expire BOOLEAN NOT NULL DEFAULT false`; new `PriceOverrideKind` value `expired` | Owner §2.4; append-only expiry |
| M3 | New `pricing_input_change` — id, kind, entity ref, changed_by, changed_at, note | Owner §3.1 trigger record **and** the criterion-11 bulk-approval grouping key |
| M4 | `price_recalculation_run.pricing_input_change_id` nullable FK; new `PriceRecalculationTrigger` value `input_change` | Owner §3.1/§3.3 |
| M5 | New `price_sync_failure` — master_variant_id, first_failed_at, last_attempt_at, attempt_count, last_error, alert_state, suspended_at, resolved_at | Owner §4; the 48h timer anchors on `first_failed_at` (criterion 23), which is why this is not a column on the intent |
| M6 | New `bank_payment_order` + `bank_payment_order_line` — draft order GID, quoted bank/card price per line, eligibility at quote time, quoted_at, guarantee_expires_at, status, and the verification block (amount, method, reference, verified_at, verified_by) | Owner §8 |
| M7 | Append-only triggers extended to `pricing_input_change` and `bank_payment_order_line` quote columns | Consistency with the Slice 0 evidence discipline |

**Not stored, deliberately:** the Regular/Card Price. It stays a pure function of
the stored Bank Payment Price and the calculation's own rule (C-S2 note 2).
Storing it would create a second source of truth that can disagree.

**Shopify metafields written (presentation cache only):** product-level
`carat.as_low_as_bank_minor_units`, variant-level
`carat.bank_payment_price_minor_units`, `carat.bank_payment_eligible`,
`carat.sync_suspended`. Per `ARCHITECTURE-MVP1.md` §5, money is never reconciled
from a metafield — these exist so the theme can render without an App Proxy
round trip on every card.

### 6.1 Scopes

Add **`write_draft_orders`** and **`read_draft_orders`**. Add `write_orders` /
`read_orders` only if criterion 51's completion path or §5.2 item 3 requires it
at implementation time — not speculatively. Current grant is
`read_products,write_products`. Scope changes re-prompt on the development
store, which is expected and harmless.

---

## 7. Evidence and audit

- Every sync attempt writes an `audit_event`: actor (or `system`), variant,
  intent, previous and published price, rule id, profile version, outcome.
- Every approval, bulk approval, rejection, override, override expiry and
  override revoke writes an `audit_event` with the actor named. A bulk approval
  records the group key and the full member list, so "approved 40 items" is
  reconstructible item by item.
- Every bank-order quote stores the prices quoted, the rule and profile that
  produced them, and the guarantee expiry — so a dispute six months later can
  reproduce exactly what the customer was shown.
- Payment verification is an append-only evidence record (amount, method,
  reference, timestamp, admin). It is never edited; a correction is a new row.
- The not-committed disclosure is a versioned `policy_version` with an
  `acknowledgment` captured at bank-order placement — this is a material term
  under `CLAUDE.md` and must not be inferred from proceeding.

---

## 8. Security, privacy, access control

- All App Proxy requests signature-verified (`app/shopify/proxy/verify.ts`);
  body-supplied identity is never trusted — F-18 applies directly here.
- **F-23 must be closed before the first App Proxy POST ships.** The bank
  checkout request is exactly the form R-1 predicts will 400 silently. Either
  keep it a resource route or set `allowedActionOrigins`.
- No cost, margin, supplier, breakdown, uplift rate, tier label or rule id
  appears in any App Proxy JSON, Liquid, metafield or log (C-S5, R14).
- Admin approval, override, suspension-dismissal and payment verification are
  staff-only behind the embedded admin session, never App Proxy.
- Payment references are minimised: store the reference string the admin enters
  and nothing else. No bank account numbers, no routing numbers, no card data.
- Server-side revalidation of every line price at bank-order creation
  (criterion 43) is the single most important control in this slice.

---

## 9. Accessibility and customer-facing error states

- The two add-to-cart buttons must be distinguishable by text alone, not colour;
  the bank button's accessible name states what it does to the whole cart.
- Switching cart mode announces the change via a live region — the price of
  every line changing without announcement is a serious screen-reader failure.
- Price pairs are marked up so the saving reads as one statement, not three
  loose numbers.
- Error states needing real copy (not invented here — see D17): sync suspended /
  variant unavailable; bank order expired and cancelled; bank order awaiting
  verification; a line that is not bank-eligible; mixed Buy Now / Group Buy cart
  refused.

---

## 10. Non-goals

Group Buy core (slice 6) and Group Buy close/refunds (slice 8) — only the shared
cart/payment infrastructure in owner §10 is built here. Luxury Steals (slice 3).
RMA (slice 4). Warranty (slice 5). Automated metal price feed (post-launch).
Customer self-serve payment proof upload (email/manual is explicitly accepted
for MVP1). Cart Validation Function (Plus, D16). Store credit (D5).
Multi-currency. Localisation of theme copy.

---

## 11. Test plan

**Money-critical integration suite — this is the gate for auto-publish (§3).**

1. Approved intent → real `productVariantsBulkUpdate` against a mocked Admin
   API → `synced` + `lastSyncedPriceCalculationId` written, one call only.
2. The same intent replayed → no second call, no second write.
3. A newer calculation exists → `superseded`, **zero** Admin API calls.
4. Placeholder profile detected immediately before the call → refused.
5. A historical calculation on the legacy card rule publishes the **legacy**
   figure while the active profile carries the tiered rule.
6. Published figure equals the $5-ceilinged card price, asserted at all five
   tier boundaries and at an exact-multiple-of-$5 case.
7. Admin API error → price on Shopify unchanged, intent `failed`, failure row
   created, both alerts raised, timer anchored at first failure.
8. Retry succeeds at hour 47 → suspension never applied, alert cleared.
9. Unresolved at hour 48 → only that variant suspended; a sibling variant of the
   same product stays purchasable.
10. Later success → availability auto-restored with no human action.
11. Auto-publish disabled → a 50 bps change reaches `approved` and stops.
12. Auto-publish enabled → 200 bps publishes, 201 bps queues.

**Tamper and persistence tests (owner: "tamper, persistence, cart-to-checkout").**

13. Cart attribute forged to bank mode on an ineligible line → line quoted at
    the Regular/Card Price.
14. Line property forging a price → ignored; server price used.
15. Quantity or variant swapped between cart read and bank-order creation →
    refused, nothing created.
16. Mixed Buy Now / Group Buy cart → refused server-side even when the theme
    guard is bypassed.
17. Cart mode survives a page reload and a variant change on the PDP.

**Bank order lifecycle.**

18. Quote stored per line with the rule and profile that produced it.
19. Unpaid at 24h, price unchanged → still open.
20. Unpaid at 24h, one line changed by one cent → cancelled + email.
21. Paid before 24h → guarantee irrelevant, order completes.
22. Double verification submit → one verification, one order.
23. `reserveInventoryUntil` is never present in any `draftOrderCreate` payload —
    asserted on the serialised request, not on intent.

**Unit.** Card-price derivation from a historical profile; "as low as" selection
over mixed availability; override expiry materiality (§13.1); the 48h boundary
computed from first failure; bulk-approval grouping.

**Theme source guards.** Approved copy character-for-character; no banned term
anywhere in rendered output; no internal rate, tier label or rule id in any
proxy response.

**Existing suites must stay green:** 569 unit / 232 integration at `b709aa0`.

---

## 12. Agent ownership

Per `CLAUDE.md`, the architect specifies and reviews; implementation is
delegated to the smallest capable specialist. File ownership is disjoint by
stage to satisfy the parallel-safety rule.

| Task | Agent | Model | Files owned |
|---|---|---|---|
| T1 — Sync adapter, lifecycle, compare-and-set, placeholder re-check | Backend & Pricing | `sonnet` | `app/shopify/admin/`, `app/jobs/pricing/` |
| T2 — Input-change trigger, immediate recalculation, bulk grouping | Backend & Pricing | `sonnet` | `app/jobs/pricing/`, `app/db/repositories/` |
| T3 — Approval/rejection/override workflow + expiry | Backend & Pricing | `sonnet` | `app/domain/pricing/override*`, admin routes |
| T4 — Sync failure, retries, alerts, 48h suspension, auto-restore | Backend & Pricing | `sonnet` | `app/jobs/pricing/failure*` |
| T5 — Migrations M1–M7 | Backend & Pricing | `sonnet` | `prisma/` |
| T6 — Collection/search "As low as" + metafield writer | Shopify Developer | `sonnet` | `theme/`, `app/shopify/metafields/` |
| T7 — PDP both-price display + two add-to-cart actions | Frontend & UX | `sonnet` | `theme/sections/`, `theme/assets/` |
| T8 — Cart payment-mode switching and repricing | Frontend & UX | `sonnet` | `theme/` cart templates |
| T9 — Bank Payment order: draft order, invoice, 24h sweep, verification admin | Backend & Pricing | `sonnet` | `app/domain/bankpayment/`, `app/jobs/bankpayment/` |
| T10 — F-23 / F-24 config gaps | Backend & Pricing | `sonnet` | `react-router.config.ts`, `tsconfig.json` |
| T11 — Money-critical + tamper suites | Test Engineer | `haiku` | `app/tests/` |
| T12 — QA and security review | QA & Security Reviewer | `sonnet` | read-only |
| T13 — Architect acceptance | Tech Lead | `opus` | read-only |
| T14 — F-7 deploy task: split migration and runtime DB roles | Backend & Pricing | `sonnet` | deploy config |

T6/T7/T8 (theme) and T1–T5/T9 (app) are disjoint and may run concurrently. T9
depends on T1. T11 depends on the stage it tests.

---

## 13. Open decisions

Three need an owner or architect ruling. **None blocks starting stage 2A**;
D17 blocks shipping 2C to customers.

**D16 — per-variant withdrawal mechanism (architect recommendation, owner may
override).** §5.2. Recommendation: ship layered enforcement now, record the
residual gap, revisit a Cart Validation Function if the store ever moves to
Plus. Consistent with how the same class of gap was handled for Luxury Steals
(§6.3 / D6).

**D17 — customer-facing copy for the bank-payment flow.** The not-committed
disclosure, the expiry-cancellation email, the awaiting-verification state and
the ineligible-line explanation are **material terms**. `CLAUDE.md` forbids
inventing them and the previously approved copy does not cover them. I will
draft candidates for approval rather than ship placeholder wording.

**D18 — CONFIRMED BY OWNER 2026-09-19. See §16.1.** The §13.1 definition stands; T3 is unblocked.

### 13.1 Engineering definition requiring confirmation

Owner §2.4 says an override "expires on next material recalculation". *Material*
needs a precise meaning before it can be coded. Proposed:

> A recalculation is **material** for a given override when it produces a Bank
> Payment Price that **differs** from the Bank Payment Price of the calculation
> the override departed from. A recalculation producing an identical Bank
> Payment Price is immaterial and leaves the override in force.

This makes a daily no-change run harmless to overrides while any genuine input
movement retires them, which I read as the intent. Flagged rather than assumed
because the alternative reading — *any* recalculation run expires it — would
retire every override within 24 hours and make the feature nearly useless.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Publishing the Bank Payment Price instead of the card price, undercharging every card sale | Port parameter is typed `regularCardPrice`; criteria 2/3 and tests 5/6; the figure is derived, never read from a `price` column |
| A bank-mode cart reaching native checkout and charging card prices | Fails **safe** (overcharge-free correct card price); theme replaces the checkout action in bank mode |
| Cart attribute tampering to obtain bank prices | Criterion 43: every line price recomputed server-side; tests 13–15 |
| Auto-publish switching on as a side effect | Separate enablement defaulted off (criterion 8), closing D14-followup (4) |
| Silent 400 on the bank-checkout POST (R-1 / F-23) | T10 closes it before T9 ships; the failure would be invisible in logs |
| Draft order accidentally reserving inventory | Test 23 asserts on the serialised request payload, not on intent |
| Theme copy drift on material terms | Character-for-character source guards, as in Slice 1 |

---

## 15. Architecture Review Verdict

Reviewed 2026-09-19 against `docs/ARCHITECTURE-MVP1.md`, `docs/BANK-CARD-PRICING.md`,
`docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md`, `docs/specs/SLICE-0-FINDINGS.md`,
`README.md` and `CLAUDE.md`, and against the actual repository state at `b709aa0`.

### 15.1 What holds

- **Native-vs-custom boundary is clean and defensible.** Checkout, payments,
  taxes, inventory, accounts and order creation stay native. The one place the
  slice leaves the native path — Bank Payment Checkout — does so because the
  platform genuinely cannot vary a total at payment selection, verified against
  current documentation rather than assumed, and it uses Shopify's own draft
  order rather than a second checkout.
- **No new infrastructure.** No queue, no service, no database, no headless
  layer, no SaaS dependency. Recurring cost is unchanged at ~$50–110/month.
- **Financial determinism preserved.** The card price stays a derived pure
  function of the stored Bank Payment Price and the calculation's own versioned
  rule; nothing is stored twice.
- **Migrations M1–M7 are purely additive** — no column drops, no type changes,
  no backfill that could misprice an existing row. Rollback is restore-plus-
  forward-fix as established.
- **The auto-publish enablement split** closes the long-outstanding
  D14-followup (4) properly rather than by convention.

### 15.2 Scope finding — this is not the slice 2 the architecture planned

`ARCHITECTURE-MVP1.md` §10 lists slice 2 as *"Theme baseline + Buy Now PDP"*,
Medium risk, owned by Shopify Dev + Frontend. The owner's decision set makes it
real price publication, an admin money-approval workflow, a failure/suspension
state machine, and an invoiced alternative payment rail. That is **Highest**
risk and majority backend.

This is a legitimate owner re-scoping, not scope creep by the architect — but
the table in §10 must be amended to say so, and the three stages in §3 should be
**formally separate reviewable units**, each with its own architect acceptance,
rather than one acceptance at the end. A single review of all three at once is
how a defect in stage 2A reaches customers through stage 2C.

### 15.3 Conditions — must be closed before implementation starts

**C1 — Name which calculation the storefront displays.** The spec requires the
published card price to derive from the calculation's own profile, but never
says which calculation the PDP and collection surfaces read. If they read the
*newest* calculation while Shopify still carries the *last synced* one, the page
advertises a price checkout will not charge. **All customer-facing surfaces must
read `master_variant.lastSyncedPriceCalculationId`** — the published one — and
the bank price, card price and saving must all come from that single row. Add as
an acceptance criterion with a test that computes a new calculation, leaves it
unsynced, and asserts the storefront still shows the published pair.

**C2 — Draft order creation needs an idempotency key.** `ARCHITECTURE-MVP1.md`
§6.7 makes idempotency mandatory for outbound operations, and a double-clicked
Bank Payment Checkout currently creates two draft orders and two invoices. Key
on cart token + mode + a content hash of the recomputed lines, committed before
the Admin API call, per the established pattern.

**C3 — Extend the money-safety scan before the code lands, not after.** Add
`app/domain/bankpayment/`, `app/jobs/bankpayment/` and `app/shopify/admin/` to
`TIER2_DIR_PREFIXES`. This is exactly the hole T11 condition C2 just closed for
the groupbuy modules; repeating it in the same repository two days later would
be indefensible.

**C4 — Enumerate every theme surface that renders a cart total.** Bank mode
repricing is only correct if it covers the cart page, the cart drawer, the
mini-cart, any sticky/ajax total and the header count-and-total. A single
uncovered surface shows a card subtotal to a bank-mode customer, which is the
"silently fake" outcome `BANK-CARD-PRICING.md` §8 prohibits. Require the
implementer to produce the list from the actual theme and cover each.

**C5 — Metafield/price coherence.** The variant price write and the bank-price
metafield write are two Admin API calls and can partially fail. Require the
metafield payload to carry the `priceCalculationId` it was derived from, and the
theme to suppress the bank-price block when it does not match the published
calculation, rather than render a mismatched pair.

### 15.4 Gaps requiring an owner decision — newly identified in review

**D19 — shipping and tax on Bank Payment orders.** Not addressed anywhere in the
owner decisions. A draft order does not compute a shipping rate by itself; one
must be set explicitly. Unresolved: which shipping rate a bank order quotes,
whether the 24-hour guarantee covers shipping and tax or only merchandise, and
whether tax is recalculated at completion. **This blocks stage 2C only.**

**D20 — customer identity and address capture for a bank order.** A draft order
requires an email, and shipping requires an address. A logged-in customer
supplies both through `logged_in_customer_id`; a **guest does not**. Slice 2
therefore needs either a pre-invoice details form or a decision that Bank
Payment Checkout requires a customer account. This is real scope not currently
costed into T9. **Blocks stage 2C only.**

**D21 — interaction between variant suspension and an open bank order.** If a
variant is suspended at 48 hours (criterion 24) while a bank order quoting it is
still inside its 24-hour guarantee, the spec does not say whether that order is
honoured or cancelled. Recommendation: **honour it** — the price was quoted in
good faith, no inventory was reserved, and cancelling punishes the customer for
our sync failure. Needs confirmation.

### 15.5 Responsibility matrix

| Layer | Owns |
|---|---|
| **Shopify** | Catalogue, variant price of record, card cart/checkout/payments/taxes, inventory, accounts, order creation and emails, draft order + invoice + manual gateway, metafield storage |
| **Backend (app)** | Sync adapter and lifecycle, compare-and-set, approval/override/expiry, failure state machine and suspension, input-change triggers, bank order quote/guarantee/verification, all server-side repricing |
| **Frontend (theme)** | Collection "As low as", PDP price pair and two add-to-cart actions, cart mode switching and display, accessibility, error states |
| **Persistence** | Postgres system of record for every price, override, failure and bank order; metafields are a presentation cache only |
| **Third parties** | Resend for the cancellation email; none other introduced |

### 15.6 Phased plan and dependencies

| Stage | Contains | Depends on | Gate |
|---|---|---|---|
| **2A** | T1–T5, T10, T14 + money-critical suite | `b709aa0` | Architect acceptance **and** green money-critical suite before auto-publish may be enabled |
| **2B** | T6–T8 + tamper suite | 2A (published prices must exist) | Architect acceptance; C4 list demonstrated |
| **2C** | T9 + bank lifecycle suite | 2A, 2B, **D17, D19, D20** | Architect + QA acceptance before any customer sees it |

### 15.7 What this slice will not build

Group Buy core or refunds; Luxury Steals; RMA; warranty; automated metal feed;
customer payment-proof upload; Cart Validation Function; store credit;
multi-currency; theme localisation; automated dispute packets.

---

### VERDICT: **APPROVE WITH CONDITIONS**

The design is sound, the native boundary is right, the platform research is
real, and the owner's decisions are implementable as written. Approval is
conditioned on:

1. Closing **C1–C5** in the spec before implementation begins. C1 and C2 are
   correctness defects in the spec as drafted, not preferences.
2. Owner resolution of **D17** (material customer copy) before stage 2C ships,
   and of **D19, D20, D21** before stage 2C is implemented. Stage 2A may start
   immediately; none of these block it.
3. Confirmation of **D18** (§13.1's definition of "material recalculation")
   before T3 is delegated.
4. Amending `ARCHITECTURE-MVP1.md` §10 to reflect the re-scoped, Highest-risk
   slice 2 and its three-stage structure, with architect acceptance at each
   stage gate rather than once at the end.
5. Owner acknowledgement of the recorded conflicts in
   `SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` §9 — in particular §9.3, which
   un-defers a flow a prior decision deferred, and §9.1's browse-to-PDP price
   increase.

No implementation begins until conditions 1 and 3 are met and the owner approves
this spec.

---

## 16. Condition closure and owner confirmations (2026-09-19)

Recorded after the §15 review and the owner's approval to begin stage 2A.

### 16.1 D18 — CONFIRMED BY OWNER

The definition proposed in §13.1 stands and is now locked:

> A recalculation is **material** for a given override when it produces a Bank
> Payment Price that **differs** from the Bank Payment Price of the calculation
> the override departed from. A recalculation producing an identical Bank
> Payment Price is immaterial and leaves the override in force.

T3 is unblocked. A daily no-change run does not retire overrides; any genuine
input movement does.

### 16.2 Conditions C1–C5 — closed as acceptance criteria

The §15 conditions are hereby folded into §4 as binding criteria rather than
left as review prose, because a condition that lives only in a verdict is a
condition that does not get tested.

**52 (closes C1) — the storefront displays the PUBLISHED calculation, not the
newest one.** Every customer-facing surface — collection card, search card, PDP,
cart, and any App Proxy JSON feeding them — reads the calculation referenced by
`master_variant.lastSyncedPriceCalculationId`. The Bank Payment Price, the
Regular/Card Price and the saving must all derive from that **single row**, so
the three figures cannot come from different points in time.

A variant with no `lastSyncedPriceCalculationId` is **not purchasable** and never
sets an "As low as" headline (this is the same predicate as criterion 29).

*Test:* compute a new calculation at a different price, leave it unsynced, and
assert the storefront still shows the previously published pair and that the
saving still equals published card − published bank.

**53 (closes C2) — draft order creation is idempotent.** An `idempotency_key`
row is committed **before** the `draftOrderCreate` call, keyed on cart token +
payment mode + a content hash of the server-recomputed lines, following
`ARCHITECTURE-MVP1.md` §6.7. A repeat with the same key returns the stored draft
order and makes **no** second Admin API call and sends **no** second invoice.

*Test:* two concurrent Bank Payment Checkout submissions for one cart produce
exactly one draft order, one invoice and one `bank_payment_order` row.

**54 (closes C3) — the money-safety scan covers the new modules before they
exist.** `app/domain/bankpayment/`, `app/jobs/bankpayment/` and
`app/shopify/admin/` are added to `TIER2_DIR_PREFIXES` in
`app/scripts/check-money-safety.mjs` **as the first commit of stage 2A**, ahead
of any code in those paths. Prefix checks cover paths that do not yet exist,
which is the whole reason the list is written as prefixes.

**55 (closes C4) — every cart-total surface is enumerated and covered.** Before
T8 is delegated, the implementer produces the list of every theme surface that
renders a cart total, subtotal or line price — cart page, cart drawer,
mini-cart, ajax/sticky totals, header summary — from the **actual theme source**,
not from memory. Each appears in the spec's task notes and each is covered by a
bank-mode assertion. An uncovered surface showing a card subtotal to a bank-mode
customer is the outcome `docs/BANK-CARD-PRICING.md` §8 prohibits.

**56 (closes C5) — price and metafield coherence.** Every price-bearing
metafield payload carries the `priceCalculationId` it was derived from. The
theme renders the Bank Payment block **only** when that id matches the published
calculation for the variant; on mismatch it renders the card price alone and the
app raises the same persistent admin alert used for sync failure. A partially
applied write therefore degrades to a correct single price, never to a
mismatched pair.

### 16.3 Stage 2A entry — CLEARED

Conditions blocking stage 2A were C3 (criterion 54) and D18; both are closed
above. C1/C4/C5 bind stage 2B, C2 binds stage 2C, and D17/D19/D20/D21 remain
open against stage 2C only.

**Stage 2A may begin.** Stage 2B and 2C may not begin until their own conditions
and decisions are closed.

### 16.4 Criterion 57 — the Bank Payment Checkout POST must be a resource route

Added 2026-09-19 from T10's finding, which corrected `ARCHITECTURE-MVP1.md`
§2.1 R-1.

R-1 previously offered two interchangeable mitigations for the React Router CSRF
origin guard: resource routes, **or** `allowedActionOrigins`. T10 verified
against the installed `@react-router/dev@7.18.3` CLI source that
`react-router build` forces Vite's `defaultNodeEnv` to `"production"`
unconditionally, so **every production build ships an empty allowlist** and the
second option is inert where it matters. The two are not alternatives in
production; resource routes are the only protection.

Therefore:

> **57.** The stage 2C Bank Payment Checkout endpoint — and every other
> cross-origin POST this slice adds — is a **resource route with no default
> export**. A route that both renders UI and accepts a cross-origin POST is not
> a valid shape in this app; split it.

Enforced by the machine-checked route fence T10 is adding, not by review
attention. The failure it prevents is a 400 returned before validation, before
any evidence row, and before any log line we emit — a customer's bank order
vanishing with nothing to explain it.

### 16.5 Schema rulings from T5 (2026-09-19) — binding on T2, T4 and T9

T5 flagged six judgement calls rather than deciding them silently. Rulings:

**R1 — `bank_payment_order_line` is WHOLE-ROW append-only. CONFIRMED, and it is
better than what §6 M7 asked for.** The spec said "the quote columns"; T5 made
the entire row immutable, on the grounds that verification, status, completion
and cancellation all live on the mutable `bank_payment_order` header and
nothing on the line legitimately mutates after insert. That is correct and
strictly stronger: a whole-row-immutable table cannot have a quote column
changed by any route, including one nobody thought of. **T9 must put every
mutable per-order fact on the header.** If T9 finds it genuinely needs a mutable
column on the line, that is a spec change requiring my approval, not a local
swap to a column-level trigger.

**R2 — `alert_state` distinguishing `dismissed` from `cleared` is
CORRECT.** Dismissing the persistent alert silences the notification
(criterion 22) and records who did it and why. It does **not** resolve the
failure episode and does **not** restore a suspended variant. Only a genuinely
successful later sync sets `resolved_at`, and that is the sole trigger for
criterion 25's auto-restore, which the owner specified as happening with **no
human action**. A human being able to un-suspend a variant by silencing an alert
would let an unpublishable price go back on sale by clicking "dismiss". **T4
must read availability from `suspended_at IS NOT NULL AND resolved_at IS
NULL`, never from `alert_state`.**

**R3 — the verification block belongs on `bank_payment_order` (header), not
per line. CONFIRMED.** Owner §8.6/§8.7 describes verifying *a payment* —
amount, method, reference, timestamp, admin — and a bank transfer settles an
order, not a line. Per-line verification would invent a reconciliation problem
the owner did not ask for.

**R4 — `suspended_at` is never cleared back to NULL. CONFIRMED.** Restoration
is expressed by `resolved_at`, so the fact that a variant was once withdrawn
survives in the record. Nulling it would erase the only evidence that a
48-hour outage happened.

**R5 — `PricingInputChangeKind`'s value list is provisional.** T5 derived it
from Slice 1 §4.2's input inventory. **T2 must verify it covers every persisted
price-affecting input it actually triggers on** before relying on it; the enum is
additive, so extending it is cheap. An input change that has no enum value is an
input change that silently fails to trigger a recalculation, which is
criterion 17's whole point.

**R6 — eight migration folders for seven logical migrations is correct.** M2 and
M4 each split in two because Postgres refuses to compare a newly added enum value
inside the transaction that added it, and Prisma wraps each migration file in one
transaction. Migration `20260917070507` already established this pattern in
this repository. This is a platform constraint, not a deviation.

### 16.6 Findings from T3-domain (2026-09-19)

**R5 is SETTLED — no gap.** `PricingInputChangeKind` was audited model by model
against the real schema and Slice 1 §4.2's input inventory: every price-affecting
table has a value, and every excluded model is correctly excluded. Group Buy's
frozen tables in particular stay out, per D15 and the existing
`d15WriteSurface.test.ts`. **No migration needed.**

**Criterion 58 (new, binding on T2) — trigger on the COLUMN, not the table.**
`master_variant` and `master_product` each mix genuinely price-affecting
columns (`baseWeightGrams`, `metal`, `bandId`, `laborSource`,
`minBankPaymentPriceMinorUnits`, `sizeAxis`, `allowedSizeMin/Max`,
`sizeIncrement`, `baseSize`) with columns that are not price inputs at all
(`status`, `shopifyVariantGid`, `shopifyProductGid`,
`lastSyncedPriceCalculationId`, `bankPaymentDiscountEligible`, timestamps).

Criterion 17 requires a recalculation on a price-affecting **input** change.
Firing on every UPDATE to those tables would recalculate the whole catalogue
whenever a Shopify sync stamps `lastSyncedPriceCalculationId` — which the sync
path does on **every successful publish**, making price publication trigger the
next recalculation, which triggers the next publish. T2 must diff the changed
columns against an explicit allow-list of price-affecting fields before writing
a `pricing_input_change` row, and must have a test proving that toggling
`bankPaymentDiscountEligible` or writing `lastSyncedPriceCalculationId`
triggers **nothing**.

**Follow-up F-30 (new) — two implementations of "the override in force".**
`app/app/db/repositories/priceOverrideExpiryRepository.server.ts` resolves the
head of the override chain with its own query rather than importing
`resolveActiveOverride` from `app/app/jobs/pricing/priceOverride.server.ts`.
That was the correct call at the time — a repository importing job code inverts
the layering criterion 29 protects, and the job file was being edited
concurrently — but it leaves two queries that must agree about which row is in
force, with nothing making them agree. A divergence would be silent and would
mean the price actually charged and the price the expiry logic reasoned about
came from different overrides.

**Owning slice: the remainder of Slice 2 stage 2A.** Resolution: move the
canonical resolver into the domain/repository layer and have the job import it,
never the reverse. Do not consolidate mid-task while both files are being
edited; do it once T1, T2 and T4 have landed, and pin it with a test asserting
exactly one implementation exists.

**`price_override.price_calculation_id` means different things per kind —
ACCEPTED, and it must be documented in the schema, not only in the repository.**
For `set` it is the calculation the override departs from; for `expired` it
is the calculation whose differing price caused the expiry. That asymmetry is
deliberate and carries strictly more information (the retired override's own
calculation stays reachable through `supersedes_id`), but a column whose
meaning varies by row kind is exactly the kind of thing a dispute reader
misinterprets years later. A schema comment stating both meanings is required
before stage 2A is accepted.

### 16.7 Retry backoff — engineering default, not owner policy

Owner §4.2 requires retries be "automatic" and the spec says "bounded backoff",
but no schedule is specified anywhere in the owner decisions or this spec. T4
implemented 30s base, doubling, capped at 30 minutes, and **flagged it as its own
default rather than presenting it as policy** — the correct call.

Recorded here as **tunable, not locked**, on the same footing as
`DEFAULT_STALE_CLAIM_MS`: three named constants, changeable without an owner
decision.

One property of the schedule is **not** tunable, because criterion 25 depends on
it: **retrying must continue after suspension.** "Bounded" means the interval
stops growing, never that attempts stop. The owner's auto-restore happens with no
human action, and the only thing that can restore a suspended variant is a later
sync succeeding — so a backoff that gave up would make a suspension permanent
and silently convert an outage into a withdrawn product. Any future retune must
preserve that.

### 16.8 T1 findings — two gaps that must not be mistaken for done (2026-09-19)

**Criterion 59 — F-27 is only HALF closed. A human approval currently publishes
nothing.**

T1 wired `runPriceRecalculation`'s auto-apply branch to
`syncApprovedPriceSyncIntent`, so with `PRICE_AUTO_PUBLISH_ENABLED=true` a
≤200 bps change publishes. It deliberately did **not** wire `decideIntent` (the
human-approval transition) or `scripts/price-review.ts` (the CLI), on the
grounds that `decideIntent` must stay a pure state transition and the CLI's own
header says not to extend it. **That reasoning is accepted** — coupling an Admin
API call into a state-transition function would be the wrong layering, and it
would throw on every existing fixture lacking Shopify linkage.

But the consequence must be stated plainly rather than left implicit:
**today, a >2% change that an admin explicitly approves does not reach Shopify.**
That is the exact path the owner's §1.6 requires for every large price move. An
approval workflow that records an approval and publishes nothing is worse than
no workflow, because it looks like it worked.

Owning task: **T3's admin surface**, which must call
`syncApprovedPriceSyncIntent` after a human approval and surface the result.
**Stage 2A is not complete until this is wired**, and no one may report F-27 as
closed before then.

**Criterion 60 — the mutation shape is unverified against a real store, and
gates auto-publish.**

`productVariantsBulkUpdate`'s request shape was written from the documented
Admin API schema, not confirmed by introspection against the development store —
T1 said so explicitly rather than letting it pass, which is the right call. The
existing `productClient.server.ts` was verified against a live store; this
adapter has not been.

**Enabling `PRICE_AUTO_PUBLISH_ENABLED` in any environment now requires two
things, not one:** the money-critical suite green (§3's existing gate) **and** a
successful real-store smoke publish confirming the mutation shape and that the
resulting variant price on Shopify equals the final rounded Regular/Card Price to
the cent. A schema-derived mutation that is subtly wrong fails at the moment it
first touches real money.

**Accepted without change:** the port widening to carry `shopifyProductGid`
(the Admin API has no single-variant price mutation, so the parent id is
required); the auto-apply sync running in its own try/catch so a sync failure
cannot be miscounted as a calculation failure or collide with the unique
`(runId, masterVariantId)` constraint; leaving an Admin API error uncaught so
the intent rests in `syncing` for T4's failure path to claim; and the
`autoApplyTolerance` rescope, which replaced a database-wide count that only
held while nothing could ever sync with a run-scoped assertion plus a non-empty
check, so it cannot pass vacuously.

**Propagate to every agent writing integration fixtures:** T1 found that fixture
variants left `active` pollute `where: { status: "active" }` for every later
file in the run, because the whole integration suite shares one disposable
database. Archive fixture variants in `afterEach`. This is a latent
cross-file trap, not a T1-specific one.

### 16.9 T2-domain rulings (2026-09-19)

**R7 — `MasterProduct.isLuxurySteal` classified as price-affecting. CONFIRMED.**
T2 flagged this for a second opinion. The classification is right, for a reason
worth writing down: Luxury Steals are excluded from Buy Now recalculation by
`LuxuryStealExclusionSource`, so toggling this column changes **whether the
engine prices the product at all**. A product leaving Luxury Steals needs a Buy
Now price immediately, not at the next daily run — until it has one it is on sale
with a stale assigned price and no recalculation reaching it. There is also no
loop risk, because nothing in the recalculation or sync path ever writes this
column; that is the property that distinguishes it from
`lastSyncedPriceCalculationId`, and it is the test worth keeping in mind for
any future classification: *does anything in the publish path write this?*

**R8 — the classifier throws on an unclassified column at RUNTIME, not only in
the fence. CONFIRMED and important.** `UnclassifiedColumnError` means a column
added by a future slice fails loudly the first time a write touches it, even if
someone skipped the test suite. The fence catches it at build time; the throw
catches it in the only other place it could matter. Neither guesses a default,
which is the point — a silent default in either direction is a wrong price or an
infinite republish loop.

**Accepted as designed:** the allow-list per model rather than a deny-list (a
deny-list fails open); DMMF-driven exhaustiveness with a non-zero-count guard so
broken introspection cannot pass vacuously; classifying every real column on the
append-only L1 tables even though they are only ever inserted, so a hypothetical
future UPDATE path inherits a real answer rather than an omission;
`MODEL_TO_PRICING_INPUT_CHANGE_KIND` as a single lookup so model and kind
cannot be passed out of agreement; and `recordPricingInputChangeIfPriceAffecting`
returning `null` rather than throwing when nothing price-affecting changed.

**Noted, not a defect:** the bulk-approval resolver walks
`pricing_input_change → price_recalculation_run → price_calculation → price_sync_intent`
in three queries because the middle hop joins on `runId` with no Prisma
relation. That is a pre-existing schema convention, not something T2 introduced.

### 16.10 Alert delivery — criteria 61–70 (the final Stage 2A blocker)

Owner §7 requires "notify the admin immediately"; owner §15 requires
notification "through **both email and a persistent embedded-admin alert**".
Both failure state machines were built, wired and correct, and neither could
tell anybody: `EMAIL_API_KEY` was an env declaration with no sender behind it
and no admin surface existed. The code said so honestly in a comment rather
than pretending otherwise. These criteria make that comment untrue.

**61 — both failure kinds raise alerts.** An unresolved calculation failure
(§7) and an unresolved Shopify sync failure (§15) each produce a persistent
admin alert and an email. Neither kind may be silent.

**62 — both channels, or an honest record that one was unavailable.** When
`EMAIL_API_KEY`, `EMAIL_FROM` or `STAFF_EMAIL_ALLOWLIST` is unset, the
notification is recorded with delivery **unset and a stated reason**, and a
distinctly named event is logged. **A row claiming an email was sent when none
was is worse than no row** — that is the exact class of false completion
signal this whole blocker exists to correct, and replacing one with another
would be indefensible.

**63 — every alert identifies:** product, variant, failure type,
reason/message, first unresolved failure timestamp, current age, time
remaining before the 48-hour cutoff, latest retry result, and current status.
`productTitle`/`variantLabel` are nullable and a row is **never dropped**
when they cannot be resolved — a failure that cannot even be named is more
urgent, not less.

**64 — retries must not spam.** Dedup is a UNIQUE constraint on
`(source_kind, source_id, event)`, inserted-and-caught, never a read-then-write
check, which races. Email fires on **three meaningful state changes only**:
episode opened, 48-hour suspension reached, resolved. However many retries
occur between them, the count stays at three.

**65 — the persistent alert updates rather than accumulates.** A retry
refreshes the existing episode's state; it does not create a second alert for
the same variant and failure kind.

**66 — resolution clears the alert by construction.** The open-alert list is
derived from `resolved_at IS NULL`. There is no second "alert cleared" flag
that could disagree with the episode state. Resolution time is recorded
(already enforced by the calculation-failure CHECK pairing
`resolved_at`/`resolved_trigger`).

**67 — the two kinds stay distinct in storage AND presentation.** Separate
tables already; the `source_kind` discriminator carries through the view model
into the email subject/body and the admin page. A reader must be able to tell
"we could not compute a price" from "Shopify would not accept the price we
computed" at a glance — they need different fixes.

**68 — one view model, two renderings.** The email body and the admin page
render from the **same pure function**, so they cannot drift. Purity is also
what makes the field set testable without a database.

**69 — nothing sensitive leaves.** No supplier cost, margin, landed cost,
pricing-profile internals, uplift rate, rule id, token or secret in an email
body, a log line, or the rendered page (C-S5). Failure *reason* text is fine;
a cost breakdown is not. **An email body is the least trusted destination in
the system** — it leaves our infrastructure entirely and cannot be recalled.

**70 — `dismissed` never means fixed.** Dismissal exists only for sync
failures. It silences the notification and records who and why. It does **not**
set `resolved_at`, does **not** restore a suspended variant, and must not be
presented as resolved. This is ruling R2 carried from the schema into the UI:
otherwise a human could put an unpublishable price back on sale by clicking
"dismiss".

**Route safety.** The admin surface sits behind `authenticate.admin`, never an
App Proxy route. It is loader-only, so `csrfResourceRouteFence.test.ts` needs
no exemption entry; adding an action later would require a reasoned one. Worth
recording that the fence built earlier in this stage constrained a route
written hours later by a different agent, with nobody needing to remember the
rule — which is what it was for.
