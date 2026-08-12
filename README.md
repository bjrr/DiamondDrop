# CaratForUs

CaratForUs is a U.S.-based jewelry business built around three customer purchase paths:

1. Buy Now jewelry with dynamically calculated current pricing.
2. Community-powered Group Buys with transparent tiered pricing.
3. Custom Jewelry requests handled through a guided customer questionnaire and manual quoting.

## Core Value Proposition

CaratForUs combines strong jewelry value with U.S.-based accountability, pre-delivery quality inspection, domestic support, warranty service, and a simpler buying experience.

CaratForUs is not positioned merely as the cheapest option. The brand combines competitive pricing with trust, service, transparency, and after-sale support.

## Why Buy From Us — LOCKED DIRECTION

The Why Buy From Us message must represent CaratForUs as a whole, not only Group Buys. It should apply consistently across Buy Now, Group Buy, and Custom Jewelry purchases.

### Core Positioning

CaratForUs should compete for customers who may otherwise purchase jewelry directly from overseas sellers by offering strong value without requiring customers to accept the uncertainty and service burden of an overseas transaction.

Primary positioning direction:

**Better value. Better protection. Better buying experience.**

Supporting concept:

**Jewelry pricing that makes sense. Service that stays close to home.**

Customer-facing copy should avoid making CaratForUs sound like a broker or middleman. Primary marketing should generally avoid emphasizing factories, manufacturers, China, or CaratForUs's upstream supply chain. Customers should experience CaratForUs as the seller and accountable brand.

### Brand-Wide Reasons to Choose CaratForUs

The marketing story should be built around concrete customer benefits, including:

- **U.S.-based accountability** — customers purchase from CaratForUs, and CaratForUs stands behind the order.
- **Quality inspection before delivery** — jewelry is checked against the ordered specifications before reaching the customer.
- **Domestic support and service** — questions, warranty matters, approved returns, and support are handled through a U.S.-based business.
- **Reduced overseas buying burden** — customers should not have to manage foreign seller communication, customs paperwork, international service coordination, or overseas return logistics where CaratForUs can handle those responsibilities.
- **Transparent pricing** — pricing should be based on the actual product configuration and commercial model rather than inflated comparison prices or artificial retail anchors.
- **Strong value across every purchase path** — competitive Buy Now pricing, additional savings opportunities through Group Buys, and clear/fair quoting for Custom Jewelry.
- **Clear product specifications** — metal, stone quality, dimensions, weights, CAD details, and available options should be clearly defined so customers understand what they are purchasing.
- **Warranty and after-sale support** — customer support continues after delivery within the published warranty/support terms.
- **One accountable company** — customers should not have to determine which supplier, producer, shipper, or outside party is responsible when they need help.

### Channel-Specific Reinforcement

**Buy Now** should emphasize competitive current pricing, U.S.-based accountability, pre-delivery inspection, warranty, and a simpler domestic buying experience.

**Group Buy** should include all brand-wide benefits plus transparent tier progression, community-unlocked savings, and automatic final-price adjustment/refund if a lower tier is reached.

**Custom Jewelry** should include all brand-wide benefits plus guided design support, defined specifications, CAD/design approval, and CaratForUs managing the custom process from request through delivery.

### Overseas-Alternative Message

A deeper section of the site may directly address customers considering an overseas purchase using a message such as:

**Why buy overseas when you can get the value without the uncertainty?**

The narrative should acknowledge that modern jewelry pricing has changed and customers should not need traditional retail markups, while making the case that better value should not require giving up service, accountability, quality inspection, or peace of mind.

Exact campaign copy, headlines, and claims should only be finalized once CaratForUs has confirmed the operational policies that support them.

## Core Product & Pricing Architecture

CaratForUs will be built around a structured jewelry product data model and pricing engine rather than manually maintained selling prices.

### Master Product Definition

Each jewelry design will have one Master Product Definition containing the core engineering and commercial data needed to manufacture and price the item. This may include:

- Product category and design metadata
- CAD files, renderings, photos, videos, and manufacturing notes
- Base metal type and base finished weight
- Center stone specifications
- Accent and side stone specifications
- Stone type, shape, size, carat weight, color, clarity, cut, certification, quality grade, and supplier where applicable
- Moissanite and colored gemstone specifications
- Manufacturing complexity and labor category
- Packaging, shipping, insurance, warranty reserve, payment-cost assumptions, and other configurable cost components
- Shopify and marketplace SKU mappings
- Historical campaign and pricing snapshots

### Cost Component Libraries

Pricing must be built from linked cost components rather than hard-coded product prices. Libraries should support:

- Precious metals: Sterling Silver, 10K, 14K, 18K, platinum and future metals
- Daily market pricing and configurable alloy/casting adjustments
- Lab-grown and natural diamonds by shape, carat, size, color, clarity, cut, certification, and supplier
- Moissanite by shape, size, grade, brand, and supplier
- Colored gemstones by stone type, natural/lab status, shape, size, quality grade, and supplier
- Accent stones by type, shape, size, quantity, total carat weight, and supplier cost
- CAD, casting, setting, polishing, assembly, QC, packaging, shipping, insurance, and warranty costs
- Supplier-specific pricing where the same component may come from different manufacturing partners

Diamond and gemstone pricing must not assume all shapes cost the same. Round, oval, pear, emerald, radiant, cushion, princess, marquise, heart, Asscher, and other shapes must be independently priceable.

### Pricing Profiles

The same product may be priced differently under configurable pricing profiles, including:

- Group Buy
- Buy Now
- Custom Order
- Wholesale
- Friends & Family
- Marketplace channels such as Amazon, Etsy, and TikTok Shop

Each profile may use its own margin, minimum profit, fees, and rounding rules.

### Buy Now Pricing

Buy Now prices are calculated from current cost data and are not permanently hard-coded.

The pricing engine may include:

- Current precious-metal cost
- Current stone costs
- Manufacturing/labor
- Packaging
- Shipping and insurance
- Payment processing
- Warranty reserve
- Other allocated costs
- Required margin and/or minimum profit

Buy Now prices should be recalculated automatically at least daily, with a target of twice-daily precious-metal updates where practical. Updated calculated prices are then synchronized to Shopify.

### Group Buy Pricing

Active Group Buy campaign pricing is frozen for the campaign and must not automatically change as precious-metal or market costs move after customer commitments begin.

When a campaign is opened, store a versioned cost/pricing snapshot including applicable metal prices, stone costs, labor assumptions, fees, margins, and tier prices. This historical snapshot remains associated with that campaign permanently.

There is no mandatory minimum unit count required to complete a campaign. Even one qualifying unit can proceed at Tier 1 pricing.

### Group-Buy Tier Model — LOCKED DECISION

CaratForUs will use percentage-based Group Buy tiers because product variants can have different prices based on ring size/price band, chain length, metal, stone choice, and other options.

The Group Buy tier discount must be applied to the frozen campaign base price for the customer's eligible variant rather than using a fixed-dollar discount across all variants.

**Variant Group Price = Frozen Campaign Base Price for Eligible Variant × Applicable Tier Percentage**

Default campaign structure:

- Tier 1 — starting Group Buy price
- Tier 2 — better Group Buy price
- Tier 3 — best Group Buy price

The default is **3 tiers**.

The system must support **2 to 5 configurable tiers per campaign** when a different structure is commercially appropriate.

For every tier, the campaign administrator should be able to define:

- Unit-count threshold
- Percentage discount from the campaign's Tier 1/base Group Buy price
- Optional customer-facing tier label
- Optional manually overridden price rule where needed

Group Buy thresholds are based on **qualifying units sold**, not unique buyers. If one customer purchases three eligible pieces, all three units count toward the tier threshold. Cancelled/refunded orders that no longer qualify stop counting.

### Margin Protection

Before a campaign can be published, the pricing engine must validate the tier schedule against every allowed variant.

Each campaign and/or pricing profile must support:

- Minimum gross-margin percentage
- Minimum dollar profit per item
- Optional variant-specific floor

If a configured tier would push any allowed variant below its required margin or dollar-profit floor, the system should prevent publication or require an explicit authorized override.

Tier percentages and thresholds are frozen with the campaign pricing snapshot once the campaign opens.

## Campaign Progress / Live Savings Meter — MVP1 LOCKED DECISION

Every active Group Buy page should prominently show campaign progress and the price impact for the customer's current selection.

The module should show:

- Qualifying units sold
- Current tier unlocked
- Current tier percentage
- Next tier threshold
- Number of additional qualifying units needed for the next tier
- Current Group Buy price for the selected eligible variant
- Current Buy Now comparison price for the selected eligible variant
- Current dollar and percentage savings versus Buy Now
- Next-tier price for the selected eligible variant
- Additional savings if the next tier unlocks
- Countdown/time remaining near the progress area

The visual progress bar should mark the configured tier thresholds. The default 3-tier campaign can be presented as Tier 1 → Tier 2 → Tier 3 / Best Price.

When the final tier is reached, next-tier messaging should be replaced with a clear **Best Price Unlocked** state.

Do not use a crowdfunding-style funded percentage or imply that a minimum order count is required, because CaratForUs Group Buys do not require a minimum to proceed.

The progress module should make clear that customers do not need to wait for a lower tier before joining. Suggested message:

**Join now. If the group unlocks a lower price later, your final price drops too.**

## Variant Weight Model — LOCKED DECISION

For products where weight changes predictably with size or length, CaratForUs will use a **base specification + incremental adjustment + optional exact override** model.

### Rings

The internal ring-weight method is:

**Calculated Weight = Base Weight at Base Ring Size + ((Selected Ring Size - Base Ring Size) × Weight Added per Full Size)**

Half sizes use the proportional increment automatically.

### Exact-Weight Override

The system must also support an exact finished-weight override for any specific size where a linear formula is not accurate.

This is especially useful for wide bands, eternity rings, sculptural designs, designs where stone count changes by size, or cases where exact CAD/manufacturing data is available.

### Other Product Types

The same model should be reusable for chains, bracelets, tennis necklaces, bands, and other products using base specification + incremental adjustment where appropriate.

## Ring Size Guide & Pricing Bands — LOCKED DECISION

Every ring product page should include a **Find Your Ring Size** link near the size selector. The guide should support U.S. whole and half sizes, common international conversions, internal diameter/circumference in millimeters, guidance for measuring an existing ring and measuring the finger, and a warning that wide bands can fit tighter than narrow bands.

Each ring product should define:

- Minimum offered size
- Maximum offered size
- Size increment, usually 0.5
- Base size used for weight calculation
- Whether quarter sizes are allowed
- Whether custom sizes are available
- Resizing restrictions
- Product-specific sizing notes

A checkout confirmation such as **I have confirmed the ring size selected above** may be used to reduce sizing errors.

For customer-facing pricing, CaratForUs will simplify ring sizes into configurable pricing bands instead of showing a different selling price for every half-size.

Default pricing bands:

- **Size 2–6**
- **Size 6.5–8**
- **Size 8.5–11**

The internal cost model still calculates expected metal weight by exact ring size using the base-weight formula or an exact override. Customer-facing selling price is assigned by the applicable size-price band.

Each size-price band should use a safe cost basis so the highest-cost size inside that band remains profitable. By default, the pricing engine may use the largest size in the band as the cost reference, subject to configured minimum-margin and minimum-profit rules.

These bands must be configurable per product because wide rings, eternity rings, sculptural designs, and other unusual pieces may require different ranges or exact-size pricing.

## Metal Selection & Education — LOCKED DECISION

Supported metal library includes:

- Sterling Silver
- 10K Gold
- 14K Gold
- 18K Gold
- Platinum

The person creating each product must explicitly select which metals are offered for that product. Metals are not automatically enabled simply because they exist in the global library.

Reusable product-entry presets may preselect common metal combinations to speed setup, but the creator must confirm the final allowed metals before publishing.

Metal selection must connect directly to the pricing engine and variant pricing.

Product pages should provide a compact **Which metal should I choose?** education element rather than interrupting checkout with a long comparison lesson. Only metals actually offered for that product should be shown.

## Past Group Buys — LOCKED DIRECTION

CaratForUs will maintain a public **Past Group Buys** section.

- Show the five most recent completed campaigns on the homepage.
- Provide a dedicated View All Past Group Buys archive.
- Completed campaigns should have a clearly disabled/completed visual treatment rather than appearing active.
- Show actual final qualifying unit count.
- Show historical starting price and final unlocked Group Buy price.
- Preserve historical campaign data even when today's costs have changed.
- Completed items may later be offered as Buy Now products using current pricing generated by the pricing engine rather than the historical campaign price.
- Include a Bring It Back/future-campaign interest mechanism so customers can request a past design as a new Group Buy.

## Future Group-Buy Interest — LOCKED DECISION

CaratForUs should support two lightweight demand-capture actions.

### Bring It Back

Completed Group Buy pages should include a simple **Bring It Back** or **Notify Me If It Returns** action.

- If the customer is logged in, one click records their interest using the account already on file.
- If the customer is not logged in, only an email address is required so CaratForUs can notify them if the Group Buy returns.
- Internally store the related product/campaign ID, customer ID when available, email, request date, and aggregate interest count.

No metal, size, budget, stone-preference, or other configuration questions are required for this interest action.

### Request a New Group Buy

CaratForUs should also provide a simple **Request a New Group Buy** form.

Only **email is required** for a guest user. If the customer is logged in, the account email is already known and should not need to be re-entered.

Optional fields may include:

- Short description of what they would like CaratForUs to offer
- Inspiration image upload
- Product category

The form should remain intentionally low-friction and must not turn into the Custom Jewelry questionnaire. It is for suggesting a standardized future Group Buy, not requesting a one-off custom order.

## Estimated Savings — LOCKED DECISION

Active Group Buy campaigns should make the value of joining clear without encouraging customers to delay participation.

For each active campaign, show current Group Buy price, current Buy Now price, dollar savings, percentage savings, next tier, qualifying units needed to unlock it, and additional potential savings. The lowest possible tier may be shown as secondary information.

The page must clearly explain that customers do not need to wait for a lower tier before joining. If a lower tier is unlocked later, earlier participants receive the same final price through the campaign's refund/final-price mechanism.

The Buy Now comparison price may continue updating while the campaign is active, while active Group Buy tier prices remain frozen.

## Production Timeline — LOCKED DECISION

Production and delivery timing must be product-level data entered when each product or campaign is created rather than relying on a single global timeline.

Each product/campaign record should support:

- Campaign start date
- Campaign end date
- Production lead time or range
- QC/inspection duration
- Shipping estimate
- Optional manufacturing buffer
- Calculated estimated delivery date range
- Manual overrides
- Supplier/product-specific overrides where needed

Estimated timing and actual campaign/order status are separate concepts.

## Campaign & Order Status — LOCKED DECISION

Campaign and individual order status are separate but related.

Campaign stages should support:

- Open
- Closed
- In Production
- Quality Inspection
- Shipping
- Completed

Open/Closed may update automatically from campaign dates; production/QC may be manual in MVP1; shipping/delivery may use Shopify or carrier events where available. All statuses support manual override.

Individual orders may show:

- Order received
- Campaign open
- Final price confirmed
- Refund pending, if applicable
- In production
- QC complete
- Shipped
- Refund issued, if applicable
- Delivered

## Product Visuals & Technical Details — LOCKED DECISION

Because manufacturing is outsourced, CaratForUs will not require in-process manufacturing photography for each item. Instead, each product should support:

- Actual product photos when available
- Actual product video when available
- CAD renders
- Dimensioned CAD images
- Clearly labeled AI visualizations
- Optional manufacturer-provided media

The website must clearly distinguish:

- **Actual Product Photo**
- **Actual Product Video**
- **CAD Rendering**
- **CAD Dimensions**
- **AI Visualization — final appearance may vary slightly**

AI-generated media must never be presented as if it were a photograph or video of the finished manufactured item.

## FAQ Structure — LOCKED DIRECTION

CaratForUs should use a centrally managed FAQ system instead of one undifferentiated page or duplicated answers across products.

The main FAQ hub should support categories such as:

- Group Buys
- Pricing & Refunds
- Production & Delivery
- Materials & Stones
- Ring Sizing
- Custom Jewelry
- Warranty & Repairs
- Returns & Cancellations
- Payments
- Shipping & Insurance

Product pages should be able to attach relevant reusable FAQ entries and also support product-specific FAQ entries when truly needed.

Variant-aware help may be shown near selectors, for example metal education, lab diamond vs. moissanite guidance, gemstone information, sizing help, or product-specific construction notes.

Group Buy pages should include concise FAQs covering issues such as later tier unlocks, refund timing, no minimum unit count, cancellation rules, production timing, and sizing responsibility.

Group Buy FAQs and product-detail copy must not imply that free-form custom design changes are accepted within a standardized Group Buy.

## Real Customer / Campaign Photos — POST-MVP

CaratForUs will not require customer-submitted or completed-campaign photography for the initial MVP because there may be little or no customer-generated content at launch.

MVP behavior:

- Product pages should use available actual product photos, CAD renders, dimensioned CAD, clearly labeled AI visualizations, and supplier-provided media where appropriate.
- Do not display an empty Customer Photos or Seen in Real Life section when no content exists.
- Do not build a customer photo-upload or moderation workflow for MVP1.
- Customer/campaign photos should not be required for product publication or launch credibility.

Post-MVP, the media system may add customer-submitted photos and completed-order galleries once enough real content exists. Any future customer-photo feature should require customer permission and staff approval before public display.

## Buyer Map / Geographic Social Proof — POST-MVP

CaratForUs will not include a buyer map or geographic social-proof module in the initial MVP because there may be little or no customer activity at launch.

Post-MVP, once order volume is meaningful, CaratForUs may add aggregate geographic social proof such as:

- Number of states represented in a campaign
- Generalized regional activity
- A privacy-safe buyer map using aggregate or approximate location only

The feature must never expose exact customer addresses or precise locations.

## Invite Friends / Social Sharing — MVP1 LOCKED DECISION

Active Group Buy pages should include lightweight sharing tools from launch because sharing directly supports campaign growth and can help unlock lower pricing tiers.

MVP1 should include:

- A prominent **Share** action on every active Group Buy page
- Native mobile share-sheet support where available
- **Copy Link**
- Quick-share options for SMS/Text, Email, WhatsApp, Facebook, Instagram, and TikTok where the platform/device supports the intended share flow
- A prewritten share message that can reference the product, current campaign status, and opportunity to help unlock better pricing
- Shared links that go directly to the active campaign page
- Sharing available to any visitor; purchase is not required

For Instagram and TikTok, MVP1 should not depend on a complex direct-post API integration. Use the native device share flow where supported and provide an easy way to copy the campaign link and share/download a campaign social asset or suggested caption.

Campaigns should support a reusable social-sharing asset using approved product imagery, CaratForUs branding, campaign title, and a concise message such as **Help unlock the next price**.

Referral credits, affiliate commissions, tracked reward programs, and complex referral attribution are Post-MVP.

## Campaign Milestone Notifications / Return Experience — MVP1 LOCKED DECISION

CaratForUs should give customers a reason to return to an active Group Buy by notifying participants when something meaningful changes, without creating noisy gamification.

MVP1 should use email notifications for campaign participants at meaningful milestones, including:

- A new pricing tier is unlocked
- The best/final pricing tier is unlocked
- The campaign closes and the final price is confirmed
- Optionally, the campaign is very close to the next tier, using a configurable threshold

Do not send an email for every unit-count change.

Milestone notifications should link directly back to the campaign page, where the customer can immediately see current qualifying units, current tier, selected-variant pricing/savings, next-tier progress, and time remaining.

SMS, push notifications, streaks, daily check-in rewards, and advanced gamification are Post-MVP unless later justified by customer behavior.

## Group Buy Cancellation & Returns — MVP1 LOCKED DECISION

Group Buy orders may be cancelled for a full refund **until the campaign closes**.

- The product page and checkout must show the exact campaign closing date/time.
- A cancelled order immediately stops counting toward qualifying units.
- If cancellations cause the campaign to fall below a previously unlocked tier before close, live campaign pricing/progress adjusts accordingly.
- At campaign close, the final qualifying unit count and final tier are locked.
- After campaign close, the order becomes committed and is no longer eligible for discretionary cancellation or return.
- Defects, incorrect specifications, shipping damage, warranty claims, or CaratForUs fulfillment failures are handled separately and are not treated as discretionary returns.

## Buy Now Return Policy — MVP1 LOCKED DECISION

Buy Now items use a low-margin return structure:

- **Within 7 days of delivery:** eligible items may be returned for refund to the original payment method.
- **Days 8–30 after delivery:** eligible items may be returned for store credit only.
- **After 30 days:** no discretionary return.
- Returned items must be unworn, undamaged, unaltered, and returned with original packaging/documentation where applicable.
- Engraved, resized, altered, personalized, or otherwise customized Buy Now items are not eligible for discretionary return.
- Defects, incorrect specifications, shipping damage, and warranty claims are handled separately from the discretionary return window.

## Custom Jewelry Design Deposit & Final Sale — MVP1 LOCKED DECISION

Custom Jewelry begins with a free request/review stage. When CaratForUs is ready to begin actual design/CAD work, the customer pays a **$49 Design Deposit**.

- The $49 deposit is applied toward the final jewelry price if the customer proceeds.
- If CaratForUs completes the agreed design/CAD stage and the customer decides not to proceed, the $49 deposit is refunded with no questions asked.
- The deposit is intended as a seriousness filter and is not described as a non-refundable design fee.
- If the customer abandons the process before the agreed design stage is completed or stops responding, the refund is not automatic; CaratForUs may determine whether the deposit is refundable based on work completed and the circumstances.
- Once the customer approves the final design/specifications and pays for the jewelry, the Custom Jewelry order becomes non-refundable/final sale except for covered defects, incorrect specifications, shipping damage, or failure to materially match the approved design/specifications.
- Final CAD/specification approval must be stored as part of the order record.

## Custom Design Approval & Purchase Page — MVP1 LOCKED DECISION

MVP1 will use email for consultation, CAD/design discussion, revisions, and general communication. CaratForUs will **not** build a full customer custom-project portal for MVP1.

When a custom design is ready for final approval and purchase, CaratForUs will create a dedicated customer-specific page on the CaratForUs site for that design. That page becomes the formal approval and purchase checkpoint.

The page should display, as applicable:

- Customer/project reference
- Final CAD/renderings and/or approved design images
- Jewelry type and design description
- Metal type/color/purity
- Ring size, length, or other applicable dimensions
- Center stone specifications
- Accent/side stone specifications
- Engraving or other approved options
- Any important construction or specification notes
- Final quoted price
- $49 Design Deposit credit
- Remaining amount due
- Estimated production/delivery timing
- Applicable 1-year limited manufacturing warranty summary
- Shipping/insurance/signature requirements
- Final-sale/custom-order terms

Before the purchase can proceed, the page must require affirmative acknowledgment of the material terms. At minimum, the customer must acknowledge that:

- the displayed CAD/design and specifications are the design they are approving;
- the listed size, metal, stones, dimensions, engraving, and other specifications are correct;
- reasonable handmade/manufacturing tolerances and minor visual variation from renderings may occur where applicable;
- once the final custom order is approved and purchased, it is non-refundable/final sale except for covered manufacturing defects, incorrect specifications, shipping damage, or material failure to match the approved design/specifications;
- the customer has reviewed the applicable warranty, shipping, and other material purchase terms.

These acknowledgments must be **unchecked by default** and required before purchase.

The system must retain a timestamped approval record tied to the order/custom-project record, including:

- exact page/specification version approved
- exact acknowledgment language/version
- timestamp
- customer/order/project identifier
- CAD/media references shown at approval
- final specifications
- final price and Design Deposit credit
- checkout/payment reference where available

The page and its approved specification snapshot must be preserved as part of the immutable transaction evidence and must not be overwritten by later edits to a live design page.

This custom approval/purchase page replaces the need for a full customer project portal in MVP1 while creating a stronger formal record than relying on an informal email approval alone.

A richer Custom Design project portal with message history, revision tracking, file exchange, and customer dashboard remains **Post-MVP**.

## 1-Year Limited Manufacturing Warranty — MVP1 LOCKED DECISION

CaratForUs will provide a **1-year limited manufacturing warranty** across Buy Now, Group Buy, and Custom Jewelry.

The warranty covers defects in materials, construction, setting, or assembly under normal use, such as defective solder joints, structural workmanship failures, setting defects, or defective clasps/mechanisms.

The warranty does not cover normal wear, scratches, dents, impact damage, bent/worn prongs caused by use, lost stones caused by damage or wear, misuse, improper care, sizing changes, third-party repairs/modifications, loss, theft, or other damage not caused by a covered manufacturing defect.

CaratForUs may determine the appropriate remedy for a valid covered claim, including repair, replacement, refund, or another reasonable resolution where appropriate.

Customers must contact CaratForUs for authorization/instructions before sending an item back.

CaratForUs does **not** promise a paid repair service after the warranty period and should not market itself as maintaining an ongoing repair department.

## Customer Acknowledgment & Chargeback Evidence Architecture — MVP1 LOCKED DECISION

Chargeback resistance is a core design requirement for CaratForUs. The site should create a clear, timestamped evidence trail showing what the customer saw, selected, approved, and agreed to.

### Conspicuous Purchase-Path Disclosures

Material terms should be shown in context, not only buried in Terms & Conditions.

- Group Buy pages should show campaign close date/time, cancellation rights before close, final-sale status after close, tier/refund mechanics, and estimated production timing near the purchase action.
- Buy Now pages should show the 7-day refund / days 8–30 store-credit policy near Add to Cart or in a clearly accessible compact disclosure.
- Custom Jewelry should show the $49 Design Deposit terms and the point at which the final jewelry order becomes non-refundable.

### Mandatory Acknowledgments for Material Terms

Use explicit, unchecked acknowledgments for unusual/high-risk purchase terms rather than relying only on a generic Terms acceptance.

Examples:

- Group Buy: acknowledgment that the order may be cancelled until the stated campaign close date/time and becomes final sale after campaign close except for covered defects/fulfillment errors.
- Custom Jewelry: acknowledgment of final CAD/specification approval and final-sale status on the dedicated design approval/purchase page before checkout/payment commitment.

Buy Now does not need excessive checkbox friction if the return policy is conspicuously displayed and preserved with the transaction record.

### Acceptance Logging

For material acknowledgments, store at least:

- Order ID
- Customer/account ID when available
- Campaign ID or custom-project ID where applicable
- Exact acknowledgment text/version
- Policy version
- Timestamp
- Selected product/variant/configuration
- Checkout/session reference where available
- Relevant technical metadata where reasonably available through the commerce/payment platform

### Immutable Order Snapshot

At payment/commitment, preserve a snapshot of what the customer purchased and what was disclosed at that time, including as applicable:

- Product title
- Product images/media references used at purchase
- Metal, stone specifications, size/length, engraving, and other selected options
- Price charged
- Group Buy tier/status at order time
- Campaign close date/time
- Applicable return/cancellation policy version
- Warranty version
- Material acknowledgment records
- Custom approval-page version and CAD/specification approval references

Later edits to a live product or custom-design page must not overwrite the historical transaction snapshot.

### Confirmation & Lifecycle Notices

Important terms should be repeated after purchase.

- Order confirmation should restate the applicable cancellation/return status and key dates.
- Group Buy confirmation should identify the exact cancellation deadline.
- When a Group Buy closes, send a notice that final pricing is confirmed and the order is now committed/final sale, subject to defect/warranty protections.
- Custom Jewelry should retain the customer's final design/spec approval from the dedicated approval/purchase page before production.

### QC Evidence

CaratForUs QC should create evidence, not just an internal status.

For each order, retain practical QC records appropriate to the product/value, such as:

- QC checklist/results
- Photos of the finished item when practical, especially for Custom Jewelry and higher-value orders
- Verification of key ordered specifications where feasible
- Date/time and staff/internal reviewer identity or record

### Shipping & Delivery Evidence

Store shipping evidence for every order, including:

- Carrier
- Tracking number
- Ship date
- Delivery status/date
- Delivery address used for fulfillment
- Signature confirmation or other delivery proof where required by configured value/risk thresholds

### Dispute Evidence Packet

The admin system should make it possible to assemble a dispute/chargeback evidence packet for any order. MVP1 may assemble this manually, but all required records must be retained.

The packet should include as applicable:

- Order/payment record
- Product/configuration snapshot
- Policy and acknowledgment versions
- Group Buy campaign/tier/cancellation history
- Custom approval-page snapshot and CAD/spec approval
- Customer communications
- QC records/photos
- Shipping/tracking/delivery/signature evidence
- Cancellation/refund history
- Group Buy tier-refund history
- Warranty/claim history

### Fraud/Chargeback Operational Support

The architecture should also support operational review of suspicious/high-risk orders, preservation of recognizable billing-statement descriptors, tracking/delivery evidence, and any commerce/payment-platform fraud tools used at launch.

A restrictive return policy alone is not considered sufficient chargeback protection; the objective is to preserve evidence that the customer saw the terms, affirmatively accepted material conditions, received the item, and received what was described/approved.

## Shipping, Insurance & Signature Requirements — MVP1 LOCKED DECISION

CaratForUs will use conservative shipping controls because jewelry is high-risk for loss, fraud, and delivery-related chargebacks.

- **Every outbound customer shipment must be insured for the full order value.**
- Every shipment must include carrier tracking.
- **Any shipment with an order value above $100 requires signature confirmation.**
- Customers may not waive the signature requirement on shipments above $100.
- Orders valued at $100 or less may ship without signature unless CaratForUs manually requires it based on risk or product circumstances.
- CaratForUs may apply stricter delivery controls to higher-risk orders even when not otherwise required by the base rules.
- Fulfillment should use the shipping address approved through checkout/payment unless an address change is explicitly reviewed and documented before shipment.
- Any post-order shipping-address change must create an audit record.
- Where carrier/service capabilities permit, high-value shipments should not allow unattended leave-at-door overrides that bypass required signature controls.

The order/shipment record should retain at least:

- Carrier and service level
- Tracking number
- Ship date
- Full insured value
- Insurance reference/policy/coverage identifier where available
- Signature-required flag
- Delivery status/date/time
- Delivery address
- Signature/proof-of-delivery record when applicable
- Any address-change approval/audit history
- Any shipping exception or claim reference

Shipping insurance cost must be incorporated into the pricing/cost engine so full-value coverage does not silently erode margins.

## Group-Buy Refund Engine — LOCKED DECISION

CaratForUs will not use store credit for tier-price adjustments. Any amount owed because a lower Group Buy tier was unlocked must be refunded to the customer's original payment method where supported.

Refunds are calculated continuously but held until the applicable order is ready to ship/enters the shipping stage.

Every Group Buy order must maintain a refund ledger with at least:

- Campaign ID
- Order ID
- Customer ID
- Payment processor
- Processor payment/charge/payment-intent reference
- Amount originally charged
- Purchased variant/options
- Group Buy price at order time
- Final Group Buy price for the applicable exact eligible variant/price band
- Calculated refund amount
- Refund status
- Requested/processed timestamps
- Processor refund reference
- Failure reason
- Manual override/adjustment
- Audit history

Refund amount is calculated at the order/line-item/variant level.

Operational flow:

1. Campaign closes and final qualifying unit count determines the final tier.
2. Final Group Buy price is calculated for each purchased eligible variant.
3. Each order's refund due is calculated and stored.
4. Refunds remain Pending Refund during production/QC.
5. At shipping, eligible refunds enter a refund batch.
6. Partial refunds are submitted to the original payment processor where supported.
7. Successful processor references/timestamps are stored.
8. Failed refunds are isolated for retry/manual handling without blocking successful refunds.

Refund batch processing should include internal review, processor abstraction, idempotency, and exception handling.

## Group-Buy Product Options — LOCKED DECISION

Group Buy products are standardized campaigns, not custom-design orders.

Customers may only purchase from the **pre-approved options explicitly configured for that campaign**, such as:

- Metal and metal color
- Stone type
- Stone color or quality when offered
- Ring size or chain/bracelet/necklace length
- Predefined engraving options when a campaign allows engraving
- Other predefined variants approved before the campaign launches

A Group Buy product page must **not include a free-form Custom Request field for design changes**. Customers who want a different design, unlisted gemstone, nonstandard construction, or other modification should be directed to the separate Custom Jewelry flow.

If an optional Order Note field is offered, it is for non-design logistics or clarification only and must not be treated as authorization to change the product specification.

### Group-Buy Cart / Line-Item Behavior — MVP1 LOCKED DECISION

Customers may purchase multiple pieces from the same Group Buy in one Shopify order, including different eligible configurations.

- Each unique configuration must be added to the cart as a **separate Shopify line item** rather than combining materially different configurations into one opaque quantity line.
- A line item should preserve the exact selected configuration, including applicable metal, stone option, ring size or length, engraving choice, and other approved campaign options.
- Multiple quantities of the **same exact configuration** may use a quantity greater than one on that line item.
- Different ring sizes, metals, stone choices, lengths, engravings, or other configuration differences must remain separate line items.
- Tier qualification counts **units**, so line-item quantity contributes that number of qualifying units when the order qualifies.
- Cancellation/refund/tier-adjustment calculations must operate at line-item/unit level so one configuration can be handled correctly without corrupting another configuration in the same Shopify order.
- The immutable order snapshot and refund ledger must retain the exact configuration and quantity for every Group Buy line item.
- The cart/order summary should make each configuration easy for the customer to verify before checkout.

## How Group Buying Works — LOCKED DIRECTION

The Group Buy explanation should remain short on active product pages and link to a fuller FAQ/How It Works page.

1. **Join the Group Buy** — Choose from the approved options and place the order at the current Group Buy price.
2. **More Units, Better Pricing** — More qualifying pieces ordered can unlock lower percentage tiers.
3. **Everyone Gets the Best Final Price** — If a lower tier is reached after an earlier customer ordered, that customer's final price drops too.
4. **Campaign Closes** — Final qualifying unit count determines the final tier and final price.
5. **We Produce Your Jewelry** — Orders proceed into production using the selected approved configuration.
6. **QC, Refund & Shipping** — CaratForUs inspects the jewelry, processes any Group Buy price refund due, and ships the order with tracking.

The page should explicitly state that there is no minimum unit count required for the campaign to proceed.

## MVP1: Minimum Viable Business

The first release is intentionally focused. The goal is to launch a fully functioning business capable of accepting and fulfilling Buy Now, Group Buy, and Custom Jewelry orders while keeping internal operations manual wherever practical, except where pricing automation, campaign mechanics, refund tracking, customer acknowledgments, and evidence retention are required to protect margins and honor customer commitments.

### Customer-Facing Features

- Shopify storefront
- Buy Now product pages
- Active Group Buy campaign pages
- Live or frequently updated qualifying unit count
- Campaign progress/live savings meter
- Countdown timer
- Tiered pricing display
- Current unlocked price
- Next pricing tier and qualifying units needed
- Dynamic savings vs. Buy Now display
- Product-specific estimated production and delivery timeline
- Campaign status tracker
- Individual order status tracker where appropriate
- Milestone email notifications for Group Buy participants
- Product photos, videos, CAD renders, dimensioned CAD, and labeled AI visualizations where applicable
- Ring size guide
- Metal-selection education
- Contextual/global FAQ system
- Short How Group Buying Works explanation on active campaign pages
- Invite Friends/social sharing tools for active campaigns
- Bring It Back interest capture
- Request a New Group Buy form
- Shopify checkout
- Purchase-path-specific policy disclosures and material acknowledgments
- Order confirmation with applicable cancellation/return/final-sale terms
- Custom Jewelry request form
- Inspiration image upload
- $49 Custom Jewelry Design Deposit workflow
- Final CAD/specification approval workflow for Custom Jewelry
- Warranty and support information
- Shipping policy showing full-value insurance and signature requirements
- FAQ, policies, contact, about, and Why Buy From Us pages/sections
- Past Group Buys section

### Required Internal Records / Admin Support

- Immutable order/configuration/policy snapshot
- Material acknowledgment logs and policy versioning
- Group Buy cancellation/tier audit history
- Refund ledger and processor references
- Custom design/CAD approval record
- QC checklist/evidence storage
- Shipping/tracking/full-value insurance/delivery/signature evidence storage
- Customer communication history where available
- Manual dispute-evidence packet assembly capability

## Post-MVP / Backlog

- Vote on the Next Group Buy
- Real Customer / Campaign Photos and customer upload/moderation workflow
- Buyer Map / Geographic Social Proof
- Referral credits, affiliate commissions, and tracked reward programs
- SMS/push campaign milestone notifications
- Advanced daily-return gamification, streaks, or check-in rewards
- Complex direct-post integrations for Instagram/TikTok beyond supported native share flows
- Rich Custom Design customer portal with message history, revision tracking, file exchange, and customer dashboard

## Custom Jewelry Flow

1. Customer selects Start a Custom Design.
2. Customer completes a guided questionnaire.
3. Customer uploads inspiration images or sketches.
4. CaratForUs reviews the request manually and communicates by email.
5. When CaratForUs is ready to begin actual design/CAD work, the customer pays the $49 Design Deposit.
6. CaratForUs completes the agreed design/CAD stage and handles revisions/communication by email.
7. When the design is ready for final approval, CaratForUs creates a dedicated Shopify-based custom approval/purchase page from a reusable template and populates it with the final CAD/design, specifications, pricing, Design Deposit credit, and applicable terms.
8. Customer reviews the page, affirmatively approves the displayed design/specifications and material final-sale terms, and proceeds through the normal Shopify checkout.
9. The $49 Design Deposit is credited toward the final jewelry price.
10. The approved page/specification snapshot, acknowledgment records, and Shopify payment/order references are retained as transaction evidence.
11. Production, QC, insured shipping, and delivery are handled under the applicable Custom Jewelry, warranty, and shipping rules.

## Shopify Custom Approval/Purchase Template — MVP1 LOCKED DECISION

CaratForUs should maintain a reusable Shopify template for customer-specific custom jewelry approval and checkout pages. Staff should create a custom item by populating structured fields rather than designing a new page from scratch each time.

The template should accept, as applicable:

- customer/project reference
- custom product title
- CAD/rendering/design images
- design description
- metal type/color/purity
- stone specifications
- ring size, length, dimensions, or other sizing data
- engraving/personalization
- construction/specification notes
- final quoted price
- $49 Design Deposit credit
- remaining balance due
- production/delivery estimate
- warranty summary
- shipping/insurance/signature summary
- final-sale/custom-order terms
- required acknowledgment text/version

The completed page should be customer-specific and may be excluded from normal storefront discovery/navigation where practical. It must still use Shopify's normal purchase/checkout process.

The template must require the customer to verify the displayed design/specifications and accept the material custom-order terms before the purchase action is enabled.

At purchase, CaratForUs must retain the exact populated template/specification version, CAD/media references, acknowledgment language/version and timestamp, price, Design Deposit credit, and Shopify order/payment references as part of the immutable transaction evidence.

## Payment Strategy

The preferred strategy is to encourage lower-cost payment methods while keeping credit-card payment available, subject to processor rules and applicable law.

## Guiding Rule

If a feature does not help CaratForUs launch sooner, protect pricing/margins, drive acquisition/conversion, or materially improve the customer experience, it belongs in the backlog.