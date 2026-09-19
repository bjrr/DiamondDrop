# CaratForUs Cash / Card Pricing Policy

## Status

**LOCKED OWNER DECISION — 2026-09-18.**

This document is authoritative for the cash-vs-card pricing relationship across Buy Now, Group Buy, pricing floors, overrides, recalculation, Shopify publication, and customer-facing display.

If an older architecture note, feature spec, fixture, comment, or test conflicts with this document, this document controls and the conflicting implementation must be reconciled before release.

## 1. Cash price is the authoritative business price

All core pricing economics are calculated from the **cash-equivalent price**.

The following operate on cash price only:

- total product cost and cost composition;
- target markup;
- minimum gross-margin floor;
- minimum dollar-profit floor;
- variant-specific price floors;
- Group Buy tier multipliers and tier-safety checks;
- manual selling-price overrides;
- recalculation and repricing decisions;
- Group Buy campaign freeze values;
- Group Buy final-price/refund calculations.

The current locked Buy Now profile is:

- target markup: **40% on total cost**;
- minimum gross margin: **20% of cash selling price**;
- minimum dollar profit: **$100**;
- customer price ending: **whole dollars**.

A 40% markup is not a 40% gross margin.

## 2. Credit-card price is derived after cash price is final

After the final cash price has been calculated, rounded, ended, and checked against all floors:

`credit_card_price = cash_price × (1 + card_uplift_rate)`

MVP1 default:

`card_uplift_rate = 0.05`

The rate is configurable and versioned.

The credit-card price is a derived presentation/payment price. It must not feed back into cost, markup, margin, minimum-profit, Group Buy tier, or override calculations.

The codebase may store the authoritative cash price and derive the card price deterministically from the cash price plus the recorded rule/rate. Cash and card prices must never become two independently editable prices.

## 3. Cash-equivalent payment methods

For this pricing policy, cash-equivalent methods are:

- ACH;
- wire transfer;
- Zelle;
- check.

PayPal and Venmo are **not** part of the locked cash-equivalent-method list unless the owner later changes this policy.

Checkout availability and payment-method implementation remain subject to Shopify, processor, network, and applicable-law requirements. Those implementation constraints do not change the pricing-domain rule above.

## 4. Payment processing does not reduce the cash margin floor

Card-processing fees are not deducted when evaluating the 20% cash gross-margin floor or the $100 cash minimum-profit floor.

The 5% card uplift is the separate mechanism used to derive the credit-card price.

A future explicit owner decision may introduce a separate profitability or processor-cost rule, but engineering must not silently fold card-processing expense into the current cash floor calculation.

Any legacy `payment_processing` cost rows may be retained for audit/analytics or future use, but they must not cause the cash pricing engine or Group Buy tier-safety engine to lower the calculated cash margin.

## 5. Customer-facing display

The **credit-card price is the primary/displayed price**.

The **cash price is shown as the discounted cash-equivalent price**.

Example:

- cash price: $2,000;
- card price: $2,100.

Customer-facing presentation should be conceptually:

**$2,100**

*Pay $2,000 by ACH, wire, Zelle, or check.*

Do not advertise a fixed “5% cash discount.” A 5% uplift on cash is not mathematically the same as 5% off the displayed card price. Show the two exact dollar prices instead.

## 6. Group Buy

Group Buy economics are cash-based.

For each eligible variant:

1. freeze the campaign's authoritative **cash base price**;
2. apply the tier multiplier to that frozen cash base;
3. enforce the 20% cash gross-margin floor, $100 cash minimum-profit floor, and any variant floor against the resulting cash Group Buy price;
4. after the cash Group Buy price is final, derive the Group Buy card price using the same versioned card-uplift rule.

Example with a 10% Group Buy tier:

`group_buy_cash = cost × 1.40 × 0.90 = cost × 1.26`

Cash gross margin:

`(1.26C - C) / 1.26C = 20.6349%`

Therefore a 10% Group Buy discount is **not inherently incompatible** with the locked 20% margin floor. The separate $100 minimum-profit floor can still be the binding constraint on lower-cost items.

Ignoring rounding and the dollar-profit floor, the margin-only maximum discount from a 40% markup price before reaching exactly 20% gross margin is approximately **10.714%**.

### Group Buy storefront display

The primary Group Buy price shown to the customer is the **Group Buy card price**.

The **Group Buy cash price** is shown as the discounted cash-equivalent price.

Buy Now comparisons must compare like with like:

- Group Buy card price vs Buy Now card price for headline/customer savings;
- Group Buy cash price vs Buy Now cash price when presenting cash-specific savings.

Do not compare a cash Group Buy price to a card Buy Now price and label the difference as Group Buy savings.

## 7. Manual overrides

A manual selling-price override is an override of the authoritative **cash price**.

The override workflow must evaluate and display cash profit, cash gross margin, and violated cash floors. After the override is accepted, derive the card price from the overridden cash price using the active versioned card-uplift rule.

## 8. Naming

Prefer explicit names at boundaries and customer-facing DTOs:

- `cashPrice`;
- `creditCardPrice`;
- `groupBuyCashPrice`;
- `groupBuyCardPrice`;
- `buyNowCashPrice`;
- `buyNowCardPrice`.

Legacy generic fields such as `price` may remain internally where a safe migration is required, but their meaning must be documented as authoritative cash price and they must not be used ambiguously at storefront boundaries.
