---
name: shopify-integration
description: Implement or review CaratForUs Shopify integration using native capabilities first, least privilege, idempotent webhooks, and preserved transaction evidence.
---

# Shopify Integration

Use for Shopify theme/app/API/webhook/product-model work.

1. Read `CLAUDE.md`, the feature spec, relevant `README.md`, and applicable locked policies.
2. Identify whether Shopify already provides the needed capability natively before custom-building it.
3. Define the Shopify objects involved: products, variants, inventory, collections, metafields/metaobjects, cart line properties, discounts, customers, orders, fulfillment, checkout, or webhooks.
4. Keep native checkout/accounts/orders/email wherever practical.
5. Preserve exact purchased configuration and policy/acknowledgment evidence required by CaratForUs.
6. Treat inventory as authoritative for Luxury Steals scarcity; no oversell/backorder where prohibited.
7. Make webhook processing authenticated, idempotent, replay-safe, and auditable.
8. Use least-privilege API scopes and never expose private cost/margin/admin data to storefront clients.
9. Do not reimplement authoritative pricing/eligibility rules in Liquid or browser JavaScript.
10. Document Shopify limitations and escalate any conflict with a locked business requirement.
11. Test variant/cart behavior, inventory/sold-out behavior, acknowledgments, webhook duplicates, and failure states relevant to the feature.

Required handoff includes Shopify objects/scopes used, files changed, webhooks/events, tests run/results, manual Shopify configuration, limitations, and architect-review items.