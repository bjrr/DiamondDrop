export const SHOPIFY_HMAC_HEADER = "X-Shopify-Hmac-Sha256";
export const SHOPIFY_TOPIC_HEADER = "X-Shopify-Topic";
export const SHOPIFY_SHOP_DOMAIN_HEADER = "X-Shopify-Shop-Domain";

/**
 * Shopify's unique-per-delivery header used for deduplication. The Slice 0
 * spec refers to this generically as "X-Shopify-Event-Id"; current Shopify
 * webhook documentation names the actual header X-Shopify-Webhook-Id.
 * Centralized here so reconciling against a live payload at the slice 2
 * dev-store smoke test (see docs/ARCHITECTURE-MVP1.md open decision D1) is
 * a one-line change if it ever differs. Flagged for architect review.
 */
export const SHOPIFY_EVENT_ID_HEADER = "X-Shopify-Webhook-Id";
