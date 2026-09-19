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
