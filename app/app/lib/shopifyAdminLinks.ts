/**
 * Links from the embedded app out to Shopify Admin.
 *
 * ===========================================================================
 * DERIVED FROM THE AUTHENTICATED SHOP, NEVER GUESSED
 * ===========================================================================
 * `session.shop` is always `<handle>.myshopify.com`, and the admin for that
 * store is always `https://admin.shopify.com/store/<handle>/...`. That much
 * is stable and documented, so these builders take the shop domain and do
 * nothing cleverer than read the handle off the front of it.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT HERE: A FILTERED CUSTOMERS LINK
 * ===========================================================================
 * There is no `customersFilteredByTag()`. A query-string filter format for
 * the admin customers index is not something this codebase has verified, and
 * a link that silently lands on an unfiltered list, or on an error, is worse
 * than no link: staff would trust the filter and act on the wrong set.
 *
 * So the First Access card links to Customers and TELLS the reader to filter
 * by `first-access`. One extra click, and it is always correct. If the format
 * is later confirmed against real Shopify documentation, add it here with a
 * test and the card picks it up.
 */

/** `nnb1th-cm.myshopify.com` -> `nnb1th-cm`. Null when the shape is not recognised. */
export function storeHandleFromShopDomain(shopDomain: string): string | null {
  const trimmed = shopDomain.trim().toLowerCase();
  const match = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(trimmed);
  return match?.[1] ?? null;
}

function adminBase(shopDomain: string): string | null {
  const handle = storeHandleFromShopDomain(shopDomain);
  return handle ? `https://admin.shopify.com/store/${handle}` : null;
}

/** The Customers index. Null when the shop domain is not a recognised myshopify host. */
export function shopifyAdminCustomersUrl(shopDomain: string): string | null {
  const base = adminBase(shopDomain);
  return base ? `${base}/customers` : null;
}

/** The Products index, where products, variants, media and inventory are managed. */
export function shopifyAdminProductsUrl(shopDomain: string): string | null {
  const base = adminBase(shopDomain);
  return base ? `${base}/products` : null;
}

/** The tag staff should filter Customers by to find First Access signups. */
export const FIRST_ACCESS_CUSTOMER_TAG = "first-access";
