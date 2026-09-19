# Slice 2 and Group Buy — Owner Decisions

## Status

**LOCKED OWNER DECISIONS — 2026-09-19.**

This document did not exist when Slice 2 planning began; it was cited as a
source of truth in the owner's Slice 2 planning instruction, and is created here
to record the decisions that instruction contained. **The decisions below are
the owner's, transcribed; the commentary marked *Engineering note* is not.**

These decisions control Slice 2. Where one conflicts with an earlier locked
document or an engineering contract, the conflict is named explicitly in §9 —
nothing here is applied silently over a locked document.

---

## 1. Price sync to Shopify

1. Slice 2 implements **real** Shopify price sync through `ShopifyPriceSyncPort`.
2. The intent lifecycle is driven end to end: **`approved → syncing → synced`**.
3. `master_variant.lastSyncedPriceCalculationId` is **written and updated** on a
   successful sync, not merely read.
4. The published figure is the **final rounded Regular/Card Price**, derived
   from the calculation's **own frozen/versioned pricing rule** — never from
   today's active pricing profile.
5. Bank Payment Price changes of **2% or less may auto-publish**, but only
   **after the real sync path has passed money-critical integration tests**.
   Automatic publication is a separate enablement, defaulted off, and is not
   switched on by the existence of a tolerance value.
6. Changes **greater than 2%** require admin approval.

## 2. Admin approval workflow

1. **Bulk approval** is supported when a single shared pricing-input event
   caused the changes (for example: one metal price was updated).
2. **There is no bulk reject.**
3. **Per-item rejection requires an override price and a reason.** A rejection
   is not merely a refusal; it sets the price the item will carry instead.
4. A temporary override **expires on the next material recalculation** unless it
   is explicitly marked **Never Expire**.

## 3. Recalculation triggers

1. **Any persisted price-affecting input change triggers immediate
   recalculation.**
2. A **daily scheduled recalculation** also runs (D15, unchanged).

## 4. Sync failure handling

When a price sync to Shopify fails:

1. **Keep the last published Shopify price live.** Never blank, zero or guess a
   price.
2. **Retry automatically.**
3. Raise **both** an email alert and a **persistent admin alert** that does not
   clear itself.
4. Start a **48-hour timer**.
5. After 48 hours unresolved, make **only the affected variant** unavailable —
   never the product line, never the catalogue.
6. **Auto-restore** availability when the sync later succeeds.
7. The customer **may continue purchasing at the currently published price**
   throughout the unresolved-sync window.
8. **No retroactive refund** is owed merely because a lower price publishes
   later.

## 5. Buy Now — collection and search surfaces

1. Show **"As low as $X"**.
2. **X = the lowest currently purchasable Bank Payment Price** across the
   product's purchasable variants.
3. **Do not also show the Regular/Card Price** on collection or search cards.

*Engineering note:* this is a deliberate, owner-stated exception. See §9.1.

## 6. Buy Now — product detail page

1. Show the **Regular/Card Price**.
2. Show the **Bank Payment Price**.
3. Show the **exact dollar savings**.
4. Two buttons:
   - **Add to Cart**
   - **Add to Cart with Bank Payment Discount**
5. Clicking **Add to Cart with Bank Payment Discount** switches the **entire
   cart** to Bank Payment mode and **reprices all eligible lines**.
6. A normal **Add to Cart preserves the cart's existing payment mode**.
7. **One payment mode per cart.** A cart is entirely card-mode or entirely
   bank-mode; there is no mixed cart.

## 7. Cart and checkout

1. The cart offers two checkout options: **Card Checkout** and **Bank Payment
   Checkout**.
2. **Bank Payment must always remain available as a payment method.**
3. A **separate `Bank Payment Discount Eligible` flag exists per
   product/variant, defaulting to ON.**
4. **Ineligible lines stay at the Regular/Card Price even when paying by bank.**
   A bank-mode cart may therefore legitimately contain a mix of bank-priced and
   card-priced lines; the *mode* is uniform, the *pricing outcome* is per line.
5. **Buy Now and Group Buy cannot share one cart or one order.**

## 8. Buy Now Bank Payment orders

1. The quoted price is **guaranteed for 24 hours**.
2. After 24 hours, if **unpaid and the price is unchanged**, the order **stays
   open**.
3. After 24 hours, if **unpaid and the price has changed by any amount**, the
   order is **cancelled and the customer is emailed**. Any change, not a
   tolerance band.
4. **Do not reserve inventory before payment.**
5. Checkout **and** the confirmation email must state that the order **is not
   committed and availability is not guaranteed until payment is received and
   verified**.
6. **Payment receipt is manually verified by an admin.**
7. Verification records **amount, method, reference where available, timestamp,
   and the admin who verified**.
8. Customer payment proof may remain **email/manual for MVP1**.

## 9. Conflicts with existing locked documents — flagged, not silently applied

CLAUDE.md forbids silently changing a locked business decision. Three of the
decisions above depart from previously locked text. Each is recorded here for
explicit owner confirmation.

### 9.1 Collection/search shows only the Bank Payment Price (§5)

`docs/BANK-CARD-PRICING.md` §6 states *"The Regular/Card Price is the primary
advertised price"* and §8 applies that to the product page and cart. The
collection and search grid are **not** named in §8, so this is a gap rather than
a direct contradiction — but showing only the **lower** price on the browse
surface, then a **higher** primary price on the product page, is the inverse of
§6's intent.

The owner has stated this is intentional. **Engineering risk, stated once and
not re-litigated:** a browse-to-PDP price increase is the pattern consumer
protection regulators treat as drip pricing, and "As low as" must therefore be
strictly true — it must be a price a customer can actually obtain, for a variant
actually purchasable, by a payment method actually offered. The implementation
below enforces exactly that. Whether the pattern is acceptable as marketing is
the owner's call and is recorded as taken.

### 9.2 Contract C-S6 is amended (§5, §6)

`docs/specs/SLICE-0-FINDINGS.md` contract **C-S6** read: *"Every surface showing
a price must show BOTH prices, or neither."* That was an engineering contract
written in slice 1, not an owner decision.

**The owner has directed that it not be reintroduced.** C-S6 is amended to:

> Every surface showing a price must show **either** both prices with the exact
> saving (product detail, cart, checkout, email, admin), **or** the "As low as"
> Bank Payment Price alone (collection, search). No surface may show the
> Regular/Card Price alone, and no surface may show a Bank Payment Price that a
> customer cannot actually obtain.

### 9.3 Draft-order bank checkout is no longer deferred (§7, §8)

`docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md` §3 records an owner decision of
2026-09-19 that MVP1 ships **display only**, with the draft-order invoice flow
**deferred** to a separate future checkout/payment decision, and that **no
`write_draft_orders` scope is requested.**

The decisions in §7 and §8 above — a Bank Payment Checkout button, a 24-hour
price guarantee, no inventory reservation, manual admin payment verification, an
order that is not committed until payment is verified — **are** that deferred
flow, specified in detail. That document's Phase 2 is therefore **un-deferred and
promoted into Slice 2**, and the three prerequisites it named are answered by the
decisions above:

| Prerequisite named in the findings doc | Answer |
|---|---|
| `write_draft_orders` scope | Granted for Slice 2 |
| A decision on inventory holding | **Do not reserve** (§8.4) |
| A decision on Group Buy invoicing/reconciliation | **Out of scope** — Group Buy core is slice 6; §10 below |

## 10. Group Buy — preserved as future contracts only

**Slice 2 does not implement Group Buy core.** Group Buy rules already
documented are preserved as contracts for slice 6 and slice 8 and are not built
here.

The single exception is where Slice 2 touches **shared cart and payment
infrastructure**. Slice 2 therefore owns, for Group Buy's later benefit:

- the **Buy Now / Group Buy cart separation** mechanism (§7.5);
- the **payment-mode-per-cart** model that a Group Buy cart will later reuse;
- the **payment-basis-aware** order record, so a later Group Buy refund can tell
  a bank-paid order from a card-paid one.

Anything else Group Buy needs is a slice 6 or slice 8 concern.

## 11. Stale findings — re-evaluated, not carried forward

The owner directed that stale findings be re-evaluated rather than inherited.

| Item | Prior status | Now |
|---|---|---|
| **Tier-boundary price inversion** (C-S2 note 3) — a bank-price rise within tolerance can lower the published card price by up to ~0.5% | Open question for Slice 2: measure the published delta or accept explicitly | **ACCEPTED BEHAVIOUR by owner decision.** Not a blocker, not a defect, and no additional guard is required. The bank-to-bank measurement stands as specified in §1.5–1.6 |
| **C-S6 "both prices on every surface"** | Engineering contract from slice 1 | **Amended — see §9.2.** Do not reintroduce the original wording |
| **Collection/search price display** | Undecided | **Bank Payment "As low as" only — intentional.** See §5 and §9.1 |
