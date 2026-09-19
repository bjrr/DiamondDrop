import type { PublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";

/**
 * The price-bearing metafield payload contract (Slice 2 stage 2B entry
 * condition C5 / spec §16.2 criterion 56).
 *
 * THE HAZARD THIS CLOSES. Publishing a price to Shopify involves TWO Admin
 * API calls: `productVariantsBulkUpdate` (the variant price — the Regular/
 * Card Price, native) and `metafieldsSet` (the Bank Payment Price, for the
 * theme to render — `ARCHITECTURE-MVP1.md` §5, "presentation cache"). They
 * can partially fail independently, leaving Shopify showing a card price
 * from one calculation beside a bank price from another — a wrong saving,
 * silently displayed as though it were correct.
 *
 * WHY THE ID LIVES INSIDE THE METAFIELD'S OWN VALUE, NOT IN A SIBLING FIELD.
 * `metafieldsSet` accepts an array and reports success/failure PER FIELD
 * (`userErrors` is keyed to individual entries) — so two sibling metafields
 * written in the "same" call are not actually atomic with each other, only
 * with themselves. A single field's own value IS all-or-nothing. Every
 * price-bearing metafield below is therefore a small JSON document whose
 * OWN payload carries `priceCalculationId`, so staleness can be detected
 * from that one field alone, with no dependency on a second field having
 * landed in the same call.
 *
 * `priceCalculationId` IS A CACHE-STALENESS MARKER, NOT A SOURCE OF TRUTH.
 * Per `ARCHITECTURE-MVP1.md` §5, metafields are a presentation cache; money
 * is never reconciled from them. The id exists so the THEME can tell a
 * fully-published price pair from a partially-applied write and suppress
 * the Bank Payment block rather than render a mismatched one — never so
 * server-side code can trust the metafield's own numbers as authoritative.
 * `publishedPriceRepository.server.ts` (criterion 52) remains the only
 * source of truth for what a variant's published price actually is;
 * `priceMetafieldCoherence.server.ts` in this directory is what checks a
 * metafield payload AGAINST that source of truth, server-side.
 *
 * C-S5 / R14: no cost, margin, supplier, breakdown, uplift rate, tier label
 * or rule id may appear in a metafield. `PublishedVariantPrice.appliedUpliftRate`
 * and `.appliedTierLabel` are therefore never read by any builder below —
 * only the four customer-facing figures (bank price, card price, saving,
 * currency) and the calculation id cross into a metafield payload.
 */

export const PRICE_METAFIELD_NAMESPACE = "carat" as const;

export interface PriceMetafieldWriteInput {
  /** The Shopify GID of the variant or product this metafield is set on. */
  readonly ownerId: string;
  readonly namespace: typeof PRICE_METAFIELD_NAMESPACE;
  readonly key: string;
  readonly type: "json" | "boolean";
  /** Already-serialized — this module never hands a caller a value to serialize itself. */
  readonly value: string;
}

/**
 * The fields common to every PRICE-BEARING metafield payload. `masterVariantId`
 * is always the variant whose synced calculation this price was derived
 * from — for the product-level "as low as" metafield, that is the WINNING
 * variant that set the headline price, not the product itself.
 */
export interface PriceBearingMetafieldPayload {
  readonly masterVariantId: string;
  readonly priceCalculationId: string;
  readonly currency: string;
  /** Decimal-string minor units — never a JS number (money-safety, Tier 2). */
  readonly bankPaymentPriceMinorUnits: string;
}

export interface VariantBankPaymentMetafieldPayload extends PriceBearingMetafieldPayload {
  readonly regularCardPriceMinorUnits: string;
  readonly bankPaymentSavingsMinorUnits: string;
}

export type ProductAsLowAsMetafieldPayload = PriceBearingMetafieldPayload;

/**
 * Variant-level `carat.bank_payment_price_minor_units` (spec §6). Type
 * `json`, not a bare number — see the module doc comment for why the
 * calculation id must live inside this same value rather than a sibling
 * field.
 */
export function buildVariantBankPaymentPriceMetafield(
  shopifyVariantGid: string,
  published: PublishedVariantPrice
): PriceMetafieldWriteInput {
  const payload: VariantBankPaymentMetafieldPayload = {
    masterVariantId: published.masterVariantId,
    priceCalculationId: published.priceCalculationId,
    currency: published.currency,
    bankPaymentPriceMinorUnits: published.bankPaymentPriceMinorUnits.toString(),
    regularCardPriceMinorUnits: published.regularCardPriceMinorUnits.toString(),
    bankPaymentSavingsMinorUnits: published.bankPaymentSavingsMinorUnits.toString(),
  };
  return {
    ownerId: shopifyVariantGid,
    namespace: PRICE_METAFIELD_NAMESPACE,
    key: "bank_payment_price_minor_units",
    type: "json",
    value: JSON.stringify(payload),
  };
}

/**
 * Product-level `carat.as_low_as_bank_minor_units` (spec §6, owner §3 "As
 * low as $X"). `winningPrice` is the currently-purchasable variant with the
 * lowest published Bank Payment Price (criteria 28/29) — selection itself
 * is out of scope here; this only shapes the write once a caller has
 * already chosen the winner.
 */
export function buildProductAsLowAsMetafield(
  shopifyProductGid: string,
  winningPrice: PublishedVariantPrice
): PriceMetafieldWriteInput {
  const payload: ProductAsLowAsMetafieldPayload = {
    masterVariantId: winningPrice.masterVariantId,
    priceCalculationId: winningPrice.priceCalculationId,
    currency: winningPrice.currency,
    bankPaymentPriceMinorUnits: winningPrice.bankPaymentPriceMinorUnits.toString(),
  };
  return {
    ownerId: shopifyProductGid,
    namespace: PRICE_METAFIELD_NAMESPACE,
    key: "as_low_as_bank_minor_units",
    type: "json",
    value: JSON.stringify(payload),
  };
}

/**
 * Variant-level `carat.bank_payment_eligible` (spec §6, owner §7.3,
 * `master_variant.bankPaymentDiscountEligible`). NOT price-bearing — a
 * boolean flag carries no price and therefore no `priceCalculationId`.
 * Postgres remains the system of record (criterion 40); this is presentation
 * cache only.
 */
export function buildVariantBankPaymentEligibleMetafield(
  shopifyVariantGid: string,
  eligible: boolean
): PriceMetafieldWriteInput {
  return {
    ownerId: shopifyVariantGid,
    namespace: PRICE_METAFIELD_NAMESPACE,
    key: "bank_payment_eligible",
    type: "boolean",
    value: eligible ? "true" : "false",
  };
}

/**
 * Variant-level `carat.sync_suspended` (spec §6, owner §4 48-hour
 * withdrawal). NOT price-bearing, same reasoning as the eligibility flag
 * above.
 */
export function buildVariantSyncSuspendedMetafield(
  shopifyVariantGid: string,
  suspended: boolean
): PriceMetafieldWriteInput {
  return {
    ownerId: shopifyVariantGid,
    namespace: PRICE_METAFIELD_NAMESPACE,
    key: "sync_suspended",
    type: "boolean",
    value: suspended ? "true" : "false",
  };
}

export class MalformedPriceMetafieldValueError extends Error {
  constructor(reason: string) {
    super(`Malformed price-bearing metafield value: ${reason}`);
    this.name = "MalformedPriceMetafieldValueError";
  }
}

/**
 * Parses a price-bearing metafield's `value` string back into its payload.
 * Used by the theme-adjacent read path and by
 * `priceMetafieldCoherence.server.ts`. Validates the required fields are
 * present rather than trusting `JSON.parse`'s result shape — a metafield is
 * external, cached data that this app itself wrote, but a partially-applied
 * write or a future format change should fail loudly here rather than
 * produce `undefined.toString()` deeper in a caller.
 */
export function parsePriceBearingMetafieldValue(value: string): PriceBearingMetafieldPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MalformedPriceMetafieldValueError("value is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new MalformedPriceMetafieldValueError("value is not a JSON object");
  }
  const candidate = parsed as Partial<PriceBearingMetafieldPayload>;
  if (
    typeof candidate.masterVariantId !== "string" ||
    typeof candidate.priceCalculationId !== "string" ||
    typeof candidate.currency !== "string" ||
    typeof candidate.bankPaymentPriceMinorUnits !== "string"
  ) {
    throw new MalformedPriceMetafieldValueError(
      "missing or non-string masterVariantId, priceCalculationId, currency or bankPaymentPriceMinorUnits"
    );
  }
  return {
    masterVariantId: candidate.masterVariantId,
    priceCalculationId: candidate.priceCalculationId,
    currency: candidate.currency,
    bankPaymentPriceMinorUnits: candidate.bankPaymentPriceMinorUnits,
  };
}

export interface PriceMetafieldCoherenceCheck {
  readonly coherent: boolean;
  readonly embeddedPriceCalculationId: string;
  readonly publishedPriceCalculationId: string | null;
}

/**
 * The PURE half of the coherence check: does the id embedded in a
 * price-bearing metafield's payload match the variant's actually-published
 * calculation? No database access here — `priceMetafieldCoherence.server.ts`
 * resolves `publishedPriceCalculationId` (from
 * `master_variant.lastSyncedPriceCalculationId`, the criterion 52 anchor)
 * and calls this function to decide, so the decision itself is testable
 * with no database.
 *
 * `publishedPriceCalculationId: null` (never synced) is never coherent — a
 * metafield naming a calculation for a variant that has no published price
 * at all is exactly the mismatch this check exists to catch, not an edge
 * case to wave through.
 */
export function compareMetafieldToPublishedCalculation(
  embeddedPriceCalculationId: string,
  publishedPriceCalculationId: string | null
): PriceMetafieldCoherenceCheck {
  return {
    coherent: publishedPriceCalculationId !== null && publishedPriceCalculationId === embeddedPriceCalculationId,
    embeddedPriceCalculationId,
    publishedPriceCalculationId,
  };
}
