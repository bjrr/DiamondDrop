/**
 * Resolving which shipping service a Bank Payment order is actually charged
 * for (`docs/SHIPPING-AND-DELIVERY.md`).
 *
 * ============================================================================
 * THE RATES ARE SHOPIFY'S, NOT OURS. THIS FILE CONTAINS NO RATE ARITHMETIC.
 * ============================================================================
 * CaratForUs shipping rules live in ONE place: the Shopify delivery profile
 * (`General profile`, two zones — "Contiguous 48 states" and "Alaska and
 * Hawaii"). Card checkout reads them natively. The Bank Payment path reads
 * the SAME configuration through `draftOrderCalculate`'s
 * `availableShippingRates`, so both payment methods are quoted by one
 * authority and cannot drift apart.
 *
 * That is deliberate and it is the whole design. A second implementation of
 * "$30 below $1,000, $55 express, free at $1,000, carrier-calculated for
 * AK/HI" would be a rate engine duplicating a Shopify-native capability
 * (CLAUDE.md principle 0), and the day the two disagreed, the customer would
 * be shown one number and charged another. So this module does not know what
 * $30 is, does not know the $1,000 threshold exists, and does not know which
 * states are contiguous. It only decides whether the service the customer
 * picked is one Shopify is currently offering for this exact order.
 *
 * The $1,000 threshold is therefore evaluated by Shopify against the
 * **payment-method-specific merchandise total**, because the line prices sent
 * to `draftOrderCalculate` are the Bank Payment prices. A basket that is
 * $1,020 on card and $980 on Bank Payment qualifies on card and does not
 * qualify on Bank Payment — which is the owner's decision of 2026-11-15,
 * expressed as a consequence of the data rather than as a branch.
 *
 * ============================================================================
 * WHY THE CUSTOMER SENDS A TITLE AND NEVER A PRICE OR A HANDLE
 * ============================================================================
 * Shopify identifies a rate by a `handle` that is a signed JWT carrying the
 * title and price. Two ways to use it, and only one is safe:
 *
 *   - Accept the handle from the browser. Shopify verifies the signature, so a
 *     FORGED handle cannot buy cheap shipping. It was tested: mutating the
 *     price claim to "0.0" and keeping the signature makes Shopify fail the
 *     request outright. But "the upstream rejects it" is a weaker guarantee
 *     than "it never gets there", and the observed rejection is an opaque
 *     500 rather than a `userError`, which is a poor thing to build a
 *     customer-facing error path on.
 *   - Accept only a service TITLE, re-calculate the authoritative rates
 *     server-side, and look the handle up from THAT list. The browser then has
 *     no way to express a price at all, and an unrecognised title is a clean
 *     400 we author ourselves.
 *
 * This module implements the second. The price charged always comes from the
 * freshly calculated list, never from the request body — the same discipline
 * `apps.carat.bank-checkout.tsx` already applies to merchandise prices.
 *
 * ============================================================================
 * THERE IS NO FREE-SHIPPING FALLBACK. REFUSAL IS THE ONLY FAILURE MODE.
 * ============================================================================
 * Every unresolvable case returns a refusal, never a zero-priced rate. An
 * order must not be created when shipping could not be resolved — a silent
 * $0.00 is exactly the defect the owner's decision removed, and it is the one
 * mistake here that loses money on every order rather than failing loudly
 * once. `shippingRateSelection.test.ts` pins this, including the case where
 * Shopify offers a genuinely free rate (`$1,000`+ complimentary Express),
 * which must still only be chargeable when the customer actually selected it.
 */

/** One shipping service Shopify is currently offering for a specific draft order. */
export interface AvailableShippingRate {
  /**
   * Shopify's signed rate handle. Passed straight back to Shopify as
   * `shippingLine.shippingRateHandle` so SHOPIFY applies the title and price
   * from its own signed claim — this app never asserts a shipping price.
   */
  readonly handle: string;
  /** Customer-facing service name, e.g. "Standard Insured Shipping with Signature" or "UPS® Ground". */
  readonly title: string;
  readonly priceMinorUnits: bigint;
  readonly currency: string;
}

export type ShippingRateSelection =
  | { readonly kind: "resolved"; readonly rate: AvailableShippingRate }
  /**
   * Shopify offered nothing for this destination and basket. Undeliverable, a
   * delivery-profile gap, or a carrier outage for AK/HI. The caller must
   * refuse the checkout; it must NOT ship for free.
   */
  | { readonly kind: "no_rates_available" }
  /**
   * The requested service is not among the ones currently offered. Usually
   * benign and recoverable: the customer chose Standard at $980, then added an
   * item that took the basket over $1,000, so Standard no longer exists. The
   * caller returns the live list and the customer re-picks.
   */
  | {
      readonly kind: "service_unavailable";
      readonly available: readonly AvailableShippingRate[];
    };

/**
 * Exact, case-sensitive title match against the authoritative list.
 *
 * NOT fuzzy, NOT case-insensitive, NOT a prefix match. The titles include
 * carrier names with registered-trademark glyphs ("UPS® Ground", "UPS 2nd Day
 * Air®") and three CaratForUs names that share a long common prefix:
 *
 *     Standard Insured Shipping with Signature
 *     Express Insured Shipping with Signature
 *     Complimentary Express Insured Shipping with Signature
 *
 * "Express Insured Shipping with Signature" is a SUFFIX of the complimentary
 * one, so a loose match could charge $55 for a service the customer was shown
 * as free, or hand out free shipping to a basket that owes $55. An exact match
 * fails safe instead: the customer re-picks from a list we just generated.
 */
export function resolveShippingRateSelection(input: {
  readonly requestedServiceTitle: string;
  readonly availableRates: readonly AvailableShippingRate[];
}): ShippingRateSelection {
  if (input.availableRates.length === 0) {
    return { kind: "no_rates_available" };
  }

  const match = input.availableRates.find((rate) => rate.title === input.requestedServiceTitle);
  if (!match) {
    return { kind: "service_unavailable", available: input.availableRates };
  }

  return { kind: "resolved", rate: match };
}
