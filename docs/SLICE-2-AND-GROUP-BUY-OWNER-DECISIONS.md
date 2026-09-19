# Slice 2 / Group Buy Owner Decisions — 2026-09-19

## Status

**LOCKED OWNER DECISIONS.**

This document records owner decisions made after Slice 1 acceptance so Slice 2 and later Group Buy work do not have to rediscover or infer them.

Where this document conflicts with older summaries, this document controls for the decisions below.

## 1. Bank/Card tier-boundary inversions are intentional

The Bank Payment Price is always lower than its own Regular/Card Price.

However, when a recalculated Bank Payment Price crosses a Bank/Card pricing threshold, the Bank Payment Price may move up while the Regular/Card Price moves down because the applicable percentage changes.

Example:

- old Bank Payment Price: $999.99 -> Regular/Card Price $1,045
- new Bank Payment Price: $1,000.00 -> Regular/Card Price $1,040

This behavior is an intentional consequence of the locked tier schedule, not a pricing error.

**Decision:** do not force manual approval merely because Bank Payment Price and Regular/Card Price move in opposite directions at a tier boundary. Normal auto-apply tolerance remains based on the Bank Payment Price movement unless a separate later owner decision changes it.

## 2. Recalculation cadence

Use:

- one scheduled recalculation daily; and
- immediate recalculation when a material pricing input changes.

Material pricing inputs include, as applicable:

- metal reference price;
- stone cost;
- labor/manufacturing rate;
- supplier/product cost input;
- pricing-relevant weight/configuration;
- other owner-approved pricing inputs.

Do not run redundant scheduled recalculations merely to simulate freshness when no source input changed.

## 3. Buy Now customer-facing price placement

### Collection and search pages

The discovery price is the **Bank Payment Price**.

Display:

**As low as $X**

with a clear nearby label indicating that the amount is the **Bank Payment Price**.

Rules:

- "As low as" is the lowest Bank Payment Price among currently purchasable eligible variants.
- Do not use an unavailable configuration to create a lower advertised price.
- The collection/search card does not need to show the Regular/Card Price alongside it.
- The detailed product page must clearly disclose both prices before purchase.

### Product page

For the selected variant/configuration display:

- **Price: $RegularCardPrice**
- **Bank Payment Price: $BankPaymentPrice**
- **Save $Savings with Bank Payment**

Savings are calculated after Regular/Card Price rounding.

### Cart

For each selected line/configuration display the exact:

- Regular/Card Price;
- Bank Payment Price; and
- applicable Bank Payment savings.

Cart totals follow §5 below.

## 4. Eligible Bank Payment methods

Eligible methods are:

- Zelle;
- ACH;
- bank transfer; and
- wire transfer.

**No paper payments are eligible.**

Specifically excluded:

- personal checks;
- cashier's checks;
- certified checks;
- money orders; and
- any other paper-payment instrument.

Future payment methods require an explicit owner decision/configuration change.

## 5. Cart calculation basis

Bank/Card pricing is determined **per line item/configuration**, not from the combined cart value.

For each line:

1. use that merchandise item's Bank Payment Price;
2. derive that item's Regular/Card Price under the applicable versioned rule;
3. multiply by eligible line quantity as appropriate.

Then:

- Cart Bank Payment Merchandise Total = sum of Bank Payment line totals.
- Cart Regular/Card Merchandise Total = sum of Regular/Card line totals.
- Cart Bank Payment Savings = Regular/Card Merchandise Total - Bank Payment Merchandise Total.

Do **not** determine a new card-uplift tier from the combined cart subtotal.

## 6. Savings apply to merchandise only

Bank Payment pricing/savings apply only to merchandise.

They do not apply to:

- tax;
- shipping;
- separately charged insurance;
- duties; or
- other non-merchandise charges.

Customer-facing "Save $X with Bank Payment" means merchandise-price savings only.

## 7. Recalculation failure handling for Buy Now

A pricing recalculation can fail because required pricing/configuration data is missing or invalid.

Examples include unresolved pricing bands, missing stone costs, invalid weight/size data, missing labor/metal inputs, currency mismatch, or an unavailable required pricing rule/profile.

### Immediate behavior

When a Buy Now variant recalculation fails:

1. do not publish the failed calculation;
2. notify the admin immediately;
3. keep the last valid published price live temporarily;
4. record the first unresolved failure timestamp.

Repeated retries must **not reset** the 48-hour timer.

### 48-hour rule

If the pricing failure remains unresolved for 48 hours after the first unresolved failure:

- make **only the affected variant** unavailable/out of stock;
- do not disable the entire product when other variants remain valid.

Admin visibility should show, at minimum:

- product;
- affected variant;
- failure reason/type;
- first-failure timestamp;
- time remaining before automatic unavailability;
- current resolved/unresolved state.

### Recovery

When the underlying pricing/configuration problem is corrected:

1. recalculate immediately;
2. if the calculation succeeds, publish the valid price according to normal approval/sync rules;
3. automatically restore the affected variant to available;
4. clear the active pricing-failure state;
5. record the resolution timestamp and trigger/actor.

No separate manual re-enable step should be required after a successful pricing recovery.

## 8. Group Buy interaction with recalculation failures

The Buy Now 48-hour stale-price rule does **not** apply to an open Group Buy merely because the corresponding current Buy Now recalculation fails.

Open Group Buy pricing is frozen/versioned for the campaign.

Therefore:

- a Buy Now recalculation failure must not invalidate or hide an otherwise valid open Group Buy;
- if the Group Buy campaign's own frozen pricing/configuration becomes invalid, unreadable, or non-reproducible, treat that as a campaign-critical error and block new joins immediately until corrected.

## 9. Group Buy Bank Payment display and payment selection

Group Buy uses a different presentation from normal Buy Now.

### Public/default Group Buy price

The default/public Group Buy price shown is the **Regular/Card Price**.

Do not show the Bank Payment Price side-by-side as the default presentation.

Show a concise note indicating:

**Lower pricing is available with Bank Payment.**

Do not show the internal Bank/Card percentage, card fee, surcharge, or "cash" terminology.

### Required payment-type selection

After the customer has chosen the applicable product configuration/options, the customer must make a required Payment Type selection before ordering:

- **Credit / Debit Card**
- **Bank Payment**

Behavior:

- Credit / Debit Card selected -> displayed active price remains the Regular/Card Price.
- Bank Payment selected -> displayed active price changes to the Bank Payment Price.

When Bank Payment is selected, the eligible methods may be shown:

- Zelle;
- ACH;
- bank transfer;
- wire.

Only one active Group Buy price should be presented at a time in the ordering flow.

**Correction to existing Slice 1 storefront behavior:** any currently shipped Group Buy block that shows the Bank Payment Price and Bank Payment savings side-by-side with the Regular/Card Group Buy Price by default is stale and must be corrected to this rule before the current pricing/storefront work is considered complete.

## 10. Group Buy options/pricing table

Group Buys commonly show all offered configurations in a comparison/options table before the customer begins the order-selection flow.

Decision:

- the public comparison/options table shows the **Regular/Card Group Buy Price** for each displayed configuration;
- near the table, state that lower pricing is available with Bank Payment;
- do not clutter each table row/cell with both prices;
- when the customer begins ordering and chooses Payment Type, switch the active displayed price according to §9.

The Group Buy savings/progress presentation and Bank Payment savings are separate concepts and must not be blended into one percentage.

## 11. Group Buy option configuration is campaign-specific

There is no universal hard-coded Group Buy option form.

Each Group Buy campaign defines the option dimensions and allowed values applicable to that product.

Examples:

- rings may use stone type, stone size/carat, stone color, clarity/quality, metal, ring size, etc.;
- bracelets may use length, stone size/TCW, metal, clasp/style, width, etc.;
- necklaces may use length, stone size/TCW, metal, chain/style, pendant options, etc.

The application must render from campaign configuration rather than assuming that all products share ring-style fields.

Invalid combinations must not be purchasable.

## 12. Group Buy options JSON contract

Group Buy options will be supplied to the campaign-creation/admin tool in a **versioned JSON format**.

The JSON is responsible for describing **what may be sold**, including:

- schema version;
- product/campaign type metadata as needed;
- option dimensions;
- option labels;
- allowed values;
- required/optional option status;
- display/order sequencing;
- valid combinations/configurations;
- table-view configuration; and
- ordering-flow configuration.

The JSON must **not** define the pricing policy itself.

Do not place the following business rules in campaign-upload JSON:

- Bank/Card uplift tiers;
- margin rules;
- minimum-profit rules;
- internal pricing-rule ids chosen ad hoc by the uploader;
- processor fees;
- Group Buy pricing-engine formulas.

Those remain in the versioned pricing/business-rule system.

The admin upload flow must validate the configuration before campaign publication.

## 13. Formal JSON Schema timing

The architectural contract in §12 is locked now.

The exact formal JSON Schema file (for example, `group-buy-options.schema.json`) is **deferred until the Group Buy campaign creation/upload tooling is implemented**, expected in Slice 6.

Until then:

- do not hard-code ring/bracelet/necklace field sets into reusable Group Buy UI;
- preserve a clean seam for versioned campaign-specific option configuration;
- do not invent the final JSON field names or validation rules prematurely.

## 14. Shopify checkout / bank-payment automation scope

The current Shopify limitation findings remain in force: native checkout does not simply change the payable total because the shopper chooses a payment method.

For current MVP planning:

- do not call the customer-facing price difference a card surcharge;
- do not add paper-payment methods;
- do not silently fake a checkout price switch that Shopify cannot honor.

The exact supported transaction mechanism for carrying the required Group Buy Payment Type selection through cart/checkout remains an implementation design task subject to Shopify platform capabilities and must preserve the owner-facing UX decisions above.


## 15. Shopify publication/sync failures

If a valid newly approved price cannot be published to Shopify:

- keep the last successfully published Shopify price live;
- the currently published Shopify price remains the authoritative sale price until replacement publication succeeds;
- retry synchronization automatically;
- notify admin after repeated/meaningful sync failure through **both email and a persistent embedded-admin alert**;
- start a 48-hour unresolved-sync timer;
- do not mark a sync intent `synced` until Shopify confirms success;
- if still unresolved after 48 hours, make only the affected variant unavailable;
- automatically restore the variant when synchronization later succeeds.

Customers may continue purchasing at the currently published Shopify price during the 48-hour window whether that price is higher or lower than the newly approved price.

If a customer purchases at the currently valid higher published price and a lower price is published later, **do not automatically refund the difference**.

The persistent admin alert should show the affected product/variant, failure type, first-failure timestamp, time remaining before the 48-hour cutoff, latest retry result, and current resolution status.

## 16. Material pricing-input changes

A material pricing-input change means **any persisted change to a field that can affect calculated selling price**. There is no separate dollar/percentage threshold for deciding whether to recalculate.

Examples include:

- metal/reference price;
- stone cost/specification when price-bearing;
- labor/manufacturing rate;
- supplier/product cost;
- product/variant weight;
- pricing profile, markup, margin, or minimum-profit settings;
- manual selling-price override;
- any other persisted input consumed by the pricing engine.

Such a change triggers immediate recalculation of affected variants.

## 17. Automatic publication and approval

After the real Shopify synchronization path has passed its money-critical integration tests:

- enable automatic publication for recalculated **Bank Payment Price changes of 2% or less**;
- changes above 2% require human approval;
- tier-boundary inversion under §1 does not independently force manual approval.

### Bulk approval

When many variants exceed 2% because of the same pricing-input event, such as a large gold-price movement, admin may **Bulk Approve** the batch.

The batch view should summarize the trigger/source, affected item count, price-change range, and safety-check exceptions. Bulk approval may include only variants that passed all required pricing safety checks.

**Bulk Reject is not allowed.**

Rejection is handled item-by-item/variant-by-variant. Rejecting the calculated price requires admin to enter a replacement override price and a reason/comment. Preserve the calculated price and override as separate auditable history.

### Override lifetime

A manual override expires automatically on the **next material pricing recalculation** unless admin explicitly marks the override **Never Expire**.

Record override price, reason, admin, timestamp, expiration mode, and—when applicable—the recalculation event that expired/superseded it.

## 18. Bank Payment pricing eligibility vs. ability to pay by bank

Customers must **always be allowed to pay by Bank Payment**, including customers without a credit card.

Bank Payment Discount eligibility is a separate per-product/per-variant pricing flag:

- default for newly created products/variants: **ON**;
- eligible line + Bank Payment mode -> use Bank Payment Price;
- ineligible line + Bank Payment mode -> keep Regular/Card Price;
- ineligible merchandise does not prevent Bank Payment for the order;
- Bank Payment savings are calculated only from eligible merchandise lines.

Internally, prefer terminology such as **Bank Payment Discount Eligible** rather than language implying that an ineligible item cannot be paid by bank.

## 19. Cart payment mode and repricing

A cart has **one Payment Type/payment mode** at a time:

- Card; or
- Bank Payment.

Do not support mixed payment modes within one cart.

Changing the cart payment mode reprices all eligible merchandise lines consistently:

- Card -> Bank Payment: eligible lines move to their Bank Payment Price;
- Bank Payment -> Card: eligible lines move back to their Regular/Card Price;
- ineligible lines remain at Regular/Card Price in either mode.

If a cart is already in Bank Payment mode, using normal **Add to Cart** on another product does **not** switch the cart back to Card mode. The cart preserves its existing payment mode and the new line receives Bank Payment pricing if eligible.

A customer who selected Bank Payment pricing must never be able to complete a credit/debit-card payment at that lower Bank Payment Price. If the customer changes to Card, the cart/order must reprice to Regular/Card pricing before payment and show the updated total.

### Money-critical test requirement

Payment-mode switching is a money-critical path and requires enhanced automated regression coverage, including:

- Card -> Bank and Bank -> Card repricing;
- repeated switching without compounding/double-discount;
- cart refresh/reload persistence;
- quantity and variant/configuration changes;
- mixed eligible/ineligible merchandise;
- server-side rejection of client-supplied price tampering;
- prevention of Card checkout at Bank Payment pricing;
- exact order/payment-basis snapshot;
- end-to-end cart -> checkout handoff.

Changes to this flow require dedicated regression testing.

## 20. Buy Now product-page and cart actions

The Buy Now PDP uses **two add-to-cart actions**, not product-page checkout buttons:

1. **Add to Cart**
2. **Add to Cart with Bank Payment Discount**

Behavior of **Add to Cart with Bank Payment Discount**:

- add the selected configuration to cart;
- immediately switch the entire cart to Bank Payment mode;
- reprice every Bank Payment Discount-eligible cart line to its Bank Payment Price;
- leave ineligible lines at Regular/Card Price.

The normal **Add to Cart** action preserves the cart's existing mode rather than forcing Card mode.

When the customer is finished shopping, the cart presents **two checkout options**:

- Card Checkout;
- Bank Payment Checkout.

Each path must use the correct cart pricing basis.

Buy Now items and Group Buy items must **not be mixed in the same cart/order**.

## 21. Buy Now Bank Payment price lock and unpaid-order behavior

For Buy Now Bank Payment orders:

- the quoted Bank Payment Price is guaranteed for **24 hours** from order placement;
- customer-facing copy must state that the price is locked for 24 hours and after that is subject to change/not guaranteed;
- if payment is received within 24 hours, honor the locked price;
- after 24 hours, if payment has not been received and the underlying Buy Now price has **not changed**, keep the order open at the existing price;
- after 24 hours, if payment has not been received and the underlying Buy Now price changes by **any amount**, automatically cancel the unpaid order and send a cancellation email;
- the customer must place a new order at the then-current price.

There is no minimum price-change threshold after the 24-hour lock expires: **any change** cancels the unpaid order.

## 22. Buy Now Bank Payment inventory and commitment

Do **not** reserve Buy Now inventory merely because a Bank Payment order was placed.

Customer must be told clearly:

**The order is not committed and item availability is not guaranteed until Bank Payment is received and verified.**

This disclosure must appear:

- on the Bank Payment checkout page; and
- in the order confirmation email.

If payment is later received after inventory sold out, flag the case for admin handling rather than trying to invent an automatic resolution.

## 23. Manual Bank Payment verification

Bank Payment receipt is manual. The system must not assume or auto-detect that funds arrived.

Admin verification is required before an order is considered paid/confirmed.

The shared verification workflow for Buy Now and Group Buy should capture:

- actual amount received;
- Bank Payment method;
- reference/confirmation number when available;
- verification timestamp;
- verifying admin.

Payment proof may remain email/manual for MVP1.

The same underlying admin verification workflow serves Buy Now and Group Buy, with each purchase path applying its own downstream business rules.

## 24. Group Buy pending Bank Payments and tier progression

A Group Buy Bank Payment order counts toward campaign units **immediately when the order is placed**, even before funds clear.

Payment timing:

- initial payment window: 48 hours;
- if unpaid, automatically extend once for an additional 48 hours;
- after 96 hours unpaid, the order may be marked internally inactive/canceled for nonpayment.

Group Buy tier progression is **one-way only**:

- an order that counted toward an unlock is never subtracted from the customer-facing campaign count because it later goes unpaid/canceled;
- an unlocked tier never falls back;
- other customers are never repriced upward because another participant failed to pay;
- do not show another customer's cancellation in public campaign progress.

If an unpaid Group Buy order becomes inactive after 96 hours, the same order remains eligible for staff reactivation while the Group Buy is still open. The customer requests reactivation by email; do not create a replacement order. While the campaign remains open, reactivation preserves the original locked order price.

Once the Group Buy closes, automatic reactivation eligibility ends. A customer may still email CaratForUs, and staff may decide case-by-case whether the order can be fulfilled/reactivated and whether the original price can be honored.

## 25. Group Buy close and tier-adjustment settlement

When a Group Buy reaches a better tier after an order was placed, earlier customers benefit from the lower final tier, including customers who already paid.

At campaign close:

- determine the final unlocked tier;
- calculate the final Group Buy price for every paid order using that order's original payment basis;
- Card-paid order -> Card-basis final Group Buy price;
- Bank-paid order -> Bank-basis final Group Buy price;
- automatically calculate any tier-adjustment refund due;
- **do not automatically send refunds**.

Present an admin settlement report containing per-order detail and campaign-level totals.

Per-order report should include, as applicable:

- customer/order;
- configuration;
- quantity;
- payment basis;
- amount originally charged;
- final Group Buy price;
- refund due;
- payment/refund status.

Campaign summary should include:

- total campaign orders/units used for public progress;
- final unlocked tier;
- total originally charged;
- total final Group Buy value;
- total refunds due;
- Card-paid refunds due;
- Bank-paid refunds due;
- refunds processed;
- refunds outstanding.

Unpaid/inactive orders appear in a separate reconciliation section. An order that was never paid receives no refund calculation.

Refunds require explicit admin approval before issuance. Admin may approve individually or as an approved batch. Record calculated amount, approval, processing status, completion, and processor/reference information.

Tier-adjustment refunds should return money to the original payment method/basis:

- Card-paid -> refund through the original card/payment processor;
- Bank-paid -> refund by an approved bank-payment method.

Merchandise credit is not the default substitute.

## 26. Group Buy scheduled close

A Group Buy stops accepting new orders automatically at its scheduled close time.

Admin may explicitly extend the campaign **before** it closes.

There is no automatic post-close grace period for new orders.

Group Buy customer cancellations before close require **staff approval** for MVP1.

