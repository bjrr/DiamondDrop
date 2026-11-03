/**
 * Where a cart line's authoritative published prices come from.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The cart used to know exactly one way to price a line: find a
 * `master_variant` row, read its last synced calculation. Anything else came
 * back `unknown_variant`, contributed nothing to the totals, and — because the
 * totals were still emitted as plain numbers — a £570 cart rendered as $0.00
 * with a Bank Payment button that silently did nothing.
 *
 * Two distinct faults were tangled together there. One is that the cart could
 * only recognise a single kind of product. The other is that it reported
 * confident zeros when it recognised nothing. This module fixes the first;
 * `PricedCartSummary` below and the DTO's nullable totals fix the second.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECOND PRODUCT CATALOG
 * ---------------------------------------------------------------------------
 * Nothing here stores a product, a price, or an editable field. Every figure
 * is READ from something already published:
 *
 *   - pricing engine  — `master_variant` + its last synced calculation, the
 *                       existing path, untouched;
 *   - vendor mounting — the `carat.bank_payment_price_minor_units` metafield
 *                       that the publish step already wrote, anchored against
 *                       the Shopify variant's own price;
 *   - service         — the Shopify service product's own price.
 *
 * Shopify remains the catalog. The cart CONSUMES published results and
 * recalculates none of them: no vendor cost, no x1.75, no setting, pavé,
 * hidden-halo or ring-size component appears anywhere in this file or
 * anywhere downstream of it. Two engines independently computing one product's
 * price is exactly the failure this avoids.
 */
import type { CartLineMerchandiseInput } from "./types";

/** How a line obtained its published prices. Internal — never serialized. */
export type CartPriceSourceKind = "pricing_engine" | "vendor_mounting" | "service";

/** Why a line could not be priced. Mirrors the DTO's customer-safe reasons. */
export type CartPriceUnresolvedReason =
  /** No pricing source recognises this variant at all. */
  | "unknown_variant"
  /** A pricing-engine variant whose price has never reached Shopify. */
  | "unsynced"
  /** A published source exists but failed validation — see §7. */
  | "unverified_price";

export type CartLinePriceResolution =
  | {
      readonly kind: "resolved";
      readonly source: CartPriceSourceKind;
      readonly currency: string;
      readonly unitBankPaymentPriceMinorUnits: bigint;
      readonly unitRegularCardPriceMinorUnits: bigint;
      /**
       * Whether the Bank Payment discount applies to this line.
       *
       * False for a service: `priceCartLine` then sets the line's bank basis
       * equal to its card basis by construction, so the same amount is charged
       * in both modes and the line contributes exactly zero to the saving —
       * which is §4, obtained from the existing rule rather than from a new
       * branch that would have to be kept in step with it.
       */
      readonly bankPaymentDiscountEligible: boolean;
      /** Present only for the pricing-engine source. */
      readonly masterVariantId?: string;
    }
  | { readonly kind: "unresolved"; readonly reason: CartPriceUnresolvedReason };

/**
 * What a published vendor-mounting metafield must contain to be trusted.
 *
 * Deliberately all strings: this is parsed JSON from a metafield, so every
 * field is suspect until checked. The checks happen in
 * `resolveVendorMountingPrice`, not here.
 */
export interface VendorMountingPublishedPayload {
  readonly priceSource?: unknown;
  readonly currency?: unknown;
  readonly bankPaymentPriceMinorUnits?: unknown;
  readonly regularCardPriceMinorUnits?: unknown;
  readonly bankPaymentSavingsMinorUnits?: unknown;
  readonly shopifyVariantId?: unknown;
  readonly cardPriceAnchorMinorUnits?: unknown;
}

/** What Shopify itself says about the variant, read server-side. */
export interface ShopifyVariantFacts {
  /** Numeric legacy id as a string, e.g. "67939609051354". */
  readonly legacyVariantId: string;
  /** The variant's own price in minor units — the published Regular/Card price. */
  readonly priceMinorUnits: bigint;
  readonly currency: string;
  /** ACTIVE or UNLISTED are sellable; DRAFT and ARCHIVED are not. */
  readonly productStatus: string;
  readonly availableForSale: boolean;
}

const SELLABLE_PRODUCT_STATUSES = new Set(["ACTIVE", "UNLISTED"]);

/** A decimal-string integer, rejecting empty strings, signs and decimals. */
function parseMinorUnits(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,18}$/.test(value)) return null;
  return BigInt(value);
}

/**
 * A vendor mounting's published prices, validated against Shopify (§7).
 *
 * FAILS CLOSED ON EVERY DISAGREEMENT. The metafield and the Shopify variant
 * are two records of the same publish event; if they do not agree, we do not
 * know which is current, and quoting either one would be a guess about money.
 * Checked here, in order:
 *
 *   - the product is sellable and the variant is actually for sale;
 *   - the payload really is a vendor-mounting publish, not some other json;
 *   - bank and card figures parse as positive integer minor units;
 *   - the payload names THIS variant — a metafield copied onto the wrong
 *     variant is otherwise undetectable and would price a size 11 like a 6;
 *   - its card anchor equals the Shopify variant's live price, so a price
 *     edited in Shopify after publish invalidates the stale bank figure
 *     instead of being silently paired with it;
 *   - bank is not greater than card, which would invert the saving.
 *
 * The caller may still sell the line on Card at Shopify's price; only the Bank
 * Payment figure is withheld. That decision is the caller's, not this
 * function's.
 */
export function resolveVendorMountingPrice(
  payload: VendorMountingPublishedPayload | null,
  variant: ShopifyVariantFacts
): CartLinePriceResolution {
  if (!SELLABLE_PRODUCT_STATUSES.has(variant.productStatus) || !variant.availableForSale) {
    return { kind: "unresolved", reason: "unknown_variant" };
  }
  if (!payload || payload.priceSource !== "shopify_vendor_mounting") {
    return { kind: "unresolved", reason: "unknown_variant" };
  }

  const bank = parseMinorUnits(payload.bankPaymentPriceMinorUnits);
  const card = parseMinorUnits(payload.regularCardPriceMinorUnits);
  const anchor = parseMinorUnits(payload.cardPriceAnchorMinorUnits);
  if (bank === null || card === null || anchor === null) {
    return { kind: "unresolved", reason: "unverified_price" };
  }
  if (bank <= 0n || card <= 0n) return { kind: "unresolved", reason: "unverified_price" };
  if (typeof payload.currency !== "string" || payload.currency !== variant.currency) {
    return { kind: "unresolved", reason: "unverified_price" };
  }
  if (payload.shopifyVariantId !== variant.legacyVariantId) {
    return { kind: "unresolved", reason: "unverified_price" };
  }
  if (anchor !== card || card !== variant.priceMinorUnits) {
    return { kind: "unresolved", reason: "unverified_price" };
  }
  if (bank > card) return { kind: "unresolved", reason: "unverified_price" };

  return {
    kind: "resolved",
    source: "vendor_mounting",
    currency: variant.currency,
    unitBankPaymentPriceMinorUnits: bank,
    unitRegularCardPriceMinorUnits: card,
    bankPaymentDiscountEligible: true,
  };
}

/**
 * An approved service line — Stone Removal today (§3, §4).
 *
 * THE SAME AMOUNT IN BOTH MODES. The Shopify product's price is authoritative
 * and is used unchanged for bank and card alike: no merchandise uplift, so $50
 * never becomes $55 on card, and no contribution to the Bank Payment saving,
 * because savings belong to eligible merchandise. Marking the line ineligible
 * is what produces both of those, through the rule that already exists.
 *
 * A service needs no `master_variant` row. Requiring one would mean inventing
 * a jewelry pricing record for a labour charge.
 */
export function resolveServicePrice(variant: ShopifyVariantFacts): CartLinePriceResolution {
  if (!SELLABLE_PRODUCT_STATUSES.has(variant.productStatus) || !variant.availableForSale) {
    return { kind: "unresolved", reason: "unknown_variant" };
  }
  if (variant.priceMinorUnits <= 0n) {
    return { kind: "unresolved", reason: "unverified_price" };
  }
  return {
    kind: "resolved",
    source: "service",
    currency: variant.currency,
    unitBankPaymentPriceMinorUnits: variant.priceMinorUnits,
    unitRegularCardPriceMinorUnits: variant.priceMinorUnits,
    bankPaymentDiscountEligible: false,
  };
}

/** Turn a resolution into the shape `priceCart` consumes. */
export function toMerchandiseLine(
  lineId: string,
  quantity: bigint,
  resolution: Extract<CartLinePriceResolution, { kind: "resolved" }>,
  /** Synthesised for sources that have no pricing-engine record. */
  masterVariantIdFallback: string
): CartLineMerchandiseInput {
  return {
    lineId,
    masterVariantId: resolution.masterVariantId ?? masterVariantIdFallback,
    quantity,
    currency: resolution.currency,
    bankPaymentDiscountEligible: resolution.bankPaymentDiscountEligible,
    unitBankPaymentPriceMinorUnits: resolution.unitBankPaymentPriceMinorUnits,
    unitRegularCardPriceMinorUnits: resolution.unitRegularCardPriceMinorUnits,
  };
}

/**
 * Whether a cart's pricing is complete enough to state totals at all.
 *
 * THE $0.00 GUARD. A cart with unpriced lines has an UNKNOWN total, not a zero
 * one, and the difference is the whole point: the previous behaviour summed
 * the lines it understood (none) and published the result (zero) as though it
 * were a fact. A customer looking at a $570 cart was told $0.00.
 *
 * `totalsArePublishable` is false whenever any requested line failed to
 * resolve. The DTO then emits `null` for every cart-level total rather than a
 * number, so a client cannot render a false zero even by ignoring the flag —
 * there is no zero in the payload to render.
 *
 * `bankPaymentAvailable` is deliberately the same condition rather than a
 * weaker one. Bank Payment is settled by hand against a figure we quoted; it
 * must never be offered on a cart whose total we could not establish.
 */
export interface PricedCartSummary {
  readonly totalsArePublishable: boolean;
  readonly bankPaymentAvailable: boolean;
  readonly unpurchasableLineCount: number;
}

export function summarisePricedCart(
  requestedLineCount: number,
  unpurchasableLineCount: number
): PricedCartSummary {
  const complete = unpurchasableLineCount === 0 && requestedLineCount > 0;
  return {
    totalsArePublishable: complete,
    bankPaymentAvailable: complete,
    unpurchasableLineCount,
  };
}
