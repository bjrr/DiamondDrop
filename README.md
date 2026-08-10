# CaratForUs

CaratForUs is a U.S.-based jewelry business built around two revenue channels:

1. Community-powered group buys with transparent tiered pricing.
2. Custom jewelry requests handled through a guided customer questionnaire and manual quoting.

## Core Value Proposition

Why take the risk of ordering overseas when customers can receive comparable group-buy pricing from a U.S.-based seller with warranty coverage, quality inspection, domestic support, and clearer accountability?

CaratForUs is not positioned merely as the cheapest option. The brand combines competitive pricing with trust, service, transparency, and after-sale support.

## Why Buy From Us — LOCKED DIRECTION

The Why Buy From Us message must represent CaratForUs as a whole, not only group buys. It should apply consistently across Buy Now, Group Buy, and Custom Jewelry purchases.

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
- **Domestic support and service** — questions, warranty matters, service, repairs, and approved returns are handled through a U.S.-based business.
- **Reduced overseas buying burden** — customers should not have to manage foreign seller communication, customs paperwork, international service coordination, or overseas return logistics where CaratForUs can handle those responsibilities.
- **Transparent pricing** — pricing should be based on the actual product configuration and commercial model rather than inflated comparison prices or artificial retail anchors.
- **Strong value across every purchase path** — competitive Buy Now pricing, additional savings opportunities through Group Buys, and clear/fair quoting for Custom Jewelry.
- **Clear product specifications** — metal, stone quality, dimensions, weights, CAD details, and available options should be clearly defined so customers understand what they are purchasing.
- **Warranty and after-sale support** — customer support continues after delivery.
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

Active group-buy campaign pricing is frozen for the campaign and must not automatically change as precious-metal or market costs move after customer commitments begin.

When a campaign is opened, store a versioned cost/pricing snapshot including applicable metal prices, stone costs, labor assumptions, fees, margins, and tier prices. This historical snapshot remains associated with that campaign permanently.

There is no mandatory minimum buyer count required to complete a campaign. If only one customer joins, that customer receives the highest applicable pricing tier and the item can still proceed to production.

### Group-Buy Tier Model — LOCKED DECISION

CaratForUs will use percentage-based group-buy tiers because product variants can have different prices based on ring size, chain length, metal, stone choice, and other options.

The group-buy tier discount must be applied to the frozen campaign base price for each exact variant rather than using a fixed-dollar discount across all variants.

**Variant Group Price = Frozen Campaign Base Price for Exact Variant × Applicable Tier Percentage**

Default campaign structure:

- Tier 1 — starting group-buy price
- Tier 2 — better group-buy price
- Tier 3 — best group-buy price

The default is **3 tiers**.

The system must support **2 to 5 configurable tiers per campaign** when a different structure is commercially appropriate.

For every tier, the campaign administrator should be able to define:

- Unit-count threshold
- Percentage discount from the campaign's Tier 1 / base group-buy price
- Optional customer-facing tier label
- Optional manually overridden price rule where needed

Group-buy thresholds are based on **qualifying units sold**, not unique buyers. If one customer purchases three eligible pieces, all three units count toward the tier threshold. Cancelled/refunded orders that no longer qualify should stop counting.

### Margin Protection

Before a campaign can be published, the pricing engine must validate the tier schedule against every allowed variant.

Each campaign and/or pricing profile must support:

- Minimum gross-margin percentage
- Minimum dollar profit per item
- Optional variant-specific floor

If a configured tier would push any allowed variant below its required margin or dollar-profit floor, the system should prevent publication or require an explicit authorized override.

Tier percentages and thresholds are frozen with the campaign pricing snapshot once the campaign opens.

## Variant Weight Model — LOCKED DECISION

For products where weight changes predictably with size or length, CaratForUs will use a **base specification + incremental adjustment + optional exact override** model.

### Rings

The default ring-weight method is:

**Calculated Weight = Base Weight at Base Ring Size + ((Selected Ring Size - Base Ring Size) × Weight Added per Full Size)**

Half sizes use the proportional increment automatically.

### Exact-Weight Override

The system must also support an exact finished-weight override for any specific size where a linear formula is not accurate.

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

The internal cost model still calculates expected metal weight by exact ring size using the base-weight formula or an exact override. The customer-facing price is then assigned by the applicable size-price band.

Each size-price band should use a safe cost basis so the highest-cost size inside that band remains profitable. By default, the pricing engine may use the largest size in the band as the cost reference, subject to the configured minimum-margin and minimum-profit rules.

These bands must be configurable per product because wide rings, eternity rings, sculptural designs, and other unusual pieces may require different ranges or exact-size overrides.

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

## Past Group Buys — LOCKED DIRECTION

CaratForUs will maintain a public **Past Group Buys** section.

- Show the five most recent completed campaigns on the homepage.
- Provide a dedicated View All Past Group Buys archive.
- Completed campaigns should have a clearly disabled/completed visual treatment rather than appearing active.
- Show actual final unit count.
- Show historical starting price and final unlocked group price.
- Preserve historical campaign data even when today's costs have changed.
- Completed items may later be offered as Buy Now products using current pricing generated by the pricing engine rather than the historical campaign price.
- Include a Bring It Back / future-campaign interest mechanism so customers can request a past design as a new group buy.

## Future Group-Buy Interest — LOCKED DECISION

CaratForUs should support two lightweight demand-capture actions.

### Bring It Back

Completed group-buy pages should include a simple **Bring It Back** or **Notify Me If It Returns** action.

- If the customer is logged in, one click records their interest using the account already on file.
- If the customer is not logged in, only an email address is required so CaratForUs can notify them if the group buy returns.
- Internally store the related product/campaign ID, customer ID when available, email, request date, and aggregate interest count.

No metal, size, budget, stone-preference, or other configuration questions are required for this interest action.

### Request a New Group Buy

CaratForUs should also provide a simple **Request a New Group Buy** form.

Only **email is required** for a guest user. If the customer is logged in, the account email is already known and should not need to be re-entered.

Optional fields may include:

- Short description of what they would like CaratForUs to offer
- Inspiration image upload
- Product category

The form should remain intentionally low-friction and must not turn into the Custom Jewelry questionnaire. It is for suggesting a standardized future group buy, not requesting a one-off custom order.

## Estimated Savings — LOCKED DECISION

Active group-buy campaigns should make the value of joining clear without encouraging customers to delay participation.

For each active campaign, show current group price, current Buy Now price, dollar savings, percentage savings, next tier, units needed to unlock it, and additional potential savings. The lowest possible tier may be shown as secondary information.

The page must clearly explain that customers do not need to wait for a lower tier before joining. If a lower tier is unlocked later, earlier participants receive the same final price through the campaign's refund/final-price mechanism.

The Buy Now comparison price may continue updating while the campaign is active, while active group-buy tier prices remain frozen.

## Production Timeline — LOCKED DECISION

Production and delivery timing must be product-level data entered when each product or campaign is created rather than relying on a single global timeline.

Each product/campaign record should support campaign dates, production lead time, QC duration, shipping estimate, optional manufacturing buffer, calculated estimated delivery range, and manual overrides.

## Campaign & Order Status — LOCKED DECISION

Campaign and individual order status are separate but related.

Campaign stages should support Open, Closed, In Production, Quality Inspection, Shipping, and Completed. Open/Closed may update automatically; production/QC may be manual; shipping/delivery may use Shopify or carrier events where available. All statuses support manual override.

Individual orders may show Order received, Campaign open, Final price confirmed, Refund pending, In production, QC complete, Shipped, Refund issued, and Delivered.

## Product Visuals & Technical Details — LOCKED DECISION

Because manufacturing is outsourced, CaratForUs will not require in-process manufacturing photography for each item. Instead, each product should support actual product photos, actual product video, CAD renders, dimensioned CAD images, clearly labeled AI visualizations, and optional manufacturer-provided media.

The website must clearly distinguish Actual Product Photo, Actual Product Video, CAD Rendering, CAD Dimensions, and AI Visualization — final appearance may vary slightly.

## Group-Buy Refund Engine — LOCKED DECISION

CaratForUs will not use store credit for tier-price adjustments. Any amount owed because a lower group-buy tier was unlocked must be refunded to the customer's original payment method where supported.

Refunds are calculated continuously but held until the applicable order is ready to ship / enters the shipping stage.

Every group-buy order must maintain a refund ledger with campaign, order, customer, processor, amount charged, exact variant, original group price, final group price, calculated refund, status, timestamps, processor refund reference, exceptions, manual override, and audit history.

Refund amount is calculated at the order/line-item/variant level.

CaratForUs should support batch refund processing at shipping, with internal review, processor abstraction, idempotency, and exception handling.

## Group-Buy Product Options — LOCKED DECISION

Group-buy products are standardized campaigns, not custom-design orders.

Customers may only purchase from the **pre-approved options explicitly configured for that campaign**, such as:

- Metal and metal color
- Stone type
- Stone color or quality when offered
- Ring size or chain/bracelet/necklace length
- Predefined engraving options when a campaign allows engraving
- Other predefined variants approved before the campaign launches

A group-buy product page must **not include a free-form Custom Request field for design changes**. Customers who want a different design, unlisted gemstone, nonstandard construction, or other modification should be directed to the separate Custom Jewelry flow.

If an optional Order Note field is offered, it is for non-design logistics or clarification only and must not be treated as authorization to change the product specification.

## How Group Buying Works — LOCKED DIRECTION

The group-buy explanation should remain short on active product pages and link to a fuller FAQ / How It Works page.

1. Join the Group Buy.
2. More units sold unlock better pricing.
3. Everyone gets the best final price reached.
4. Campaign closes and final pricing is locked.
5. Jewelry goes into production.
6. QC, refund adjustment if applicable, and shipping follow.

The page should explicitly state that there is no minimum unit count required for the campaign to proceed.

## MVP1: Minimum Viable Business

The first release is intentionally small. The goal is to launch a fully functioning business capable of accepting and fulfilling orders while keeping internal operations manual wherever practical, except where pricing automation and refund tracking are required to protect margins and honor group-buy commitments.

### Customer-Facing Features

- Shopify storefront
- Active group-buy campaign pages
- Live or frequently updated qualifying unit count
- Countdown timer
- Tiered pricing display
- Current unlocked price
- Next pricing tier and units needed
- Dynamic savings vs. Buy Now display
- Product-specific estimated production and delivery timeline
- Campaign status tracker
- Individual order status tracker where appropriate
- Product photos, videos, CAD renders, dimensioned CAD, and labeled AI visualizations where applicable
- Ring size guide
- Short How Group Buying Works explanation on active campaign pages
- Shopify checkout
- Order confirmation
- Custom jewelry request form
- Inspiration image upload
- Warranty and support information
- FAQ, policies, contact, and about pages
- Past Group Buys section
- Bring It Back / Notify Me If It Returns
- Simple Request a New Group Buy form

## Post-MVP / Backlog

### Vote on the Next Group Buy

Voting on future group buys is **not required for MVP1**. Early demand should be measured using actual orders, Bring It Back requests, and New Group Buy requests rather than adding poll infrastructure before there is enough customer traffic for voting data to be meaningful.

A future voting feature may allow customers to vote among a small number of candidate designs, but it should be added only after CaratForUs has sufficient audience size and operational need.

## Custom Jewelry Flow

1. Customer selects Start a Custom Design.
2. Customer completes a guided questionnaire.
3. Customer uploads inspiration images or sketches.
4. CaratForUs reviews the request manually.
5. Customer receives a consultation and quote.
6. Payment is collected.
7. CAD, approval, production, inspection, and delivery are handled manually during MVP1.

## Payment Strategy

The preferred strategy is to encourage lower-cost payment methods while keeping credit-card payment available, subject to processor rules and applicable law.

## Guiding Rule

If a feature does not help CaratForUs launch sooner, protect pricing/margins, or materially improve the customer experience, it belongs in the backlog.
