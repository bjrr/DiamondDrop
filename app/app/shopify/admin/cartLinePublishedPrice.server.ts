import type { AdminGraphqlClient } from "./productClient.server";
import {
  resolveServicePrice,
  resolveVendorMountingPrice,
  type CartLinePriceResolution,
  type ShopifyVariantFacts,
  type VendorMountingPublishedPayload,
} from "~/domain/cart/pricingSource";
import { logger } from "~/lib/logger.server";

/**
 * Reads the PUBLISHED prices Shopify already holds, for cart lines that have
 * no pricing-engine record.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * Not a catalog, not a cache, not a second pricing engine. It performs one
 * batched read and hands the values to the pure validators in
 * `~/domain/cart/pricingSource`, which decide whether they may be trusted.
 * Nothing is written. No vendor cost, markup, setting, pavé, hidden-halo or
 * ring-size component is read, let alone recomputed — the mounting's price was
 * calculated when it was published, and this consumes that result.
 *
 * ONE ROUND TRIP FOR THE WHOLE CART. `nodes(ids:)` takes every unresolved
 * variant at once; a per-line request would put a Shopify round trip inside a
 * loop on the cart's critical path.
 *
 * A FAILED READ IS NOT A FREE CART. Any error leaves the lines unresolved,
 * which makes the cart's totals unpublishable and Bank Payment unavailable —
 * the customer sees Shopify's own prices and a clear message. It must never
 * degrade into zero.
 */
const QUERY = `
  query CartLinePublishedPrices($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        legacyResourceId
        price
        availableForSale
        bankPayment: metafield(namespace: "carat", key: "bank_payment_price_minor_units") { value }
        product {
          status
          priceSource: metafield(namespace: "carat", key: "cart_price_source") { value }
        }
      }
    }
  }
`;

/** A money string such as "520.00" to integer minor units, without floats. */
export function shopifyMoneyToMinorUnits(amount: string): bigint | null {
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) return null;
  const whole = match[1] as string;
  const frac = (match[2] ?? "").padEnd(2, "0");
  return BigInt(whole) * 100n + BigInt(frac);
}

function parsePayload(value: unknown): VendorMountingPublishedPayload | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as VendorMountingPublishedPayload;
  } catch {
    // A metafield holding something that is not json is not a price.
    return null;
  }
}

export interface CartLinePriceLookup {
  /** Keyed by variant gid. Every requested gid is present. */
  readonly byVariantGid: ReadonlyMap<string, CartLinePriceResolution>;
}

/**
 * Resolve published prices for variants Shopify owns.
 *
 * `currency` is the storefront's single currency; Shopify's `variant.price` is
 * expressed in it, and the vendor payload's own currency is checked against it
 * by the validator rather than being trusted.
 */
export async function readCartLinePublishedPrices(
  admin: AdminGraphqlClient,
  variantGids: readonly string[],
  currency: string
): Promise<CartLinePriceLookup> {
  const byVariantGid = new Map<string, CartLinePriceResolution>();
  if (variantGids.length === 0) return { byVariantGid };

  const unresolved = (reason: "unknown_variant" | "unverified_price") =>
    ({ kind: "unresolved", reason }) as const;
  for (const gid of variantGids) byVariantGid.set(gid, unresolved("unknown_variant"));

  let nodes: unknown[] = [];
  try {
    const response = await admin.graphql(QUERY, { variables: { ids: [...variantGids] } });
    const body = (await response.json()) as {
      data?: { nodes?: unknown[] };
      errors?: unknown;
    };
    if (body.errors) {
      logger.warn("cart.published_price_read_errors", { count: variantGids.length });
      return { byVariantGid };
    }
    nodes = body.data?.nodes ?? [];
  } catch (error) {
    // Leaves every line unresolved on purpose. See the module comment: a
    // failed read must not turn into a priced cart.
    logger.warn("cart.published_price_read_failed", {
      message: error instanceof Error ? error.message : "unknown",
      count: variantGids.length,
    });
    return { byVariantGid };
  }

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const v = node as {
      id?: string;
      legacyResourceId?: string;
      price?: string;
      availableForSale?: boolean;
      bankPayment?: { value?: string } | null;
      product?: { status?: string; priceSource?: { value?: string } | null } | null;
    };
    if (typeof v.id !== "string") continue;

    const priceMinorUnits =
      typeof v.price === "string" ? shopifyMoneyToMinorUnits(v.price) : null;
    if (priceMinorUnits === null) {
      byVariantGid.set(v.id, unresolved("unverified_price"));
      continue;
    }

    const facts: ShopifyVariantFacts = {
      legacyVariantId: String(v.legacyResourceId ?? ""),
      priceMinorUnits,
      currency,
      productStatus: String(v.product?.status ?? ""),
      availableForSale: v.availableForSale === true,
    };

    // A service is identified by an explicit product metafield, not by a
    // price of $50 or a title containing "service" — guessing which products
    // are labour would be a guess about money.
    if (v.product?.priceSource?.value === "service") {
      byVariantGid.set(v.id, resolveServicePrice(facts));
      continue;
    }

    byVariantGid.set(
      v.id,
      resolveVendorMountingPrice(parsePayload(v.bankPayment?.value), facts)
    );
  }

  return { byVariantGid };
}
