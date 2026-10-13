/**
 * Normalizes a Shopify variant identifier to its GID form. Shopify ids
 * arrive from the storefront either bare (`"4455"`) or already as a gid
 * (`"gid://shopify/ProductVariant/4455"`) — same normalization the Group Buy
 * proxy route (`apps.carat.group-buy.$code.tsx`) already performs inline.
 * Pulled out here, pure and unit-tested, so the cart proxy route does not
 * duplicate the logic untested.
 */
const PRODUCT_VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

export function normalizeShopifyVariantGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `${PRODUCT_VARIANT_GID_PREFIX}${rawId}`;
}
