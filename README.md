# CaratForUs

CaratForUs is a U.S.-based jewelry business built around two revenue channels:

1. Community-powered group buys with transparent tiered pricing.
2. Custom jewelry requests handled through a guided customer questionnaire and manual quoting.

## Core Value Proposition

Why take the risk of ordering overseas when customers can receive comparable group-buy pricing from a U.S.-based seller with warranty coverage, quality inspection, domestic support, and clearer accountability?

CaratForUs is not positioned merely as the cheapest option. The brand combines competitive pricing with trust, service, transparency, and after-sale support.

## Core Product & Pricing Architecture

CaratForUs will be built around a structured jewelry product data model and pricing engine rather than manually maintained selling prices.

### Master Product Definition

Each jewelry design will have one Master Product Definition containing the core engineering and commercial data needed to manufacture and price the item. This may include:

- Product category and design metadata
- CAD files, renderings, photos, and manufacturing notes
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

- Precious metals: 10K, 14K, 18K, platinum and future metals
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

## Variant Weight Model — LOCKED DECISION

For products where weight changes predictably with size or length, CaratForUs will use a **base specification + incremental adjustment + optional exact override** model.

### Rings

The default ring-weight method is:

**Calculated Weight = Base Weight at Base Ring Size + ((Selected Ring Size - Base Ring Size) × Weight Added per Full Size)**

Example:

- Base ring size: 4
- Base finished weight: 3.20 g
- Increment: 0.10 g per full ring size
- Size 7 calculated weight: 3.20 g + (3 × 0.10 g) = 3.50 g

Half sizes use the proportional increment automatically. In the example above, size 4.5 would be 3.25 g.

This method is the default because it avoids maintaining a separate finished weight for every ring size.

### Exact-Weight Override

The system must also support an exact finished-weight override for any specific size where a linear formula is not accurate.

This is important for designs such as:

- Wide bands
- Eternity and partial-eternity rings
- Unusual shanks
- Highly sculptural designs
- Designs where stone count changes by size
- Any product where CAD/manufacturing data provides more accurate size-specific weights

When an exact override exists, it takes precedence over the calculated weight.

### Other Product Types

The same model should be reusable for other products:

- Chains: base length + grams per additional inch
- Bracelets: base length + grams per additional inch
- Tennis necklaces: base length + component/weight adjustments per additional inch
- Bands: base ring size + grams per additional size
- Other products: base specification + incremental adjustment where appropriate

The data model should not require duplicate full product records for every variant. Variants should inherit master-product data and store only what changes, such as ring size, chain length, center-stone option, metal, backing style, stone-count change, or incremental weight.

## Past Group Buys — LOCKED DIRECTION

CaratForUs will maintain a public **Past Group Buys** section.

- Show the five most recent completed campaigns on the homepage.
- Provide a dedicated View All Past Group Buys archive.
- Completed campaigns should have a clearly disabled/completed visual treatment rather than appearing active.
- Show actual final buyer count.
- Show historical starting price and final unlocked group price.
- Preserve historical campaign data even when today's costs have changed.
- Completed items may later be offered as Buy Now products using current pricing generated by the pricing engine rather than the historical campaign price.
- Include a Bring It Back / future-campaign interest mechanism so customers can request a past design as a new group buy.

## Estimated Savings — LOCKED DECISION

Active group-buy campaigns should make the value of joining clear without encouraging customers to delay participation.

### Active Campaign Display

For each active campaign, show:

- Current Group Price
- Current Buy Now price generated by the live pricing engine
- Current dollar savings versus Buy Now
- Current percentage savings versus Buy Now
- Next pricing tier
- Number of additional buyers needed to unlock the next tier
- Additional dollar savings available at the next tier
- Lowest possible tier may be shown, but only as secondary information rather than the primary callout

Example presentation:

- Current Group Price: $649
- Buy Now Today: $729
- You Save: $80 (11%)
- 12 more buyers unlock $619
- Potential additional savings: $30

### Behavioral Rule

The page must clearly explain that customers do not need to wait for a lower tier before joining. If a lower tier is unlocked later, earlier participants receive the same final price through the campaign's refund/final-price mechanism.

Suggested message:

**Join now. If the group unlocks a lower tier, your final price drops too.**

### Dynamic Comparison Rule

The Buy Now comparison price may continue updating while the campaign is active because it is generated from current pricing inputs such as gold and stone costs.

The active group-buy tier prices themselves remain frozen for the duration of the campaign.

Therefore:

- Group Buy Price = frozen
- Buy Now Comparison Price = dynamic
- Savings dollars = dynamic
- Savings percentage = dynamic

### Historical Campaign Savings

For completed campaigns, preserve the historical savings achieved during that campaign, including:

- Starting Group Price
- Final Group Price
- Dollar savings unlocked by the community

Historical campaign data must not be overwritten by later Buy Now price changes.

### Comparison Pricing Rule

Do not rely on artificial or inflated "retail" comparison prices. Savings should primarily be compared against CaratForUs's actual current Buy Now price generated by the pricing engine.

## Production Timeline — LOCKED DECISION

Production and delivery timing must be product-level data entered when each product or campaign is created rather than relying on a single global timeline.

Each product/campaign record should support:

- Campaign start date
- Campaign end date
- Production lead time or production lead-time range
- Quality-control / inspection duration
- Shipping estimate
- Optional manufacturing buffer
- Calculated estimated delivery date range
- Manual override for any displayed dates or durations when needed

The customer-facing estimated delivery window should be calculated from these fields.

Different products may have different production timelines. For example, a simple ring may have a shorter production cycle than a tennis necklace, bracelet, complex pavé item, or custom-manufactured piece.

The system must support supplier- or product-specific timing overrides without changing global defaults.

### Estimated Timeline vs. Actual Status

Estimated timing and actual order/campaign status are separate concepts:

- **Estimated timeline** describes when the customer is expected to receive the item.
- **Actual status** describes what is currently happening operationally.

After a campaign closes, the estimated timeline remains visible while an actual-status tracker may show progress such as Production → Quality Inspection → Shipping → Delivered.

## Campaign & Order Status — LOCKED DECISION

Campaign status and individual order status are separate but related.

### Campaign Status

Customer-facing campaign stages should support:

- Open
- Closed
- In Production
- Quality Inspection
- Shipping
- Completed

Status behavior:

- Open / Closed should update automatically from campaign dates where practical.
- In Production and Quality Inspection may be updated manually by staff in MVP1.
- Shipping and Delivered/Completed may update automatically when Shopify or carrier tracking supports it.
- Every status must support a manual override.

### Individual Order Status

A customer's order may show a more detailed sequence such as:

- Order received
- Campaign open
- Final price confirmed
- Refund issued, if applicable
- In production
- QC complete
- Shipped
- Delivered

The customer-facing experience should make clear whether a status refers to the overall campaign or the customer's specific order.

## MVP1: Minimum Viable Business

The first release is intentionally small. The goal is to launch a fully functioning business capable of accepting and fulfilling orders while keeping internal operations manual wherever practical, except where pricing automation is required to protect margins and maintain Buy Now prices.

### Customer-Facing Features

- Shopify storefront
- Active group-buy campaign pages
- Live or frequently updated buyer count
- Countdown timer
- Tiered pricing display
- Current unlocked price
- Next pricing tier and buyers needed
- Dynamic savings vs. Buy Now display
- Product-specific estimated production and delivery timeline
- Campaign status tracker
- Individual order status tracker where appropriate
- Shopify checkout
- Order confirmation
- Custom jewelry request form
- Inspiration image upload
- Warranty and support information
- FAQ, policies, contact, and about pages
- Past Group Buys section

### Manual Internal Operations

Internal operations may initially use:

- Shopify Admin
- Google Sheets or Airtable
- Email
- Manual campaign closeout
- Manual final-price verification
- Manual partial refunds
- Manual manufacturing exports
- Manual customer updates
- Manual custom-order quoting

The product data model and pricing logic should nevertheless be designed from day one so these manual components can later be automated without restructuring the underlying product records.

## Group-Buy Payment Model

1. Customer joins a campaign.
2. Customer pays immediately.
3. Campaign ends.
4. Final unlocked price is determined.
5. Customers who paid more than the final price receive a partial refund.
6. Manufacturing begins.

Everyone receives the same final price. Community referrals help unlock better pricing for all participants and do not earn customer commissions.

## Custom Jewelry Flow

1. Customer selects “Start a Custom Design.”
2. Customer completes a guided questionnaire.
3. Customer uploads inspiration images or sketches.
4. CaratForUs reviews the request manually.
5. Customer receives a consultation and quote.
6. Payment is collected.
7. CAD, approval, production, inspection, and delivery are handled manually during MVP1.

Initial categories may include:

- Engagement rings
- Wedding bands
- Earrings
- Pendants
- Necklaces
- Bracelets
- Jewelry redesigns
- Other custom concepts

## Payment Strategy

The preferred strategy is to encourage lower-cost payment methods while keeping credit-card payment available.

Potential methods:

- ACH or bank transfer
- Zelle
- PayPal where appropriate
- Credit or debit card at a higher displayed price or with a clearly disclosed fee, subject to processor rules and applicable law

The final payment presentation and fee structure must be reviewed before launch for Shopify, payment-processor, card-network, and legal compliance.

## Deferred Until After Launch

- Full custom admin dashboard
- Automated refund calculations
- Automated refund processing
- Customer referral automation
- Ambassador or influencer commission system
- Merchant portal
- Multi-tenant SaaS architecture
- Advanced analytics dashboard
- Automated manufacturing workflow
- Native mobile applications

## Guiding Rule

If a feature does not help CaratForUs launch sooner, protect pricing/margins, or materially improve the customer experience, it belongs in the backlog.
