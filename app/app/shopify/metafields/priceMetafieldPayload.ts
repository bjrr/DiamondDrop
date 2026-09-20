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
 *
 * OWNER RULING R14 (2026-09-20) — SELF-VALIDATING ANCHOR/IDENTITY FIELDS.
 * `priceCalculationId` alone catches a MISMATCHED write (criterion 56), but
 * not a FAILED one that leaves an old, internally-consistent value in place:
 * its embedded id genuinely was published once, so nothing about the value
 * looks wrong even though a real Shopify price mutation has since moved on
 * without it. R14's fix needs no new field to keep in sync with anything —
 * it reuses a value Liquid ALREADY holds independently: Shopify's own live
 * `variant.price`. Every price-bearing payload below therefore also embeds:
 *
 *   - `shopifyVariantId` — the LIQUID-NATIVE numeric variant id (the same
 *     value Liquid exposes as `variant.id`), so the theme can find the
 *     variant this figure is anchored to in `product.variants` and read its
 *     real `.available`;
 *   - `cardPriceAnchorMinorUnits` — the Regular/Card Price AT WRITE TIME, in
 *     the exact integer-minor-units form Liquid's `variant.price` already
 *     uses, so the theme can compare the two with a bare `==` and no casting.
 *
 * A stale write is now self-detecting: the native `productVariantsBulkUpdate`
 * call is what actually moves `variant.price`, so if a LATER price mutation
 * succeeded while THIS metafield's write failed, `cardPriceAnchorMinorUnits`
 * silently falls out of step with the live `variant.price` — no separate
 * generation counter or timestamp needed, because the thing being compared
 * against cannot itself go stale (it IS the current price). The same pair
 * also closes the purchasability gap for the product-level aggregate: if the
 * SOURCE variant a "the as low as" figure was derived from sells out between
 * publishes, `shopifyVariantId` lets the theme re-check that exact variant's
 * `.available` directly, rather than falling back to the product-wide
 * `product.available` proxy (true only when EVERY variant is unavailable).
 *
 * UNITS, STATED EXPLICITLY BECAUSE A MISMATCH HERE FAILS CLOSED AND SILENT.
 * `cardPriceAnchorMinorUnits` is `regularCardPriceMinorUnits` — MINOR units
 * (cents for USD), matching `variant.price` in Liquid exactly (Liquid's own
 * money objects are always raw integers in the shop's smallest currency
 * unit; the Admin API's own `ProductVariant.price` field is a DIFFERENT,
 * decimal-string, MAJOR-units representation — e.g. "104.00" — and must
 * never be confused with this one). `shopifyVariantId` is the plain numeric
 * id Liquid exposes as `variant.id` — verified live against
 * caratforus-dev.myshopify.com (Admin API 2026-07), 2026-09-20, that
 * `ProductVariant.legacyResourceId` (Shopify's own documented name for this
 * exact value) equals the trailing numeric segment of the variant's GID for
 * the same variant, so it is derived here by parsing the GID already threaded
 * through every caller, with no extra Admin API round trip.
 *
 * BOTH ARE DECIMAL STRINGS, LIKE EVERY OTHER FIELD IN THIS MODULE (ARCHITECT
 * RULING, 2026-09-20) — NOT JSON numbers. An earlier version of this file
 * emitted them as plain numbers on the theory that they exist only to be
 * compared, never computed on, so precision loss could not matter either
 * side. That reasoning was sound on its own terms but unnecessary: the theme
 * already has a safe, established numeric-cast idiom for exactly this
 * comparison — `| plus: 0` — used elsewhere in this theme and covered by its
 * own regression tests, which permit that filter and no other. A string
 * anchor compared through `| plus: 0` needs no server-side numeric-widening
 * call at all, so it needs no money-safety allow-list entry either — the
 * hazard `toSafeJsonInteger` used to guard against (a bigint that cannot
 * round-trip through a JS number) simply does not exist for a string.
 * Consistency with the rest of the payload is also worth something on its
 * own: a reader should not have to remember which two of six fields in one
 * JSON document are the exception.
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
 *
 * `shopifyVariantId`/`cardPriceAnchorMinorUnits` are R14's self-validating
 * pair — see the module doc comment above for what each is. Both are decimal
 * strings, like every other field here. For the variant-level payload,
 * `shopifyVariantId` names that SAME variant (a same-variant consistency
 * check); for the product-level aggregate, it names the WINNING variant the
 * "as low as" figure was derived from — which is exactly the id the theme
 * needs to re-check purchasability against.
 */
export interface PriceBearingMetafieldPayload {
  readonly masterVariantId: string;
  readonly priceCalculationId: string;
  readonly currency: string;
  /** Decimal-string minor units — never a JS number (money-safety, Tier 2). */
  readonly bankPaymentPriceMinorUnits: string;
  /** Liquid-native numeric variant id, as a decimal string — see the module doc comment (R14). Compare via Liquid's `| plus: 0` idiom. */
  readonly shopifyVariantId: string;
  /** Regular/Card Price at write time, in Liquid's own integer-minor-units form, as a decimal string — see the module doc comment (R14). Compare via Liquid's `| plus: 0` idiom. */
  readonly cardPriceAnchorMinorUnits: string;
}

export class MalformedShopifyGidError extends Error {
  constructor(gid: string) {
    super(`Cannot extract a Liquid-native numeric variant id from malformed Shopify gid: "${gid}"`);
    this.name = "MalformedShopifyGidError";
  }
}

/**
 * Extracts the Liquid-native numeric variant id from a Shopify variant GID
 * (`gid://shopify/ProductVariant/123456789` -> `"123456789"`), as a decimal
 * STRING (see the module doc comment for why), with no extra Admin API call.
 * Verified live against caratforus-dev.myshopify.com (Admin API 2026-07),
 * 2026-09-20 — see the module doc comment for the exact check performed.
 */
export function shopifyLegacyIdFromGid(gid: string): string {
  const match = /\/(\d+)$/.exec(gid);
  const digits = match?.[1];
  if (!digits) {
    throw new MalformedShopifyGidError(gid);
  }
  return digits;
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
    // R14 — this variant's own identity and Card-price anchor.
    shopifyVariantId: shopifyLegacyIdFromGid(shopifyVariantGid),
    cardPriceAnchorMinorUnits: published.regularCardPriceMinorUnits.toString(),
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
 *
 * `winningShopifyVariantGid` is REQUIRED (R14) — the aggregate is otherwise
 * unable to name a variant Liquid can re-check for purchasability at all.
 * `winningPrice.masterVariantId` (this app's internal Postgres uuid) shares
 * no namespace with `product.variants` in Liquid; see the module doc
 * comment for why the Shopify-native id is what closes that gap.
 */
export function buildProductAsLowAsMetafield(
  shopifyProductGid: string,
  winningPrice: PublishedVariantPrice,
  winningShopifyVariantGid: string
): PriceMetafieldWriteInput {
  const payload: ProductAsLowAsMetafieldPayload = {
    masterVariantId: winningPrice.masterVariantId,
    priceCalculationId: winningPrice.priceCalculationId,
    currency: winningPrice.currency,
    bankPaymentPriceMinorUnits: winningPrice.bankPaymentPriceMinorUnits.toString(),
    // R14 — the SOURCE (winning) variant's identity and Card-price anchor.
    shopifyVariantId: shopifyLegacyIdFromGid(winningShopifyVariantGid),
    cardPriceAnchorMinorUnits: winningPrice.regularCardPriceMinorUnits.toString(),
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
  if (typeof candidate.shopifyVariantId !== "string" || typeof candidate.cardPriceAnchorMinorUnits !== "string") {
    throw new MalformedPriceMetafieldValueError(
      "missing or non-string shopifyVariantId or cardPriceAnchorMinorUnits (R14)"
    );
  }
  return {
    masterVariantId: candidate.masterVariantId,
    priceCalculationId: candidate.priceCalculationId,
    currency: candidate.currency,
    bankPaymentPriceMinorUnits: candidate.bankPaymentPriceMinorUnits,
    shopifyVariantId: candidate.shopifyVariantId,
    cardPriceAnchorMinorUnits: candidate.cardPriceAnchorMinorUnits,
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
