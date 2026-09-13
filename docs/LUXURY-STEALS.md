# Luxury Steals — MVP1 Locked Specification

## Status
This document is the authoritative locked MVP1 specification for the CaratForUs **Luxury Steals** merchandising feature.

Luxury Steals is a dedicated section for exceptionally low-priced, limited-availability jewelry intended for quick sale. It is not a separate checkout platform or commerce engine. Use normal Shopify Buy Now checkout and inventory capabilities wherever practical, with the special merchandising, eligibility, acknowledgment, and final-sale rules below.

## Customer-Facing Name and Positioning

Feature/collection name:

**Luxury Steals**

Recommended positioning direction:

**Exceptional jewelry. Exceptional prices. Very limited quantities.**

Supporting scarcity message:

**Once they're gone, they're gone.**

Recommended CTA:

**Shop Luxury Steals**

Product-card merchandising may use clear badges such as:
- **LUXURY STEAL**
- **ONLY 1 LEFT** where accurate
- **FINAL PIECES** where accurate
- **FINAL SALE**

Do not call this section "Doorbusters" in the primary customer experience. The intent is extreme value and urgency while preserving CaratForUs's premium/trustworthy positioning.

## Inventory and Availability

Luxury Steals are limited-quantity items.

MVP1 requirements:
- Use real inventory quantities.
- Do not oversell.
- Do not allow backorders.
- Automatically become unavailable/sold out when inventory reaches zero.
- "Only X left" or similar quantity messaging may be shown only when it reflects actual available inventory.
- There is no required waitlist or restock promise in MVP1.
- Customer-facing messaging may emphasize that once available inventory is sold, the offer is gone.

## Storefront Placement

MVP1 should support:
- a dedicated **Luxury Steals** collection/landing page;
- a homepage Luxury Steals section featuring selected available items;
- clear Luxury Steal and Final Sale identification on relevant product cards and product pages;
- normal Shopify cart and checkout wherever practical.

Luxury Steals may include rings, bracelets, necklaces, earrings, diamond jewelry, gemstone jewelry, gold jewelry, one-off pieces, discontinued designs, overstock, or other jewelry CaratForUs deliberately assigns to the collection.

## Pricing and Promotions

Luxury Steals are intentionally extreme-value offers and may use pricing materially below normal CaratForUs Buy Now pricing.

- The assigned Luxury Steal price must be explicit and auditable.
- The storefront must not fabricate comparison prices or savings claims.
- Additional coupons/promotional codes are not automatically allowed on Luxury Steals. They may be accepted only when an authorized promotion explicitly includes Luxury Steals.
- The **Let Us Beat Your Quote!** 10%-off fallback benefit does **not** apply to Luxury Steals unless the locked quote-match policy is later changed.

## FINAL SALE — LOCKED DECISION

**All Luxury Steals purchases are FINAL SALE.**

Luxury Steals are not eligible for discretionary:
- returns;
- exchanges;
- cash refunds; or
- merchandise-credit returns.

This includes buyer's remorse, changing one's mind, preferring another style, selecting the wrong size or configuration, or otherwise no longer wanting the correctly supplied item.

There is no discretionary Luxury Steals RMA/return window because discretionary returns and exchanges are not offered.

### Important separation from claims and warranty

"Final Sale" does **not** mean CaratForUs has no responsibility after purchase and must not be presented that way.

The Final Sale restriction applies to discretionary returns/exchanges. It must not automatically eliminate or limit the appropriate workflow/remedy for:
- defective merchandise;
- wrong item or wrong specifications;
- shipping/transit damage;
- materially not as described merchandise;
- duplicate/incorrect charges;
- non-delivery;
- applicable warranty claims; or
- other rights/remedies required by applicable law, card-network rules, or payment-processor rules.

Those matters must route to the appropriate claim, warranty, fulfillment-error, payment, or legal workflow rather than being denied merely because the product is a Luxury Steal.

## Required Customer Disclosure and Acknowledgment

The Final Sale restriction is material and must be conspicuously disclosed before purchase.

Require an explicit, unchecked acknowledgment before the customer can complete the applicable Luxury Steal purchase. A branded modal or equivalent explicit confirmation may be used.

Approved customer-facing direction:

> **FINAL SALE ACKNOWLEDGMENT**
>
> I understand that this item is a Luxury Steal and is **FINAL SALE**. I understand that it cannot be returned or exchanged because I change my mind, prefer another style, select the wrong size or configuration, or otherwise no longer want the item. I have reviewed the item specifications and selected options before purchasing.

Recommended affirmative action:

**I Understand & Agree**

The implementation must retain:
- exact acknowledgment text;
- acknowledgment/policy version;
- timestamp;
- customer/order/cart reference as available;
- Luxury Steal product/variant/configuration reference;
- affirmative acceptance action.

Do not pre-check the acknowledgment and do not silently infer acceptance.

The Final Sale terms must also be clearly visible on the Luxury Steal product experience and repeated in appropriate order-confirmation/transaction records so the customer is not surprised after purchase.

## Evidence and Auditability

For each Luxury Steal transaction, preserve enough information to establish:
- exact product and variant/configuration purchased;
- Luxury Steal price charged;
- quantity and inventory state relevant to fulfillment;
- applicable Luxury Steals policy version;
- exact Final Sale acknowledgment/version and acceptance timestamp;
- order/payment references;
- fulfillment/tracking/delivery evidence available through the normal CaratForUs/Shopify process;
- any subsequent claim and stated reason;
- inspection/evidence outcome where a defect, wrong-item/specification, damage, materially-not-as-described, or warranty claim occurs;
- any refund/replacement/repair/other remedy reference when applicable;
- any manual exception and reason.

Duplicate/retried claim, refund, replacement, or other remedy events must not create duplicate customer value.

## Relationship to Other CaratForUs Purchase Paths

Luxury Steals is a merchandising/sale category using normal Shopify Buy Now purchasing where practical. It does not replace or alter the separate rules for:
- standard Buy Now merchandise;
- Community Group Buys;
- Custom Jewelry; or
- Let Us Beat Your Quote submissions.

A product assigned to Luxury Steals must use the Luxury Steals Final Sale disclosure for that sale rather than silently inheriting the standard Buy Now discretionary-return promise.

## MVP1 Acceptance Cases

Implementation/review must verify at minimum:
1. An in-stock Luxury Steal can be purchased through the approved Shopify flow.
2. Inventory reaching zero prevents further purchase and presents a sold-out/unavailable state.
3. Backorders/overselling are not allowed.
4. Quantity-scarcity messaging never displays a fabricated remaining quantity.
5. Final Sale is conspicuously disclosed before purchase.
6. A customer cannot complete the applicable Luxury Steal purchase without affirmatively accepting the Final Sale acknowledgment.
7. The exact acknowledgment text/version and acceptance evidence are retained with the transaction evidence.
8. A buyer-remorse/change-of-mind/style/size/configuration request does not qualify for a discretionary return, exchange, cash refund, or merchandise credit.
9. A defect, wrong-item/specification, shipping-damage, materially-not-as-described, non-delivery, payment-error, or applicable warranty claim is not automatically denied because the item is Final Sale.
10. Duplicate/retried claim or remedy processing cannot create duplicate customer value.
11. The Let Us Beat Your Quote fallback discount cannot be redeemed on a Luxury Steal unless an authorized locked policy change explicitly allows it.
12. Standard Shopify checkout/order behavior is reused rather than building a separate checkout system.

## Remaining Operational Matters

Because Luxury Steals are Final Sale, there is no discretionary return window, return-receipt deadline, discretionary return-shipping rule, merchandise-credit expiration rule, or holiday discretionary-return extension to define.

Any shipping, inspection, return, repair, replacement, refund, or other remedy needed for a legitimate defect, wrong-item/specification, shipping-damage, materially-not-as-described, non-delivery, payment-error, warranty, or legally required claim is governed by the applicable CaratForUs claim/warranty/fulfillment policy rather than a Luxury Steals buyer-remorse return policy.

Do not invent additional discretionary exceptions during implementation without owner approval.