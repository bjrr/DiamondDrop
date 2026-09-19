# CaratForUs

CaratForUs is a U.S.-based, Shopify-centered jewelry business built around three core purchase paths:

1. **Buy Now** — jewelry with current dynamically calculated pricing.
2. **Community Group Buy** — standardized campaigns with transparent tiered pricing.
3. **Custom Jewelry** — guided intake, manual consultation/quoting, CAD/specification approval, and Shopify checkout.

MVP1 also includes two focused programs built on those core paths:

- **Luxury Steals** — limited-availability extreme-value merchandising using normal Shopify inventory/checkout with special Final Sale rules.
- **Let Us Beat Your Quote!** — competitor-offer acquisition and review workflow connected to Custom Jewelry and eligible regular purchases.

## Source of Truth / Policy Precedence

This README is the consolidated product and architecture overview. Detailed locked policy documents under `docs/` control their respective domains and must be read before implementation.

Authoritative MVP1 policy documents:

- `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md` — Buy Now discretionary returns, RMA eligibility/deadlines, refund/merchandise-credit remedies, return shipping, evidence, and dispute records.
- `docs/LUXURY-STEALS.md` — Luxury Steals inventory/scarcity, Final Sale rules, required disclosures/acknowledgments, claim separation, and evidence.
- `docs/LET-US-BEAT-YOUR-QUOTE.md` — competitor custom quotes, active online listings, competing Group Buys, verification, guarantee/fallback eligibility, acknowledgments, and evidence.
- `docs/WARRANTY-CLAIMS.md` — 1-year limited manufacturing warranty claim intake, authorization, inbound shipping, inspection, coverage decision, remedies, and evidence.
- `docs/BANK-CARD-PRICING.md` — locked Bank Payment Price vs Regular/Card Price policy, tiered card-price increases, $5 card-price rounding, eligible bank-payment methods, checkout behavior, and customer-facing savings display.
- `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` — locked post-Slice-1 owner decisions for recalculation cadence/failures, Buy Now price placement, Group Buy payment selection/display, and the future campaign-options JSON contract.
- `docs/CASH-CARD-PRICING.md` — superseded historical policy retained only for reproducibility of earlier versioned calculations.

If a detailed locked policy document conflicts with a summary in this README, **the applicable locked policy document controls**. Do not silently change a locked decision. Unsettled details must not be invented or converted into customer promises.

## Core Value Proposition

CaratForUs combines strong jewelry value with U.S.-based accountability, pre-delivery quality inspection, domestic support, warranty service, transparent specifications, and a simpler buying experience.

Primary positioning:

**Better value. Better protection. Better buying experience.**

Supporting concept:

**Jewelry pricing that makes sense. Service that stays close to home.**

CaratForUs should compete for customers who might otherwise buy directly from overseas sellers without presenting itself as a broker or middleman. Primary marketing should generally focus on customer benefits rather than factories, manufacturers, China, or the upstream supply chain.

Brand-wide reasons to choose CaratForUs include U.S.-based accountability, QC before delivery, domestic support, reduced overseas-buying burden, transparent pricing, clear specifications, warranty/after-sale support, and one accountable seller.

## MVP1 Architecture Principle

Use Shopify for commodity commerce and custom-build only CaratForUs-specific gaps.

Prefer Shopify-native capabilities for:

- storefront and Online Store 2.0 primitives;
- cart and checkout;
- customer accounts;
- orders and order history/status where practical;
- payments;
- standard transactional commerce behavior;
- normal product inventory, including Luxury Steals where practical.

Custom functionality is justified for:

- structured jewelry cost/pricing engine;
- Group Buy campaign/tier engine and qualifying-unit counts;
- frozen Group Buy pricing snapshots;
- variant-aware Group Buy pricing and final-price/refund ledger;
- custom-design intake and approval evidence;
- RMA/return workflow and evidence required by locked policy;
- Luxury Steals acknowledgment/evidence where Shopify does not provide the required record;
- Let Us Beat Your Quote intake, verification workflow, eligibility calculations, acknowledgments, and evidence;
- warranty claim intake/workflow/evidence;
- admin controls required for those records.

Avoid premature headless commerce, microservices, complex event infrastructure, and unnecessary SaaS dependencies.

## Core Product & Pricing Architecture

### Master Product Definition

Each jewelry design should have a structured master product definition containing, as applicable:

- category/design metadata;
- CAD files, renderings, photos, videos, and manufacturing notes;
- base metal type and finished weight;
- center, accent, and side-stone specifications;
- stone type, natural/lab status, shape, dimensions, carat, color, clarity, cut/quality, certification, and supplier;
- moissanite/colored-gemstone specifications;
- manufacturing complexity/labor;
- packaging, shipping, insurance, warranty reserve, and other product-cost assumptions; the Bank Payment Price remains the underlying calculated selling price and the bank-vs-card feature does not alter that base calculation;
- Shopify/SKU mappings;
- historical pricing/campaign snapshots.

### Cost Component Libraries

Support independently configurable costs for precious metals, lab/natural diamonds by specification and shape, moissanite, colored gemstones, accent stones, CAD, casting, setting, polishing, assembly, QC, packaging, shipping, insurance, warranty, and supplier-specific costs.

Diamond/gemstone pricing must not assume all shapes cost the same.

### Pricing Profiles

Support separate profiles such as Group Buy, Buy Now, Custom Order, Wholesale, Friends & Family, and marketplace channels. Profiles may have distinct margin, minimum-profit, fee, and rounding rules.

All money calculations must be deterministic and auditable. Do not use binary floating point for money.

### Buy Now Pricing

Buy Now prices derive from current cost data rather than permanent hard-coded prices. The authoritative underlying selling price is the **Bank Payment Price**. Inputs may include metal, stones, labor/manufacturing, packaging, shipping/insurance, warranty reserve, other allocated product costs, and required margin/minimum profit.

The bank-vs-card feature must leave the Bank Payment Price unchanged. The **Regular/Card Price** is derived afterward from the Bank Payment Price using the locked tier table: under $500 = +5.0%, $500–$999.99 = +4.5%, $1,000–$2,499.99 = +4.0%, $2,500–$4,999.99 = +3.5%, and $5,000+ = +3.0%. The tier is selected from the Bank Payment Price only. After applying the tier increase, round the Regular/Card Price **up to the next $5 increment**, leaving the Bank Payment Price untouched. The Regular/Card Price is the primary website price; show **Bank Payment Price** and the exact dollar savings alongside it. Never display the internal percentage or describe it as a card fee/surcharge. See `docs/BANK-CARD-PRICING.md`.

Recalculate on a daily schedule and also immediately when a material pricing input changes, then synchronize approved prices to Shopify. Do not rely on redundant scheduled runs when no input changed.

Automatic Shopify publication is enabled only after the real sync path passes money-critical integration tests. Bank Payment Price changes of **2% or less** may then auto-publish; larger changes require admin approval. Large common-input events may be bulk-approved, but rejection is per item/variant with an explicit replacement override price. Temporary overrides expire on the next material pricing recalculation unless marked **Never Expire**.

If Shopify cannot publish a newly approved price, the currently published Shopify price remains authoritative and sellable for up to 48 hours while synchronization retries. Persistent failure is surfaced by email and embedded-admin alert; after 48 hours only the affected variant becomes unavailable until sync succeeds.

### Buy Now customer-facing placement

Collection/search discovery cards lead with the **lowest currently purchasable Bank Payment Price** as **"As low as $X"**, clearly labeled Bank Payment Price. Do not use unavailable variants to advertise a lower starting price.

On the detailed product page, show the exact selected-variant **Price** (Regular/Card Price), **Bank Payment Price**, and exact dollar savings. Provide two add-to-cart actions: **Add to Cart** and **Add to Cart with Bank Payment Discount**. The latter immediately switches the entire cart to Bank Payment mode and reprices every eligible line. Normal Add to Cart preserves the cart's existing mode.

In cart, calculate Bank/Card pricing per line item and sum the line totals; never choose a new uplift tier from the combined cart subtotal. The cart has one payment mode at a time and presents **Card Checkout** and **Bank Payment Checkout** when the customer is ready to purchase.

Eligible Bank Payment methods are Zelle, ACH, bank transfer, and wire only. No checks, money orders, cashier's/certified checks, or other paper payments qualify. Customers may always choose Bank Payment as the payment method, even when a specific item is not eligible for the lower Bank Payment Price. **Bank Payment Discount eligibility is a separate product/variant flag and defaults ON.** Ineligible lines remain at Regular/Card Price even in Bank Payment mode. Bank Payment savings apply to merchandise only, not tax, shipping, duties, or other non-merchandise charges.

### Buy Now pricing-failure protection

If recalculation fails because required pricing/configuration data is missing or invalid, notify admin immediately and keep the last valid published price live for up to **48 hours**. The timer begins at the first unresolved failure and is not reset by retries. If unresolved at 48 hours, make only the affected variant unavailable/out of stock. When the issue is corrected, recalculate immediately and automatically restore the variant after a successful valid price publication. Open Group Buy pricing remains governed by its frozen campaign snapshot and is not invalidated merely because current Buy Now recalculation failed.

## Group Buy — Locked MVP1 Direction

### Frozen Campaign Pricing

When a campaign opens, freeze/version its applicable cost inputs, pricing assumptions, tier thresholds/percentages, and eligible-variant prices. Market changes after opening must not retroactively alter campaign tier prices.

There is **no mandatory minimum buyer/unit count**. One qualifying unit can proceed at Tier 1.

### Tier Model

Default: **3 tiers**, configurable from **2 to 5** per campaign.

Group Buy discounts are percentage-based and apply to the frozen campaign **Bank Payment Price** for the selected eligible variant:

**Variant Group Bank Payment Price = Frozen Campaign Bank Payment Price × Applicable Group Buy Tier Percentage**

After the Group Buy Bank Payment Price is final, derive its Regular/Card Price using the same Bank-vs-Card tier schedule based on that Group Buy Bank Payment Price, then round only the Regular/Card Price up to the next $5 increment. Refund calculations remain payment-basis aware. See `docs/BANK-CARD-PRICING.md`.

Thresholds use **campaign participation units**, not unique buyers. Three eligible pieces purchased by one customer count as three units. A placed Group Buy order counts toward public campaign progress immediately, including a pending Bank Payment order. Public progress is cumulative and monotonic: later nonpayment, cancellation, or refund does **not** reduce the displayed unit count or roll back an already unlocked tier. Payment/refund status is tracked separately for settlement and reconciliation.

Before publication, validate every allowed variant against configured minimum gross-margin percentage, minimum dollar profit, and any variant-specific floor. Unsafe tiers must be blocked or require an explicit authorized override.

### Variant Weight / Ring-Size Model

For products whose weight changes predictably:

**Calculated Weight = Base Weight at Base Ring Size + ((Selected Size - Base Size) × Weight Added per Full Size)**

Half sizes use proportional increments. Support exact finished-weight overrides where linear estimation is inappropriate. Reuse the base-plus-increment model for chains, bracelets, necklaces, bands, and other suitable products.

Default customer-facing ring pricing bands:

- Size 2–6
- Size 6.5–8
- Size 8.5–11

Internal cost still evaluates expected weight by exact size. Bands are configurable per product and should use a safe cost basis so the highest-cost size in the band remains profitable.

### Ring Size / Metal UX

Ring products should provide a Find Your Ring Size guide with U.S. whole/half sizes, common international conversions, diameter/circumference guidance, measurement instructions, and wide-band fit warning. Products define allowed size range/increment, base size, quarter/custom-size availability, resizing restrictions, and notes.

Supported metal library includes Sterling Silver, 10K, 14K, 18K, and Platinum. Product creators explicitly choose which metals each product offers. Metal selection connects directly to pricing/variants. Product pages should provide compact education only for offered metals.

### Live Savings / Progress

Active Group Buy pages should show:

- qualifying units sold;
- current tier/percentage;
- next threshold and units needed;
- the selected configuration's current **Group Buy Regular/Card Price** as the default/public price;
- a concise note that **lower pricing is available with Bank Payment**;
- selected variant's current **Buy Now Regular/Card Price** as the like-for-like Group Buy comparison;
- current dollar/percentage Group Buy savings;
- next-tier price and additional savings;
- countdown/time remaining;
- configured tier markers.

At the final tier show **Best Price Unlocked**. Do not use crowdfunding-funded percentages or imply a minimum is required.

Core message:

**Join now. If the group unlocks a lower price later, your final price drops too.**

### Group Buy Final Price / Refunds

If a lower tier is ultimately reached, earlier participants receive the same final eligible-variant price. Tier-price adjustments are refunded to the original payment method where supported, not store credit.

Calculate/store refund due at order/line-item/variant level, hold it through production/QC, and process at shipping. Maintain an auditable, idempotent refund ledger with campaign/order/customer/payment references, original and final prices, refund amount/status, processor references, failures, overrides, and history.

### Group Buy Options / Cart

Group Buys are standardized, not custom-design orders. Customers choose only campaign-approved options. Do not provide a free-form design-change field. An optional order note is logistics/clarification only.

Group Buy option dimensions are **campaign-specific**. Rings, bracelets, necklaces and other product types may expose different option sets. The application must not hard-code one universal ring-shaped form.

A Group Buy may present all offered configurations in a comparison/options table. That table shows the **Regular/Card Group Buy Price** for each displayed configuration and a concise note that lower pricing is available with Bank Payment; do not show both prices in every table row.

After the customer chooses the applicable product options/configuration, **Payment Type is required before ordering**:

- Credit / Debit Card -> active displayed price remains the Regular/Card Price.
- Bank Payment -> active displayed price changes to the Bank Payment Price.

Eligible Bank Payment methods are Zelle, ACH, bank transfer and wire. Only one active price should be shown at a time in the Group Buy ordering flow.

Each materially different configuration must remain a separate Shopify line item. Quantity greater than one is allowed only for the same exact configuration. Tier qualification and cancellation/refund calculations operate at line-item/unit level.

Campaign option definitions will ultimately be supplied to the admin/campaign tool through a **versioned JSON format** describing allowed option dimensions, values, valid combinations, table-view configuration and ordering-flow configuration. The JSON does not define pricing formulas, Bank/Card tiers, margin floors, payment fees or ad-hoc pricing rule ids. The exact formal JSON Schema is intentionally deferred until the Group Buy campaign creation/upload tooling is implemented (expected Slice 6).

### Group Buy Cancellation / Final Sale

Group Buy cancellations before close require staff approval for MVP1.

A placed Group Buy order counts toward public campaign progress immediately, including a pending Bank Payment order. **Public campaign count and unlocked tier never move backward because a later order is unpaid/canceled.** Once a tier is unlocked, it remains unlocked. Do not expose another customer's cancellation in public progress or reprice other customers upward because someone failed to pay.

At close, the order becomes committed with no discretionary cancellation/return. Defects, wrong specifications, shipping damage, warranty, and fulfillment failures are separate claim paths.

### Group Buy payment timing and close settlement

A pending Group Buy Bank Payment order counts toward progress immediately. Payment has an initial 48-hour window plus one automatic 48-hour extension. After 96 hours unpaid, the order may become inactive internally, but public count and unlocked tier remain unchanged. While the campaign is open, the customer may email to request reactivation of the same order at its original locked price. After campaign close, any reactivation is discretionary and handled by staff.

At campaign close, all earlier paid orders receive the final unlocked tier price on their original payment basis. The system calculates tier-adjustment refunds but does **not** issue them automatically. Admin receives a per-order and campaign-level settlement report, explicitly approves refunds, and processes them back to the original payment method/basis. Unpaid/inactive orders appear separately for reconciliation and do not receive refunds.

### Campaign / Order Status

Campaign stages: Open → Closed → In Production → Quality Inspection → Shipping → Completed.

Order states may include Order received, Campaign open, Final price confirmed, Refund pending, In production, QC complete, Shipped, Refund issued, and Delivered. Automate where practical; retain manual override with audit history.

### Group Buy Sharing / Notifications / Archive

MVP1 includes lightweight Share/Copy Link/native share flows and practical channels such as text, email, WhatsApp, Facebook, Instagram, and TikTok where supported. Do not require complex social direct-post APIs.

Email participants at meaningful milestones such as tier unlock, best-tier unlock, campaign close/final price, and optionally when very close to the next tier. Do not email for every unit change.

Maintain a public Past Group Buys archive preserving actual final unit count and historical starting/final unlocked price. Homepage may show the five most recent. Completed products may later sell as Buy Now at current pricing.

Completed campaigns support low-friction **Bring It Back / Notify Me If It Returns** interest capture. Also provide a simple **Request a New Group Buy** form; do not turn either into a custom-design questionnaire.

## Buy Now Returns — Consolidated Current Policy

The authoritative implementation is `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`.

Key current rules:

- An approved **RMA is required** before a discretionary Buy Now return is sent.
- The eligibility clock starts from the **carrier-confirmed delivery date**.
- **Days 0–7:** customer must request the RMA within 7 calendar days; eligible merchandise must be received by CaratForUs no later than Day 14 after original delivery to qualify for the standard refund to the original payment method, subject to condition/eligibility.
- **Days 8–30:** an otherwise eligible discretionary return may receive either (a) refund to the original payment method subject to a **50% restocking fee** — customer receives 50% of the eligible merchandise amount — or (b) **100% merchandise credit** for the eligible merchandise amount. Once approved, merchandise must be received within 10 calendar days after RMA approval unless a documented exception or applicable law requires otherwise.
- **After Day 30:** no discretionary Buy Now return.
- Engraved, resized, altered, personalized, customized, or otherwise restricted Buy Now items are not eligible for discretionary return when the applicable restriction was properly disclosed.
- Customer pays return shipping for an authorized discretionary return and must use tracking and appropriate insurance as required by the authoritative policy/instructions.
- Separately purchased expedited/optional outbound shipping is non-refundable for discretionary returns as defined in the authoritative policy.
- Defects, wrong item/specifications, transit damage, materially-not-as-described issues, non-delivery, payment errors, and warranty matters are **separate claim workflows** and must not automatically receive a discretionary-return restocking fee.

Do not reintroduce the obsolete rule that Days 8–30 are “store credit only.”

## Luxury Steals — MVP1 Locked Direction

The authoritative implementation is `docs/LUXURY-STEALS.md`.

Customer-facing name: **Luxury Steals**.

Positioning direction:

**Exceptional jewelry. Exceptional prices. Very limited quantities.**

**Once they're gone, they're gone.**

Luxury Steals uses normal Shopify Buy Now inventory/checkout wherever practical but has separate merchandising and return rules.

Core requirements:

- real limited inventory;
- no fabricated scarcity;
- no overselling/backorders;
- zero inventory becomes sold out/unavailable;
- “Only X left” only when supported by actual inventory;
- assigned Luxury Steal pricing must be explicit/auditable;
- no fabricated comparison prices/savings;
- additional coupons apply only when an authorized promotion explicitly includes Luxury Steals;
- Let Us Beat Your Quote fallback discounts are excluded unless policy later changes.

**All Luxury Steals purchases are Final Sale: no discretionary returns, exchanges, cash refunds, or merchandise-credit returns.**

Final Sale must be conspicuously disclosed and affirmatively acknowledged through an unchecked/non-bypassable acknowledgment before the applicable purchase can complete. Retain exact acknowledgment text/version, timestamp, product/variant/order/cart reference as available, and affirmative acceptance.

Final Sale does not automatically deny legitimate defect, wrong-item/specification, transit-damage, materially-not-as-described, non-delivery, payment-error, warranty, or legally required claims. Those remain separate workflows.

## Custom Jewelry — MVP1 Locked Direction

### Intake

The initial request is free and intentionally low-friction. Required contact fields: first name, last name, email, phone.

Starting point:

- existing CaratForUs design; or
- **I have my own idea / Starting from scratch**.

Optional multiple inspiration uploads should support common image formats and PDF sketches where practical.

Required free-text prompt should let the customer explain what they want to create/change. Structured fields should remain limited to high-value qualifiers such as jewelry type, approximate budget, and desired completion date/no deadline.

Follow-up preference:

- Schedule a consultation meeting; or
- Please contact me.

On submission, create a project/reference, store answers/uploads, send customer confirmation, notify CaratForUs, and **do not charge the Design Deposit yet**.

### $49 Design Deposit

When CaratForUs is ready to begin actual design/CAD work, charge a **$49 Design Deposit**.

- Credit it toward the final jewelry price if the customer proceeds.
- If CaratForUs completes the agreed design/CAD stage and the customer declines to proceed, refund the $49 with no questions asked.
- If the customer abandons before the agreed design stage is completed or stops responding, refund is not automatic and may depend on work completed/circumstances.

### Final Approval / Purchase

MVP1 uses email for consultation, revisions, and general communication rather than a full customer project portal.

When ready, staff creates a customer-specific Shopify approval/purchase page from a reusable template showing final CAD/renderings/design images, product/specifications, metal, stones, dimensions/size, engraving, construction notes, final price, $49 credit, balance, estimated timeline, warranty, shipping, and final-sale terms.

Before checkout, require affirmative unchecked approval that the customer reviewed and approved the displayed design/specifications and material terms. Preserve the exact page/spec version, CAD/media references, acknowledgment text/version/timestamp, final specs, price/deposit credit, and Shopify order/payment references.

Once final design/specifications are approved and the jewelry is purchased, the Custom Jewelry order is final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the approved design/specifications.

A richer project portal remains Post-MVP.

## Let Us Beat Your Quote! — MVP1 Locked Direction

The authoritative implementation is `docs/LET-US-BEAT-YOUR-QUOTE.md`.

The program lets customers submit:

1. a custom jewelry quote;
2. an item currently for sale online; or
3. a competing Group Buy.

### Guarantee-Eligible Recent Custom Quote

A genuine, verifiable, materially comparable custom jewelry quote issued within the **7 calendar days immediately preceding submission** can qualify for the full guarantee.

For a qualifying verified recent custom quote, CaratForUs will match or beat the competitor's **jewelry price itself**, or, if CaratForUs cannot, issue **10% off one eligible CaratForUs purchase, capped at $100**.

The fallback is single-use, non-transferable, has no cash value, is generally non-stackable unless expressly authorized, expires after **90 days**, and excludes Group Buys and Luxury Steals unless policy changes.

### Older Custom Quotes

Quotes older than 7 calendar days remain reviewable leads. CaratForUs may voluntarily match/beat them, but there is **no guaranteed match/beat and no 10%-off fallback**.

### Active Online Listings

Active online listings are accepted for review and verification, but under the current locked policy they are **review-only**: no guaranteed match/beat and no 10%-off fallback. A customer screenshot alone does not establish a live/verifiable offer.

### Competing Group Buys

Active competing Group Buys are accepted for discretionary review but carry **no guaranteed match/beat and no fallback**.

### Comparison / Verification Principles

The comparison is the jewelry price for a materially comparable piece. CaratForUs does not promise to match competitor production timeline, return/cancellation policy, warranty, shipping terms, payment terms, promotions, or other service terms. CaratForUs's own terms apply to any resulting purchase.

Overseas sellers are eligible for review. Do not add hypothetical customs/import charges merely to make CaratForUs appear cheaper, and never participate in or advise inaccurate customs declarations.

Require sufficient authentic CAD/design/specification and pricing/seller evidence for guarantee eligibility. Fabricated, altered, AI-generated fake, forged, unverifiable, non-comparable, or otherwise non-qualifying evidence does not trigger the guarantee/fallback.

MVP1 review is manual. Automate intake, quote-age calculation, evidence capture, status, acknowledgment/version storage, and duplicate-benefit prevention where practical; do not auto-commit CaratForUs to a competitor price.

Required material acknowledgments must be explicit, unchecked/non-bypassable, versioned, timestamped, and retained as evidence.

## 1-Year Limited Manufacturing Warranty — Consolidated Current Policy

The authoritative workflow is `docs/WARRANTY-CLAIMS.md`.

The warranty applies across Buy Now, Group Buy, Custom Jewelry, and Luxury Steals where applicable. It covers qualifying manufacturing defects in materials, construction, setting, or assembly under normal use. It does not cover normal wear, scratches, dents, impact damage, bent/worn prongs caused by use, stone loss caused by damage/wear, misuse, improper care, sizing changes, unauthorized third-party repairs/modifications, loss, theft, or other non-covered damage.

MVP1 requires a dedicated Warranty Claim Form/equivalent intake. Submission does not itself establish coverage. The customer must receive authorization/instructions before sending jewelry for inspection.

For an authorized warranty inspection, the **customer pays inbound shipping to CaratForUs** and must use tracking and appropriate insurance under the locked policy. CaratForUs inspects the item after receipt and determines coverage and the appropriate remedy. For a valid covered claim, CaratForUs may choose repair, replacement, refund, or another appropriate resolution subject to applicable law/platform rules.

A possible CaratForUs-authorized local-jeweler repair is an **internal service option**, not a customer-facing entitlement. Do not advertise or promise it before CaratForUs chooses it for a specific claim. Unauthorized third-party work/expense is not automatically reimbursable.

Final Sale status does not automatically eliminate a legitimate covered warranty claim.

## Customer Acknowledgment / Evidence Architecture

Chargeback/dispute defensibility is a core design requirement, but policies must not be represented as overriding rights required by law, card networks, or payment processors.

Material terms should be conspicuous in context rather than buried only in Terms. Use explicit unchecked acknowledgments for unusual/high-risk terms such as Group Buy commitment/final-sale terms, Custom Jewelry final approval, Luxury Steals Final Sale, and Let Us Beat Your Quote material terms.

Preserve as applicable:

- exact acknowledgment text/version and policy version;
- timestamp and affirmative action;
- customer/account/order/project/campaign/submission references;
- exact product/variant/configuration;
- product/media/specification snapshot;
- price charged and applicable pricing/campaign snapshot;
- custom CAD/spec approval evidence;
- RMA/claim/warranty records;
- customer communications;
- QC records/photos where practical;
- carrier/tracking/delivery/signature evidence;
- refund/credit/benefit references and audit history;
- manual overrides and reasons.

Later edits to live product/policy/design pages must not overwrite historical transaction evidence. Duplicate/retried refund, credit, warranty-remedy, or promotional-benefit processing must not create duplicate customer value.

## Shipping, Insurance & Signature — MVP1 Locked Direction

- Every outbound customer shipment is insured for the full order value.
- Every shipment has tracking.
- Any shipment with order value **above $100** requires signature confirmation.
- Customers may not waive required signature above $100.
- Orders at $100 or less may ship without signature unless CaratForUs requires stricter controls.
- Use the checkout/payment-approved shipping address unless a later change is explicitly reviewed/documented.
- Post-order address changes require audit history.
- Store carrier/service, tracking, ship date, insured value/reference where available, signature flag, delivery evidence, address, changes, and claim/exception references.
- Shipping/insurance costs must be represented in pricing so they do not silently erode margin.

## Product Visuals / Technical Details

Products may use actual photos/videos, CAD renders, dimensioned CAD, clearly labeled AI visualizations, and optional manufacturer-provided media.

Required distinctions:

- **Actual Product Photo**
- **Actual Product Video**
- **CAD Rendering**
- **CAD Dimensions**
- **AI Visualization — final appearance may vary slightly**

Never present AI-generated media as a photograph/video of a finished manufactured item.

## FAQ / Trust Architecture

Use centrally managed FAQ content with categories such as Group Buys, Pricing & Refunds, Production & Delivery, Materials & Stones, Ring Sizing, Custom Jewelry, Warranty & Repairs, Returns & Cancellations, Payments, and Shipping & Insurance.

Allow reusable contextual FAQs on product pages and product-specific entries when truly needed. Keep Group Buy explanations concise and link to fuller help content.

## MVP1 Customer-Facing Scope

MVP1 includes:

- Shopify storefront and Buy Now product pages;
- active Group Buy pages with tiers, progress, countdown, live savings, timeline/status, sharing, milestone email, and standardized variants;
- Past Group Buys, Bring It Back, and Request a New Group Buy;
- product media/CAD/dimensions/labeled AI visuals;
- ring-size guide and metal education;
- Shopify checkout/customer accounts/order behavior where practical;
- purchase-path-specific disclosures/acknowledgments and transaction snapshots;
- Buy Now RMA/return flow;
- Custom Jewelry intake, uploads, $49 Design Deposit, email-driven design process, and final Shopify approval/purchase page;
- Luxury Steals collection/merchandising, scarcity/inventory controls, Final Sale acknowledgment/evidence;
- Let Us Beat Your Quote intake/review/verification/evidence flow;
- 1-year limited manufacturing warranty and warranty claim form/workflow;
- tracked/insured shipping and signature controls;
- FAQ, policies, contact, About, and Why Buy From Us content.

## Required Internal Records / Admin Support

MVP1 must retain/support as applicable:

- immutable order/configuration/policy snapshots;
- material acknowledgment logs/versioning;
- Group Buy pricing snapshots, qualifying-unit history, cancellations, and tier history;
- Group Buy refund ledger/processor references;
- Buy Now RMA/inspection/refund/credit evidence;
- Luxury Steals inventory/acknowledgment/claim evidence;
- Custom request/intake/uploads and final CAD/spec approval;
- Let Us Beat Your Quote submission/verification/eligibility/decision/benefit records;
- warranty claim/authorization/shipping/inspection/remedy evidence;
- QC evidence;
- shipping/tracking/full-value insurance/delivery/signature evidence;
- customer communications where available;
- manual dispute-evidence packet assembly;
- idempotent processing and complete audit history for value-moving operations.

## Post-MVP / Backlog

Unless later promoted by an owner-approved decision:

- voting on the next Group Buy;
- customer photo upload/moderation and completed-order galleries;
- buyer map/geographic social proof;
- referral/affiliate rewards;
- SMS/push milestone notifications;
- advanced gamification/streaks/check-ins;
- complex direct-post social integrations;
- rich Custom Design customer portal with message history, revision tracking, file exchange, and customer dashboard.

## Payment Strategy

The **Bank Payment Price** is always the underlying calculated selling price. The bank-vs-card feature must not discount, inflate, or round that value.

Derive the **Regular/Card Price** from the Bank Payment Price using the locked price tiers in `docs/BANK-CARD-PRICING.md`, then round only the Regular/Card Price **up to the next $5 increment**. The Regular/Card Price is the primary advertised price. Show the Bank Payment Price and the exact savings amount, calculated as final rounded Regular/Card Price minus Bank Payment Price. Do not display the internal percentage or call the difference a credit-card fee/surcharge.

Eligible Bank Payment methods are Zelle, ACH, bank transfer, and wire. Bank Payment itself remains available even for merchandise that is not Bank Payment Discount eligible; ineligible lines simply remain at Regular/Card Price.

For Buy Now, the product page uses **Add to Cart** and **Add to Cart with Bank Payment Discount**. The cart preserves one payment mode and offers **Card Checkout** and **Bank Payment Checkout**. Buy Now and Group Buy items must not share one cart/order.

For Buy Now Bank Payment orders, the quoted Bank Payment Price is guaranteed for 24 hours. After that, an unpaid order may remain open only while the underlying price is unchanged; any subsequent price change cancels the unpaid order and triggers a cancellation email. Inventory is not reserved until Bank Payment is received and manually verified by admin. The Bank Payment checkout page and confirmation email must state that the order is not committed and availability is not guaranteed until payment is received and verified.

See `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` for the authoritative operational rules.

## Guiding Rule

If a feature does not help CaratForUs launch sooner, protect pricing/margins, drive acquisition/conversion, or materially improve customer experience, it belongs in the backlog.
