# Luxury Steals — MVP1 Locked Specification

## Status
This document is the authoritative locked MVP1 specification for the CaratForUs **Luxury Steals** merchandising feature.

Luxury Steals is a dedicated section for exceptionally low-priced, limited-availability jewelry intended for quick sale. It is not a separate checkout platform or commerce engine. Use normal Shopify Buy Now checkout and inventory capabilities wherever practical, with the special merchandising, eligibility, acknowledgment, and return rules below.

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
- clear Luxury Steal identification on relevant product cards and product pages;
- normal Shopify cart and checkout wherever practical.

Luxury Steals may include rings, bracelets, necklaces, earrings, diamond jewelry, gemstone jewelry, gold jewelry, one-off pieces, discontinued designs, overstock, or other jewelry CaratForUs deliberately assigns to the collection.

## Pricing and Promotions

Luxury Steals are intentionally extreme-value offers and may use pricing materially below normal CaratForUs Buy Now pricing.

- The assigned Luxury Steal price must be explicit and auditable.
- The storefront must not fabricate comparison prices or savings claims.
- Additional coupons/promotional codes are not automatically allowed on Luxury Steals. They may be accepted only when an authorized promotion explicitly includes Luxury Steals.
- The **Let Us Beat Your Quote!** 10%-off fallback benefit does **not** apply to Luxury Steals unless the locked quote-match policy is later changed.

## Discretionary Return Rule

Luxury Steals have a special return remedy because of their extreme pricing.

Customer-facing principle:

**No cash refunds for discretionary Luxury Steals returns. Approved discretionary returns receive merchandise credit only.**

Do not describe the policy simply as "no returns" if CaratForUs permits an approved return for merchandise credit.

An approved RMA is required before a discretionary Luxury Steal item is sent back. Sending merchandise without an approved RMA does not itself create return eligibility.

Returned merchandise must satisfy the applicable condition/identity requirements established by CaratForUs, including being the same item/configuration shipped and not being damaged, altered, or used beyond reasonable inspection/try-on, subject to applicable law and any separately stated product-specific restrictions.

The merchandise-credit mechanism must be traceable. Retain the order/RMA reference, eligible amount, credit amount, issue date, store-credit reference, and relevant status/history.

### Important separation from claims and warranty

The merchandise-credit-only rule applies to **discretionary/buyer-remorse returns**. It must not automatically control claims involving:
- defective merchandise;
- wrong item or wrong specifications;
- shipping/transit damage;
- materially not as described merchandise;
- duplicate/incorrect charges;
- non-delivery;
- warranty claims; or
- other rights/remedies required by applicable law or payment-network rules.

Those matters must route to the appropriate claim, warranty, fulfillment-error, payment, or legal workflow rather than automatically being converted to merchandise credit.

## Required Customer Disclosure and Acknowledgment

The special Luxury Steals return restriction is material and must be conspicuously disclosed before purchase.

Require an explicit, unchecked acknowledgment before the customer can complete the applicable Luxury Steal purchase. A branded modal or equivalent explicit confirmation may be used.

Approved customer-facing direction:

> **I understand this Luxury Steal is a limited-availability promotional item and is not eligible for a discretionary cash refund. Approved discretionary returns receive merchandise credit only.**

The implementation must retain:
- exact acknowledgment text;
- acknowledgment/policy version;
- timestamp;
- customer/order/cart reference as available;
- Luxury Steal product/variant reference;
- affirmative acceptance action.

Do not pre-check the acknowledgment and do not silently infer acceptance.

The applicable terms should also be visible on the Luxury Steal product experience and repeated in appropriate order-confirmation/transaction records so the customer is not surprised after purchase.

## Evidence and Auditability

For each Luxury Steal transaction, preserve enough information to establish:
- exact product and variant/configuration purchased;
- Luxury Steal price charged;
- quantity and inventory state relevant to fulfillment;
- applicable Luxury Steals policy version;
- exact required acknowledgment/version and acceptance timestamp;
- order/payment references;
- fulfillment/tracking/delivery evidence available through the normal CaratForUs/Shopify process;
- any RMA request and reason;
- inspection/condition outcome where a return occurs;
- merchandise-credit amount and reference;
- any manual exception and reason.

Duplicate/retried return or credit events must not issue duplicate customer value.

## Relationship to Other CaratForUs Purchase Paths

Luxury Steals is a merchandising/sale category using normal Shopify Buy Now purchasing where practical. It does not replace or alter the separate rules for:
- standard Buy Now merchandise;
- Community Group Buys;
- Custom Jewelry; or
- Let Us Beat Your Quote submissions.

A product assigned to Luxury Steals must use the Luxury Steals customer-facing disclosure and discretionary-return remedy for that sale rather than silently inheriting the standard Buy Now discretionary-return promise.

## MVP1 Acceptance Cases

Implementation/review must verify at minimum:
1. An in-stock Luxury Steal can be purchased through the approved Shopify flow.
2. Inventory reaching zero prevents further purchase and presents a sold-out/unavailable state.
3. Backorders/overselling are not allowed.
4. Quantity-scarcity messaging never displays a fabricated remaining quantity.
5. A customer cannot complete the applicable Luxury Steal purchase without affirmatively accepting the special return acknowledgment.
6. The exact acknowledgment text/version and acceptance evidence are retained with the transaction evidence.
7. A discretionary return that is otherwise approved results in merchandise credit rather than a cash refund.
8. A defect, wrong-item/specification, shipping-damage, materially-not-as-described, or warranty claim is not automatically forced into merchandise credit.
9. Duplicate/retried merchandise-credit processing cannot issue duplicate value.
10. The Let Us Beat Your Quote fallback discount cannot be redeemed on a Luxury Steal unless an authorized locked policy change explicitly allows it.
11. Standard Shopify checkout/order behavior is reused rather than building a separate checkout system.

## Unsettled Operational Details

Do not invent these rules during implementation. They require owner approval if/when needed:
- exact RMA request window for Luxury Steals;
- exact return-receipt deadline after RMA approval;
- who pays Luxury Steals return shipping;
- treatment of original/outbound shipping charges;
- merchandise-credit expiration or transferability;
- tax treatment of merchandise credit/returns;
- whether any specific Luxury Steal categories are completely final sale rather than credit-eligible;
- holiday extensions or special-event exceptions.

Until those details are locked, implementation must not silently copy the standard Buy Now return windows or create new customer promises.